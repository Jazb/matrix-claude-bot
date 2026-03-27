/**
 * MCP Server — WebSocket server implementing Claude Code's IDE integration protocol.
 *
 * Implements the MCP (Model Context Protocol) version 2024-11-05 that Claude Code
 * uses to communicate with IDEs like VS Code, JetBrains, and Emacs (via monet.el).
 *
 * The server:
 * 1. Starts a WebSocket server on a random local port
 * 2. Creates a lockfile at ~/.claude/ide/{PORT}.lock for Claude Code to discover
 * 3. Handles JSON-RPC 2.0 requests from Claude Code (tools/list, tools/call, etc.)
 * 4. Emits events for the IDE runner to forward to Matrix
 *
 * Protocol reference: monet.el (Emacs MCP integration)
 */

import { WebSocketServer, WebSocket } from "ws";
import { EventEmitter } from "events";
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { createLogger } from "../utils/logger.js";

const log = createLogger("mcp");

const PROTOCOL_VERSION = "2024-11-05";
const KEEPALIVE_INTERVAL = 30_000;
const IDE_NAME = "MatrixClaudeBot";

// ─── Types ───────────────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Events emitted by the MCP server to the IDE runner. */
export interface McpServerEvents {
  /** Claude Code has connected and is ready. */
  connected: () => void;
  /** Claude Code disconnected. */
  disconnected: () => void;
  /** Claude is calling a tool. */
  tool_call: (requestId: number, toolName: string, args: Record<string, unknown>) => void;
}

