/**
 * Bridge Runner — Orchestrates Claude Code in interactive tmux mode.
 *
 * Instead of spawning one-shot `claude -p` subprocesses (bot mode), bridge mode
 * runs Claude Code interactively inside tmux sessions. Communication happens via:
 *
 * - **Hooks → IPC socket → Matrix**: Claude emits hook events (SessionStart,
 *   PreToolUse, Stop, Notification) which are forwarded to the bridge via a
 *   Unix socket. The bridge sends notifications/responses to Matrix.
 *
 * - **Matrix → tmux send-keys → Claude**: User messages from Matrix are injected
 *   into the tmux session as keyboard input.
 *
 * This enables:
 * - Streaming awareness (responses arrive via Stop hooks)
 * - Permission prompts forwarded to Matrix (user approves/denies from phone)
 * - Full interactive Claude experience without a terminal
 *
 * Inspired by Jackpoint's architecture.
 */

import { randomUUID } from "crypto";
import { marked } from "marked";
import type { AppConfig } from "../config/schema.js";
import type { MatrixClientWrapper } from "../matrix/client.js";
import { SessionStore } from "../claude/session.js";
import { IPCServer, type HookPayload } from "./ipc-server.js";
import { TmuxManager } from "./tmux-manager.js";
import { generateHooksSettings } from "./hook-injector.js";
import { readLastAssistantMessage } from "./transcript-reader.js";
import { splitMessage, createLogger } from "../utils/index.js";

const log = createLogger("bridge");

export class BridgeRunner {
  private readonly ipc: IPCServer;
  private readonly tmux: TmuxManager;
  private readonly settingsJson: string;
  private readonly cwdToRoom = new Map<string, string>();

