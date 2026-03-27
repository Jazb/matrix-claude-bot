/**
 * IDE Runner — Enhances bot mode with Claude Code's native MCP IDE protocol.
 *
 * Combines the reliability of one-shot `claude -p` subprocesses with the
 * interactivity of the IDE protocol:
 *
 * 1. Starts a persistent WebSocket MCP server (same protocol as VS Code / Emacs)
 * 2. Creates a lockfile so Claude Code discovers and connects to us
 * 3. Each message spawns `claude -p "prompt" --output-format json --ide`
 * 4. The --ide flag makes Claude connect to our MCP server during execution
 * 5. Claude can call tools (openDiff, getDiagnostics) which we forward to Matrix
 * 6. Diff approvals from the user are handled via deferred responses
 *
 * Best of both worlds: one-shot subprocess reliability + IDE interactivity.
 */

import { spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { marked } from "marked";
import type { AppConfig } from "../config/schema.js";
import type { MatrixClientWrapper } from "../matrix/client.js";
import { SessionStore } from "../claude/session.js";
import { McpServer } from "./mcp-server.js";
import { SerialQueue } from "../queue/serial-queue.js";
import { splitMessage, createLogger } from "../utils/index.js";

const log = createLogger("ide");

export class IdeRunner {
  private readonly mcpServers = new Map<string, McpServer>();
  private readonly queue = new SerialQueue();

  constructor(
    private readonly config: AppConfig,
    private readonly matrix: MatrixClientWrapper,
    private readonly sessionStore: SessionStore,
  ) {}

  /**
   * Handle a user message for a room.
   * Ensures MCP server is running, then spawns claude -p with --ide.
   */
  async handleMessage(roomId: string, prompt: string): Promise<string | null> {
    // Ensure MCP server is running for this room
    const mcp = await this.ensureMcpServer(roomId);

    if (this.queue.busy) {
      const pos = this.queue.length + 1;
      await this.matrix.sendNotice(roomId, `Queued (position ${pos}). Waiting...`);
    }

    const result = await this.queue.enqueue(async () => {
      await this.matrix.setTyping(roomId, true);
      try {
        return await this.runClaude(roomId, prompt, mcp);
      } finally {
        await this.matrix.setTyping(roomId, false);
      }
    });

    // Send response
    const chunks = splitMessage(result, this.config.bot.maxMessageLength);
    for (const chunk of chunks) {
      await this.sendFormattedMessage(roomId, chunk);
    }

    return result;
  }

  /** Start a new session for a room. */
  async newSession(roomId: string): Promise<void> {
    this.stopMcpServer(roomId);
    this.sessionStore.clear(roomId);
  }

  /** Cancel current operation. */
  cancel(_roomId: string): boolean {
    return this.queue.cancelCurrent();
  }

  /** Get session status. */
  getStatus(roomId: string): { alive: boolean; connected: boolean } {
    const mcp = this.mcpServers.get(roomId);
    return {
      alive: mcp !== undefined,
      connected: mcp?.connected ?? false,
    };
  }

  /** Clean up all resources. */
  stop(): void {
    for (const roomId of [...this.mcpServers.keys()]) {
      this.stopMcpServer(roomId);
    }
    this.queue.cancelCurrent();
    log.info("IDE runner stopped");
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private async ensureMcpServer(roomId: string): Promise<McpServer> {
    const existing = this.mcpServers.get(roomId);
    if (existing) return existing;

    const stored = this.sessionStore.get(roomId);
    const project = stored?.project ?? this.config.projects.defaultProject;
    const cwd = this.config.projects.projects[project];

    if (!cwd) {
      throw new Error(`Unknown project "${project}"`);
    }

    const mcp = new McpServer([cwd], `${project}-${roomId.slice(1, 10)}`);
    mcp.start();

    // Set up tool call handler
    mcp.on("tool_call", (requestId: number, toolName: string, args: Record<string, unknown>) => {
      this.handleToolCall(roomId, mcp, requestId, toolName, args).catch((err) => {
        log.error(`Tool call error: ${err instanceof Error ? err.message : String(err)}`);
        mcp.sendToolError(requestId, `Error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    mcp.on("connected", () => {
      log.info(`Claude Code connected to MCP for room ${roomId}`);
    });

    mcp.on("disconnected", () => {
      log.info(`Claude Code disconnected from MCP for room ${roomId}`);
    });

    this.mcpServers.set(roomId, mcp);
    log.info(`MCP server started for room ${roomId} (port ${mcp.port}, project: ${project})`);

    return mcp;
  }

  /** Run a one-shot Claude subprocess with --ide flag. */
  private runClaude(roomId: string, prompt: string, _mcp: McpServer): Promise<string> {
    const stored = this.sessionStore.get(roomId);
    const project = stored?.project ?? this.config.projects.defaultProject;
    const cwd = this.config.projects.projects[project];

    const env: Record<string, string> = {
      HOME: process.env["HOME"] ?? "/root",
      PATH: process.env["PATH"] ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      TERM: "dumb",
      USER: process.env["USER"] ?? "root",
      LANG: "en_US.UTF-8",
    };

    // Forward auth tokens
    const oauthToken = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    if (oauthToken) env["CLAUDE_CODE_OAUTH_TOKEN"] = oauthToken;
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (apiKey) env["ANTHROPIC_API_KEY"] = apiKey;

    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--max-turns", String(this.config.claude.maxTurns),
      "--ide",
      ...this.config.bridge.claudeArgs,
    ];

    // Add --resume if session exists
    if (stored?.sessionId) {
      args.push("--resume", stored.sessionId);
    }

    log.info(`Running Claude with --ide (project: ${project})`);

    return new Promise((resolve, reject) => {
      const child = spawn(this.config.claude.binaryPath, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.queue.setChildProcess(child);

      let stdout = "";
      let stderr = "";

      child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Claude timed out."));
      }, this.config.claude.timeout);

      child.on("close", (code) => {
        clearTimeout(timeout);

        if (code !== 0 && !stdout) {
          reject(new Error(stderr.slice(0, 500) || `Claude exited with code ${code}`));
          return;
        }

        try {
          const parsed = this.parseClaudeOutput(stdout, roomId);
          resolve(parsed);
        } catch {
          resolve(stdout?.slice(0, 4000) || "Claude returned no response.");
        }
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /** Parse Claude's JSON output and extract text + session_id. */
  private parseClaudeOutput(raw: string, roomId: string): string {
    const lines = raw.trim().split("\n").filter(Boolean);
    let text = "";

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.session_id) {
          const stored = this.sessionStore.get(roomId);
          const project = stored?.project ?? this.config.projects.defaultProject;
          this.sessionStore.set(roomId, { sessionId: obj.session_id, project });
        }
        if (obj.result) {
          text = this.extractText(obj.result);
        }
      } catch {
        // Not JSON
      }
    }

    if (!text) {
      try {
        const obj = JSON.parse(raw);
        if (obj.result) text = this.extractText(obj.result);
        if (obj.session_id) {
          const stored = this.sessionStore.get(roomId);
          const project = stored?.project ?? this.config.projects.defaultProject;
          this.sessionStore.set(roomId, { sessionId: obj.session_id, project });
        }
      } catch {
        text = raw.slice(0, 4000);
      }
    }

    return text || "No response.";
  }

  /** Handle a tool call from Claude Code via MCP. */
  private async handleToolCall(
    roomId: string,
    mcp: McpServer,
    requestId: number,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    log.info(`Tool call from Claude: ${toolName}`);

    switch (toolName) {
      case "openFile": {
        const uri = (args.uri as string) ?? "";
        const filePath = uri.startsWith("file://") ? uri.slice(7) : uri;
        try {
          // We don't open files in an editor, but we can confirm it exists
          if (existsSync(filePath)) {
            mcp.sendToolResponse(requestId, [{ type: "text", text: `Opened ${filePath}` }]);
          } else {
            mcp.sendToolError(requestId, `File not found: ${filePath}`);
          }
        } catch (err) {
          mcp.sendToolError(requestId, `Error opening file: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }

      case "saveDocument": {
        const uri = (args.uri as string) ?? "";
        mcp.sendToolResponse(requestId, [{ type: "text", text: `Saved ${uri}` }]);
        break;
      }

      case "getDiagnostics": {
        // No IDE diagnostics available — return empty
        mcp.sendToolResponse(requestId, [{ type: "text", text: "[]" }]);
        break;
      }

      case "openDiff": {
        // This is the key interactive feature: forward diff to Matrix for approval
        const oldPath = args.old_file_path as string;
        const newContents = args.new_file_contents as string;
        const tabName = (args.tab_name as string) ?? `diff-${Date.now()}`;

        // Store deferred response
        mcp.storeDeferredResponse(tabName, requestId);

        // Format diff for Matrix
        let diffText = `**Diff: \`${oldPath}\`**\n\n`;

        // Try to show actual diff
        try {
          const oldContents = existsSync(oldPath) ? readFileSync(oldPath, "utf-8") : "";
          const oldLines = oldContents.split("\n");
          const newLines = newContents.split("\n");

          // Simple line-by-line diff summary
          const added = newLines.length - oldLines.length;
          diffText += `Lines: ${oldLines.length} → ${newLines.length} (${added >= 0 ? "+" : ""}${added})\n\n`;
          diffText += "```\n" + newContents.slice(0, 3000) + "\n```\n\n";
        } catch {
          diffText += "```\n" + newContents.slice(0, 3000) + "\n```\n\n";
        }

        diffText += `_Reply **y** to apply or **n** to reject this change._`;

        // Store context for when user responds
        this.pendingDiffs.set(roomId, { tabName, mcp, newContents, oldPath });

        await this.sendFormattedMessage(roomId, diffText);
        await this.matrix.setTyping(roomId, false);
        break;
      }

      default:
        log.warn(`Unhandled tool call: ${toolName}`);
        mcp.sendToolError(requestId, `Tool not implemented: ${toolName}`);
    }
  }

  // ─── Diff approval tracking ────────────────────────────────────────────────

  private readonly pendingDiffs = new Map<string, {
    tabName: string;
    mcp: McpServer;
    newContents: string;
    oldPath: string;
  }>();

  /**
   * Check if a user message is a diff approval/rejection.
   * Returns true if handled (caller should not forward to Claude).
   */
  handleDiffResponse(roomId: string, text: string): boolean {
    const pending = this.pendingDiffs.get(roomId);
    if (!pending) return false;

    const lower = text.trim().toLowerCase();
    if (lower === "y" || lower === "yes" || lower === "allow") {
      // Approve diff — write file and complete deferred response
      try {
        writeFileSync(pending.oldPath, pending.newContents);
      } catch (err) {
        log.error(`Failed to write diff: ${err instanceof Error ? err.message : String(err)}`);
      }
      pending.mcp.completeDeferredResponse(pending.tabName, [
        { type: "text", text: "FILE_SAVED" },
        { type: "text", text: pending.newContents },
      ]);
      this.pendingDiffs.delete(roomId);
      this.matrix.sendNotice(roomId, "Changes applied.").catch(() => {});
      return true;

    } else if (lower === "n" || lower === "no" || lower === "deny" || lower === "reject") {
      // Reject diff
      pending.mcp.completeDeferredResponse(pending.tabName, [
        { type: "text", text: "DIFF_REJECTED" },
        { type: "text", text: pending.tabName },
      ]);
      this.pendingDiffs.delete(roomId);
      this.matrix.sendNotice(roomId, "Changes rejected.").catch(() => {});
      return true;
    }

    return false;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private extractText(result: unknown): string {
    if (typeof result === "string") return result;
    if (Array.isArray(result)) {
      return result
        .filter((block: { type: string; text?: string }) => block.type === "text")
        .map((block: { text: string }) => block.text)
        .join("\n");
    }
    return JSON.stringify(result).slice(0, 4000);
  }

  private async sendFormattedMessage(roomId: string, text: string): Promise<void> {
    const chunks = splitMessage(text, this.config.bot.maxMessageLength);
    for (const chunk of chunks) {
      const html = await marked.parse(chunk);
      await this.matrix.client.sendMessage(roomId, {
        msgtype: "m.text",
        body: chunk,
        format: "org.matrix.custom.html",
        formatted_body: html,
      });
    }
  }

  private stopMcpServer(roomId: string): void {
    const mcp = this.mcpServers.get(roomId);
    if (!mcp) return;

    mcp.stop();
    this.mcpServers.delete(roomId);
    this.pendingDiffs.delete(roomId);
  }
}