export class McpServer extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private lockfilePath: string | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private deferredResponses = new Map<string, number>(); // uniqueKey → requestId
  readonly authToken: string;
  readonly port: number;

  constructor(
    private readonly workspaceFolders: string[],
    private readonly sessionName: string,
  ) {
    super();
    this.authToken = randomUUID();
    this.port = this.findFreePort();
  }

  /** Start the WebSocket server and create the lockfile. */
  start(): void {
    this.wss = new WebSocketServer({ port: this.port, host: "127.0.0.1" });

    this.wss.on("connection", (ws) => {
      log.info("Claude Code connected via WebSocket");
      this.client = ws;

      ws.on("message", (data) => {
        this.handleMessage(ws, data.toString());
      });

      ws.on("close", () => {
        log.info("Claude Code disconnected");
        this.client = null;
        this.stopPingTimer();
        this.emit("disconnected");
      });

      ws.on("error", (err) => {
        log.error(`WebSocket error: ${err.message}`);
      });
    });

    this.wss.on("listening", () => {
      log.info(`MCP server listening on ws://127.0.0.1:${this.port}`);
      this.writeLockfile();
    });

    this.wss.on("error", (err) => {
      log.error(`WebSocket server error: ${err.message}`);
    });
  }

  /** Stop the server, clean up lockfile, and close connections. */
  stop(): void {
    this.stopPingTimer();

    if (this.client) {
      this.client.close();
      this.client = null;
    }

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    this.removeLockfile();
    log.info("MCP server stopped");
  }

  /** Check if Claude Code is connected. */
  get connected(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN;
  }

  // ─── Response methods (called by IDE runner) ───────────────────────────────

  /** Send a tool response back to Claude Code. */
  sendToolResponse(requestId: number, content: Array<{ type: string; text: string }>): void {
    this.sendResponseToClient(requestId, { content });
  }

  /** Send a tool error response. */
  sendToolError(requestId: number, message: string): void {
    this.sendErrorToClient(requestId, -32603, message);
  }

  /** Complete a deferred tool response (e.g., after user approves a diff). */
  completeDeferredResponse(uniqueKey: string, content: Array<{ type: string; text: string }>): void {
    const requestId = this.deferredResponses.get(uniqueKey);
    if (requestId === undefined) {
      log.warn(`No deferred response found for key: ${uniqueKey}`);
      return;
    }
    this.deferredResponses.delete(uniqueKey);
    this.sendToolResponse(requestId, content);
  }

  /** Store a deferred response mapping. */
  storeDeferredResponse(uniqueKey: string, requestId: number): void {
    this.deferredResponses.set(uniqueKey, requestId);
  }

  /** Send a notification to Claude Code. */
  sendNotification(method: string, params?: Record<string, unknown>): void {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) return;

    const msg = {
      jsonrpc: "2.0",
      method,
      params: params ?? {},
    };
    this.client.send(JSON.stringify(msg));
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private handleMessage(ws: WebSocket, raw: string): void {
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      log.debug("Failed to parse JSON-RPC message");
      return;
    }

    const { id, method, params } = message;
    log.debug(`← ${method}${id !== undefined ? ` (id=${id})` : ""}`);

    switch (method) {
      case "initialize":
        this.handleInitialize(ws, id!);
        break;

      case "notifications/initialized":
        // Client confirmed initialization — no response needed
        break;

      case "ide_connected":
        this.handleIdeConnected();
        break;

      case "tools/list":
        this.handleToolsList(ws, id!);
        break;

      case "tools/call":
        this.handleToolsCall(ws, id!, params as { name: string; arguments: Record<string, unknown> });
        break;

      case "prompts/list":
        this.sendResponseTo(ws, id!, { prompts: [] });
        break;

      case "resources/list":
        this.handleResourcesList(ws, id!);
        break;

      case "resources/read":
        this.handleResourcesRead(ws, id!, params as { uri: string });
        break;

      default:
        if (id !== undefined) {
          this.sendErrorTo(ws, id, -32601, `Method not found: ${method}`);
        }
    }
  }

  private handleInitialize(ws: WebSocket, id: number): void {
    this.sendResponseTo(ws, id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: true },
        prompts: { listChanged: true },
        resources: { subscribe: false, listChanged: false },
      },
      serverInfo: {
        name: IDE_NAME,
        version: "1.0.0",
      },
    });

    // Immediately notify that tools list is available
    this.sendNotification("notifications/tools/list_changed");
  }

  private handleIdeConnected(): void {
    this.startPingTimer();
    this.emit("connected");
  }

  private handleToolsList(ws: WebSocket, id: number): void {
    this.sendResponseTo(ws, id, { tools: this.getToolDefinitions() });
  }

  private handleToolsCall(_ws: WebSocket, id: number, params: { name: string; arguments: Record<string, unknown> }): void {
    const { name, arguments: args } = params;
    log.debug(`Tool call: ${name}`);

    // Handle simple tools locally
    switch (name) {
      case "getWorkspaceFolders":
        this.sendToolResponse(id, [
          { type: "text", text: JSON.stringify(this.workspaceFolders.map((f) => ({ uri: `file://${f}`, name: f.split("/").pop() }))) },
        ]);
        return;

      case "getOpenEditors":
        this.sendToolResponse(id, [{ type: "text", text: "[]" }]);
        return;

      case "getCurrentSelection":
      case "getLatestSelection":
        this.sendToolResponse(id, [{ type: "text", text: JSON.stringify({ text: "", filePath: "", fileUrl: "", selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, isEmpty: true } }) }]);
        return;

      case "checkDocumentDirty":
        this.sendToolResponse(id, [{ type: "text", text: "false" }]);
        return;

      case "closeAllDiffTabs":
        this.sendToolResponse(id, [{ type: "text", text: "OK" }]);
        return;

      case "close_tab":
        this.sendToolResponse(id, [{ type: "text", text: "OK" }]);
        return;
    }

    // Forward complex tools to IDE runner for Matrix interaction
    this.emit("tool_call", id, name, args ?? {});
  }

  private handleResourcesList(ws: WebSocket, id: number): void {
    this.sendResponseTo(ws, id, { resources: [] });
  }

  private handleResourcesRead(ws: WebSocket, id: number, params: { uri: string }): void {
    const uri = params?.uri;
    if (!uri) {
      this.sendErrorTo(ws, id, -32602, "Missing uri parameter");
      return;
    }

    const filePath = uri.startsWith("file://") ? uri.slice(7) : uri;

    try {
      const content = readFileSync(filePath, "utf-8");
      this.sendResponseTo(ws, id, {
        contents: [{ uri, text: content, mimeType: "text/plain" }],
      });
    } catch {
      this.sendErrorTo(ws, id, -32602, `Resource not found: ${uri}`);
    }
  }

  private getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: "getCurrentSelection",
        description: "Get the current text selection or cursor position in the active editor",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "getLatestSelection",
        description: "Get the latest text selection from any file",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "openFile",
        description: "Open a file in the editor",
        inputSchema: {
          type: "object",
          properties: { uri: { type: "string", description: "The file URI or path to open" } },
          required: ["uri"],
        },
      },
      {
        name: "saveDocument",
        description: "Save a document to disk",
        inputSchema: {
          type: "object",
          properties: { uri: { type: "string", description: "The file URI or path to save" } },
          required: ["uri"],
        },
      },
      {
        name: "checkDocumentDirty",
        description: "Check if a document has unsaved changes",
        inputSchema: {
          type: "object",
          properties: { uri: { type: "string", description: "The file URI or path to check" } },
          required: ["uri"],
        },
      },
      {
        name: "getOpenEditors",
        description: "Get the list of currently open files in the editor",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "getWorkspaceFolders",
        description: "Get the list of workspace folders (project directories)",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "getDiagnostics",
        description: "Get diagnostics for a file",
        inputSchema: {
          type: "object",
          properties: { uri: { type: "string" } },
        },
      },
      {
        name: "openDiff",
        description: "Open a diff view for reviewing changes",
        inputSchema: {
          type: "object",
          properties: {
            old_file_path: { type: "string" },
            new_file_path: { type: "string" },
            new_file_contents: { type: "string" },
            tab_name: { type: "string" },
          },
          required: ["old_file_path", "new_file_path", "new_file_contents"],
        },
      },
      {
        name: "closeAllDiffTabs",
        description: "Close all diff tabs",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "close_tab",
        description: "Close a tab",
        inputSchema: {
          type: "object",
          properties: { tab_name: { type: "string" } },
          required: ["tab_name"],
        },
      },
    ];
  }

  // ─── JSON-RPC helpers ──────────────────────────────────────────────────────

  /** Send a JSON-RPC response to a specific WebSocket. */
  private sendResponseTo(ws: WebSocket, id: number, result: Record<string, unknown>): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
    log.debug(`→ response (id=${id})`);
  }

  /** Send a JSON-RPC response to the current client. */
  private sendResponseToClient(id: number, result: Record<string, unknown>): void {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) return;
    this.sendResponseTo(this.client, id, result);
  }

  /** Send a JSON-RPC error to a specific WebSocket. */
  private sendErrorTo(ws: WebSocket, id: number, code: number, message: string): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
    log.debug(`→ error (id=${id}): ${message}`);
  }

  /** Send a JSON-RPC error to the current client. */
  private sendErrorToClient(id: number, code: number, message: string): void {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) return;
    this.sendErrorTo(this.client, id, code, message);
  }

  // ─── Lockfile ──────────────────────────────────────────────────────────────

  private writeLockfile(): void {
    const dir = join(homedir(), ".claude", "ide");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.lockfilePath = join(dir, `${this.port}.lock`);
    const content = JSON.stringify({
      pid: process.pid,
      workspaceFolders: this.workspaceFolders,
      ideName: `${IDE_NAME} (${this.sessionName})`,
      transport: "ws",
      authToken: this.authToken,
    });

    writeFileSync(this.lockfilePath, content);
    log.info(`Lockfile written: ${this.lockfilePath}`);
  }

  private removeLockfile(): void {
    if (this.lockfilePath && existsSync(this.lockfilePath)) {
      try {
        unlinkSync(this.lockfilePath);
        log.debug("Lockfile removed");
      } catch {
        // Ignore
      }
    }
  }

  // ─── Ping ──────────────────────────────────────────────────────────────────

  private startPingTimer(): void {
    this.stopPingTimer();
    this.pingTimer = setInterval(() => {
      this.sendNotification("notifications/tools/list_changed");
    }, KEEPALIVE_INTERVAL);
  }

  private stopPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ─── Port selection ────────────────────────────────────────────────────────

  private findFreePort(): number {
    // Use a random port in the range 10000-65535
    return 10000 + Math.floor(Math.random() * 55535);
  }
}