  constructor(
    private readonly config: AppConfig,
    private readonly matrix: MatrixClientWrapper,
    private readonly sessions: SessionStore,
  ) {
    // Create IPC server with a unique ID
    const bridgeId = randomUUID().slice(0, 8);
    this.ipc = new IPCServer(config.bridge.socketDir, bridgeId);
    const socketPath = this.ipc.start();

    // Generate hook settings JSON pointing to our socket
    this.settingsJson = generateHooksSettings(socketPath, config.bridge.hookTimeout);

    // Create tmux manager
    this.tmux = new TmuxManager();

    // Listen for hook events
    this.ipc.on("hook", (payload: HookPayload) => {
      this.handleHookEvent(payload).catch((err) => {
        log.error(`Hook handler error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    log.info(`Bridge runner initialized (socket: ${socketPath})`);
  }

  /**
   * Handle a user message for a room.
   * Ensures a tmux session exists, then injects the text as input.
   * Returns null because responses arrive asynchronously via hooks.
   */
  async handleMessage(roomId: string, prompt: string): Promise<null> {
    // Ensure tmux session exists for this room
    const isNew = !this.tmux.isAlive(roomId);
    if (isNew) {
      await this.ensureSession(roomId);
      // Wait for Claude Code to finish loading before sending input
      await this.waitForReady(roomId);
    }

    // Inject the user's message into tmux
    const sent = this.tmux.sendInput(roomId, prompt);
    if (!sent) {
      await this.matrix.sendNotice(roomId, "Failed to send input to Claude session. Try !new to restart.");
    }

    // Set typing indicator (Claude is working)
    await this.matrix.setTyping(roomId, true);

    return null;
  }

  /** Start a new session for a room (kills existing if any). */
  async newSession(roomId: string): Promise<void> {
    this.tmux.killSession(roomId);
    this.sessions.clear(roomId);

    // Clean up cwd→room mapping
    for (const [cwd, rid] of this.cwdToRoom) {
      if (rid === roomId) this.cwdToRoom.delete(cwd);
    }
  }

  /** Cancel the current operation (send Ctrl-C). */
  cancel(roomId: string): boolean {
    return this.tmux.sendInterrupt(roomId);
  }

  /** Get tmux status for a room. */
  getStatus(roomId: string, lineCount: number = 10): { alive: boolean; lines: string | null } {
    const alive = this.tmux.isAlive(roomId);
    const lines = alive ? this.tmux.captureLines(roomId, lineCount) : null;
    return { alive, lines };
  }

  /** Clean up all resources. */
  stop(): void {
    this.tmux.killAll();
    this.ipc.stop();
    log.info("Bridge runner stopped");
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Wait for Claude Code to be ready after starting a new tmux session.
   * Polls the tmux pane output looking for the input prompt indicator.
   */
  private waitForReady(roomId: string, timeoutMs: number = 30000): Promise<void> {
    return new Promise((resolve) => {
      const start = Date.now();
      const interval = setInterval(() => {
        const lines = this.tmux.captureLines(roomId, 5);
        // Claude Code shows ">" or "❯" when ready for input
        if (lines && /[>❯]\s*$/.test(lines)) {
          clearInterval(interval);
          log.info(`Claude session ready for room ${roomId}`);
          resolve();
          return;
        }
        if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          log.warn(`Timed out waiting for Claude to be ready in room ${roomId}, sending anyway`);
          resolve();
        }
      }, 500);
    });
  }

  /** Ensure a tmux session exists for a room, creating one if needed. */
  private async ensureSession(roomId: string): Promise<void> {
    const session = this.sessions.get(roomId);
    const project = session?.project ?? this.config.projects.defaultProject;
    const cwd = this.config.projects.projects[project];

    if (!cwd) {
      throw new Error(`Unknown project "${project}"`);
    }

    // Track cwd→room mapping for hook event routing
    this.cwdToRoom.set(cwd, roomId);

    this.tmux.startSession(
      roomId,
      project,
      cwd,
      this.config.claude.binaryPath,
      this.config.bridge.claudeArgs,
      this.settingsJson,
    );

    await this.matrix.sendNotice(roomId, `Claude session started (project: ${project})`);
  }

  /** Route and handle a hook event from Claude Code. */
  private async handleHookEvent(payload: HookPayload): Promise<void> {
    const roomId = this.resolveRoom(payload);
    if (!roomId) {
      log.debug(`Could not resolve room for hook event: ${payload.hook_event_name} (cwd: ${payload.cwd})`);
      return;
    }

    log.debug(`Hook event: ${payload.hook_event_name} → room ${roomId}`);

    switch (payload.hook_event_name) {
      case "SessionStart":
        await this.handleSessionStart(roomId, payload);
        break;

      case "PreToolUse":
        await this.handlePreToolUse(roomId, payload);
        break;

      case "Stop":
        await this.handleStop(roomId, payload);
        break;

      case "Notification":
        await this.handleNotification(roomId, payload);
        break;
    }
  }

  private async handleSessionStart(roomId: string, payload: HookPayload): Promise<void> {
    if (payload.session_id) {
      const session = this.sessions.get(roomId);
      const project = session?.project ?? this.config.projects.defaultProject;
      this.sessions.set(roomId, { sessionId: payload.session_id, project });
    }
    await this.matrix.setTyping(roomId, true);
  }

  private async handlePreToolUse(roomId: string, payload: HookPayload): Promise<void> {
    if (payload.tool_name === "AskUserQuestion") {
      const questions = payload.tool_input?.questions;
      let text = "**Claude is asking:**\n";
      if (Array.isArray(questions)) {
        for (const q of questions) {
          text += `\n- ${String(q)}`;
        }
      } else if (typeof questions === "string") {
        text += `\n${questions}`;
      }

      const html = await marked.parse(text);
      await this.matrix.client.sendMessage(roomId, {
        msgtype: "m.text",
        body: text,
        format: "org.matrix.custom.html",
        formatted_body: html,
      });
      await this.matrix.setTyping(roomId, false);
    }
  }

  private async handleStop(roomId: string, payload: HookPayload): Promise<void> {
    await this.matrix.setTyping(roomId, false);

    let message = "Waiting for your input.";

    if (payload.transcript_path) {
      const lastMsg = readLastAssistantMessage(payload.transcript_path);
      if (lastMsg) message = lastMsg;
    }

    // Split and send as formatted markdown
    const chunks = splitMessage(message, this.config.bot.maxMessageLength);
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

  private async handleNotification(roomId: string, payload: HookPayload): Promise<void> {
    if (payload.notification_type === "idle_prompt") {
      // Claude is idle, waiting for input
      await this.matrix.setTyping(roomId, false);
      const msg = payload.message || "Claude is idle, waiting for input.";
      await this.matrix.sendNotice(roomId, msg);

    } else if (payload.notification_type === "permission_prompt") {
      // Permission dialog — format nicely for Matrix
      await this.matrix.setTyping(roomId, false);

      let text = `**Permission Required**`;
      if (payload.tool_name) {
        text += `: \`${payload.tool_name}\`\n`;
      }

      const toolInput = payload.tool_input;
      if (toolInput) {
        if (payload.tool_name === "Bash" && toolInput.command) {
          text += `\n\`\`\`bash\n${String(toolInput.command)}\n\`\`\``;
        } else if ((payload.tool_name === "Edit" || payload.tool_name === "Write") && toolInput.file_path) {
          text += `\nFile: \`${String(toolInput.file_path)}\``;
        } else if (payload.tool_name === "Read" && toolInput.file_path) {
          text += `\nFile: \`${String(toolInput.file_path)}\``;
        } else {
          text += `\n\`\`\`json\n${JSON.stringify(toolInput, null, 2)}\n\`\`\``;
        }
      }

      if (payload.message) {
        text += `\n\n${payload.message}`;
      }

      text += `\n\n_Reply "y" to allow or "n" to deny._`;

      const html = await marked.parse(text);
      await this.matrix.client.sendMessage(roomId, {
        msgtype: "m.text",
        body: text,
        format: "org.matrix.custom.html",
        formatted_body: html,
      });
    }
  }

  /** Resolve which Matrix room a hook event belongs to, using cwd. */
  private resolveRoom(payload: HookPayload): string | undefined {
    // First try cwd→room mapping
    if (payload.cwd) {
      const roomId = this.cwdToRoom.get(payload.cwd);
      if (roomId) return roomId;

      // Try matching by tmux manager's cwd tracking
      const tmuxRoom = this.tmux.findRoomByCwd(payload.cwd);
      if (tmuxRoom) return tmuxRoom;
    }

    // Fallback: if only one room exists, use it
    if (this.cwdToRoom.size === 1) {
      return [...this.cwdToRoom.values()][0];
    }

    return undefined;
  }
}
