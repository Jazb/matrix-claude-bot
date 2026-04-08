/**
 * Bridge Runner — Orchestrates Claude Code in interactive tmux mode.
 *
 * Each Matrix room gets its own tmux session ("claude-{roomId}"). Claude Code
 * runs interactively inside the session. Communication happens via:
 *
 * - **Hooks -> IPC socket -> Matrix**: Claude emits hook events (SessionStart,
 *   PreToolUse, Stop, Notification) which are forwarded to the bridge via a
 *   Unix socket. The bridge sends notifications/responses to Matrix.
 *
 * - **Matrix -> tmux -> Claude**: User messages from Matrix are injected
 *   into the correct room's tmux session.
 */

import { randomUUID } from "crypto";
import { marked } from "marked";
import type { AppConfig } from "../config/schema.js";
import type { MatrixClientWrapper } from "../matrix/client.js";
import { SessionStore } from "../claude/session.js";
import { buildPermissionArgs, resolvePermission } from "../claude/permission-args.js";
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
  /** Maps cwd -> roomId for hook event routing. */
  private readonly cwdToRoom = new Map<string, string>();
  /** Stores the last PreToolUse payload per room so Notification hooks can include tool details. */
  private readonly pendingToolUse = new Map<string, HookPayload>();

  constructor(
    private readonly config: AppConfig,
    private readonly matrix: MatrixClientWrapper,
    private readonly sessions: SessionStore,
  ) {
    const bridgeId = randomUUID().slice(0, 8);
    this.ipc = new IPCServer(config.bridge.socketDir, bridgeId);
    const socketPath = this.ipc.start();

    this.settingsJson = generateHooksSettings(socketPath, config.bridge.hookTimeout);
    this.tmux = new TmuxManager();

    this.ipc.on("hook", (payload: HookPayload) => {
      this.handleHookEvent(payload).catch((err) => {
        log.error(`Hook handler error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    log.info(`Bridge runner initialized (socket: ${socketPath})`);
  }

  /**
   * Pre-start Claude tmux sessions for all known rooms.
   */
  async warmupAll(): Promise<void> {
    // warmupAll is called before rooms are registered, so nothing to do here.
    // Sessions are created lazily on first message or via warmup().
  }

  /**
   * Pre-start a Claude tmux session for a specific room.
   */
  async warmup(roomId: string): Promise<void> {
    if (this.tmux.isAlive(roomId)) return;
    log.info(`Warming up Claude session for room ${roomId}`);
    await this.ensureSession(roomId);
    await this.waitForReady(roomId);
    log.info(`Warmup complete for room ${roomId}`);
  }

  /**
   * Register a room's project mapping for hook routing.
   * Called at startup for all joined rooms — also warms up the session.
   */
  async registerRoom(roomId: string): Promise<void> {
    const session = this.sessions.get(roomId);
    const project = session?.project ?? this.config.projects.defaultProject;
    const entry = this.config.projects.projects[project];
    if (entry) {
      this.cwdToRoom.set(entry.path, roomId);
    }
    // Warm up the session so it's ready when the user sends a message
    await this.warmup(roomId);
  }

  /**
   * Handle a user message for a room.
   * Ensures a tmux session exists, then injects the text as input.
   */
  async handleMessage(roomId: string, prompt: string): Promise<null> {
    const isNew = !this.tmux.isAlive(roomId);
    if (isNew) {
      await this.ensureSession(roomId);
      await this.waitForReady(roomId);
    }

    const sent = this.tmux.sendInput(roomId, prompt);
    if (!sent) {
      await this.matrix.sendNotice(roomId, "Failed to send input to Claude session. Try !new to restart.");
    }

    await this.matrix.setTyping(roomId, true);
    return null;
  }

  /** Start a new session for a room (kills existing if any). */
  async newSession(roomId: string): Promise<void> {
    this.tmux.killSession(roomId);
    this.sessions.clear(roomId);

    // Clean up cwd→room mapping for this room
    for (const [cwd, rid] of this.cwdToRoom) {
      if (rid === roomId) this.cwdToRoom.delete(cwd);
    }
  }

  /**
   * Switch a room to a different project. Kills the current session
   * and starts a new one in the new project's directory.
   */
  async switchProject(roomId: string, project: string): Promise<void> {
    const entry = this.config.projects.projects[project];
    if (!entry) throw new Error(`Unknown project "${project}"`);

    // Kill old session and update mapping
    this.tmux.killSession(roomId);
    this.sessions.set(roomId, { project, sessionId: null });

    // Clean up old cwd mapping, set new one
    for (const [cwd, rid] of this.cwdToRoom) {
      if (rid === roomId) this.cwdToRoom.delete(cwd);
    }
    this.cwdToRoom.set(entry.path, roomId);

    // Start new session in the new project
    await this.ensureSession(roomId);
    await this.waitForReady(roomId);

    await this.matrix.sendNotice(
      roomId,
      `Switched to project: ${project}\nDirectory: ${entry.path}`,
    );
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

  /** Ensure a tmux session exists for a room, creating one if needed. */
  private async ensureSession(roomId: string): Promise<void> {
    const session = this.sessions.get(roomId);
    const project = session?.project ?? this.config.projects.defaultProject;
    const entry = this.config.projects.projects[project];

    if (!entry) {
      throw new Error(`Unknown project "${project}"`);
    }

    // Track cwd→room mapping for hook event routing
    this.cwdToRoom.set(entry.path, roomId);

    const perm = resolvePermission(this.config.projects, project, session?.permissionOverride);
    const permArgs = buildPermissionArgs(perm);

    this.tmux.startSession(
      roomId,
      project,
      entry.path,
      this.config.claude.binaryPath,
      [...permArgs, ...this.config.bridge.claudeArgs],
      this.settingsJson,
    );
  }

  /**
   * Wait for Claude Code to be ready after starting a new tmux session.
   * Polls the tmux pane output looking for the input prompt indicator.
   */
  private waitForReady(roomId: string, timeoutMs: number = 30000): Promise<void> {
    return new Promise((resolve) => {
      const start = Date.now();
      const interval = setInterval(() => {
        const lines = this.tmux.captureLines(roomId, 5);
        if (lines && /[>❯]/m.test(lines)) {
          clearInterval(interval);
          log.info(`Claude session ready for room ${roomId}`);
          resolve();
          return;
        }
        if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          log.warn(`Timed out waiting for Claude to be ready in room ${roomId}, proceeding anyway`);
          resolve();
        }
      }, 500);
    });
  }

  /** Route and handle a hook event from Claude Code. */
  private async handleHookEvent(payload: HookPayload): Promise<void> {
    const roomId = this.resolveRoom(payload);
    if (!roomId) {
      log.debug(`Could not resolve room for hook event: ${payload.hook_event_name} (cwd: ${payload.cwd})`);
      return;
    }

    log.debug(`Hook event: ${payload.hook_event_name} -> room ${roomId}`);

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
      await this.matrix.sendHtmlMessage(roomId, text, html);
      await this.matrix.setTyping(roomId, false);
    } else {
      // Always store the latest PreToolUse so that the Notification hook
      // (permission_prompt) can include tool details — the Notification
      // payload from Claude Code only carries a generic message string.
      this.pendingToolUse.set(roomId, payload);

      // PreToolUse fires for every tool regardless of whether the user needs
      // to approve it.  Real permission prompts arrive via the Notification
      // hook with notification_type "permission_prompt", which only fires when
      // Claude actually blocks waiting for user input.  In modes that
      // auto-approve some or all tools (auto, acceptEdits, bypassPermissions)
      // suppress this banner to avoid flooding with spurious notifications.
      // Mode "default" and "plan" still need PreToolUse because all tools
      // require explicit approval (and Notification may arrive after a delay).
      const perm = this.getEffectivePermission(roomId);
      if (perm.mode !== "default" && perm.mode !== "plan") {
        return;
      }

      let text = `**Permission Required**: \`${payload.tool_name}\`\n`;

      const toolInput = payload.tool_input;
      if (toolInput) {
        if (payload.tool_name === "Bash" && toolInput.command) {
          text += `\n\`\`\`bash\n${String(toolInput.command)}\n\`\`\``;
        } else if ((payload.tool_name === "Edit" || payload.tool_name === "Write") && toolInput.file_path) {
          text += `\nFile: \`${String(toolInput.file_path)}\``;
        } else {
          text += `\n\`\`\`json\n${JSON.stringify(toolInput, null, 2)}\n\`\`\``;
        }
      }

      text += `\n\n_Reply "y" to allow or "n" to deny._`;

      const html = await marked.parse(text);
      await this.matrix.sendHtmlMessage(roomId, text, html);
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

    const chunks = splitMessage(message, this.config.bot.maxMessageLength);
    for (const chunk of chunks) {
      const html = await marked.parse(chunk);
      await this.matrix.sendHtmlMessage(roomId, chunk, html);
    }
  }

  private async handleNotification(roomId: string, payload: HookPayload): Promise<void> {
    if (payload.notification_type === "idle_prompt") {
      await this.matrix.setTyping(roomId, false);
      const msg = payload.message || "Claude is idle, waiting for input.";
      await this.matrix.sendNotice(roomId, msg);
    } else if (payload.notification_type === "permission_prompt") {
      await this.matrix.setTyping(roomId, false);

      // The Notification hook from Claude Code only carries a generic message
      // (e.g. "Claude needs your permission to use Bash") without tool_name
      // or tool_input.  Enrich it with the last PreToolUse payload we saved.
      const pending = this.pendingToolUse.get(roomId);
      const toolName = payload.tool_name ?? pending?.tool_name;
      const toolInput = payload.tool_input ?? pending?.tool_input;
      // Consume the pending entry so it isn't reused for unrelated prompts.
      this.pendingToolUse.delete(roomId);

      let text = `**Permission Required**`;
      if (toolName) {
        text += `: \`${toolName}\`\n`;
      }

      if (toolInput) {
        if (toolName === "Bash" && toolInput.command) {
          text += `\n\`\`\`bash\n${String(toolInput.command)}\n\`\`\``;
        } else if ((toolName === "Edit" || toolName === "Write") && toolInput.file_path) {
          text += `\nFile: \`${String(toolInput.file_path)}\``;
        } else if (toolName === "Read" && toolInput.file_path) {
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
      await this.matrix.sendHtmlMessage(roomId, text, html);
    }
  }

  /** Get the effective permission config for a room. */
  private getEffectivePermission(roomId: string): import("../config/schema.js").PermissionConfig {
    const session = this.sessions.get(roomId);
    const project = session?.project ?? this.config.projects.defaultProject;
    return resolvePermission(this.config.projects, project, session?.permissionOverride);
  }

  /** Resolve which Matrix room a hook event belongs to, using cwd. */
  private resolveRoom(payload: HookPayload): string | undefined {
    if (payload.cwd) {
      const roomId = this.cwdToRoom.get(payload.cwd);
      if (roomId) return roomId;

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
