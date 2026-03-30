/**
 * Bridge Runner — Orchestrates Claude Code in interactive tmux mode.
 *
 * Runs a single tmux session ("claude-bridge") with one window per configured
 * project. Each window runs Claude Code interactively. Communication happens via:
 *
 * - **Hooks -> IPC socket -> Matrix**: Claude emits hook events (SessionStart,
 *   PreToolUse, Stop, Notification) which are forwarded to the bridge via a
 *   Unix socket. The bridge sends notifications/responses to Matrix.
 *
 * - **Matrix -> tmux send-keys -> Claude**: User messages from Matrix are injected
 *   into the correct project window based on the room's active project.
 *
 * Multiple rooms can share the same project tab. Hook responses are routed to
 * the room that most recently sent a message to that project.
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

  /** Tracks which room most recently sent a message to each project. */
  private readonly lastActiveRoom = new Map<string, string>();

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
   * Start all project windows at once. Called once at startup.
   */
  async warmupAll(): Promise<void> {
    const projects = this.config.projects.projects;

    for (const [projectName, entry] of Object.entries(projects)) {
      if (this.tmux.isAlive(projectName)) continue;

      const perm = resolvePermission(this.config.projects, projectName);
      const permArgs = buildPermissionArgs(perm);

      log.info(`Starting window for project "${projectName}" (cwd: ${entry.path})`);
      this.tmux.startWindow(
        projectName,
        entry.path,
        this.config.claude.binaryPath,
        [...permArgs, ...this.config.bridge.claudeArgs],
        this.settingsJson,
      );
      await this.waitForReady(projectName);
      log.info(`Project "${projectName}" ready`);
    }
  }

  /**
   * Register a room's project mapping for hook routing.
   * Called at startup for all joined rooms.
   */
  registerRoom(roomId: string): void {
    const session = this.sessions.get(roomId);
    const project = session?.project ?? this.config.projects.defaultProject;
    this.lastActiveRoom.set(project, roomId);
    log.debug(`Registered room ${roomId} -> project "${project}"`);
  }

  /**
   * Handle a user message for a room.
   * Routes the message to the correct project window.
   */
  async handleMessage(roomId: string, prompt: string): Promise<null> {
    const project = this.resolveProject(roomId);

    // Ensure the window is alive, restart if dead
    if (!this.tmux.isAlive(project)) {
      const entry = this.config.projects.projects[project];
      if (!entry) throw new Error(`Unknown project "${project}"`);

      const perm = resolvePermission(this.config.projects, project);
      this.tmux.startWindow(
        project,
        entry.path,
        this.config.claude.binaryPath,
        [...buildPermissionArgs(perm), ...this.config.bridge.claudeArgs],
        this.settingsJson,
      );
      await this.waitForReady(project);
    }

    // Track which room is active for this project (for hook routing)
    this.lastActiveRoom.set(project, roomId);

    const sent = this.tmux.sendInput(project, prompt);
    if (!sent) {
      await this.matrix.sendNotice(roomId, "Failed to send input to Claude session. Try !new to restart.");
    }

    await this.matrix.setTyping(roomId, true);
    return null;
  }

  /** Start a new Claude session for a room's current project. */
  async newSession(roomId: string): Promise<void> {
    const project = this.resolveProject(roomId);

    // Kill and restart the project window
    this.tmux.killWindow(project);
    this.sessions.clear(roomId);

    const entry = this.config.projects.projects[project];
    if (!entry) throw new Error(`Unknown project "${project}"`);

    const perm = resolvePermission(this.config.projects, project);
    this.tmux.startWindow(
      project,
      entry.path,
      this.config.claude.binaryPath,
      [...buildPermissionArgs(perm), ...this.config.bridge.claudeArgs],
      this.settingsJson,
    );
    await this.waitForReady(project);
  }

  /**
   * Switch a room to a different project. The target window already exists
   * (created at warmup), so this just updates the mapping.
   */
  async switchProject(roomId: string, project: string): Promise<void> {
    const entry = this.config.projects.projects[project];
    if (!entry) throw new Error(`Unknown project "${project}"`);

    // Update session mapping
    this.sessions.set(roomId, { project, sessionId: null });
    this.lastActiveRoom.set(project, roomId);

    // Ensure the window is alive
    if (!this.tmux.isAlive(project)) {
      const perm = resolvePermission(this.config.projects, project);
      this.tmux.startWindow(
        project,
        entry.path,
        this.config.claude.binaryPath,
        [...buildPermissionArgs(perm), ...this.config.bridge.claudeArgs],
        this.settingsJson,
      );
      await this.waitForReady(project);
    }

    await this.matrix.sendNotice(
      roomId,
      `Switched to project: ${project}\nDirectory: ${entry.path}`,
    );
  }

  /** Cancel the current operation (send Ctrl-C to the project window). */
  cancel(roomId: string): boolean {
    const project = this.resolveProject(roomId);
    return this.tmux.sendInterrupt(project);
  }

  /** Get tmux status for a room's active project. */
  getStatus(roomId: string, lineCount: number = 10): { alive: boolean; lines: string | null } {
    const project = this.resolveProject(roomId);
    const alive = this.tmux.isAlive(project);
    const lines = alive ? this.tmux.captureLines(project, lineCount) : null;
    return { alive, lines };
  }

  /** Clean up all resources. */
  stop(): void {
    this.tmux.killAll();
    this.ipc.stop();
    log.info("Bridge runner stopped");
  }

  // -- Private ----------------------------------------------------------------

  /** Resolve the active project name for a room. */
  private resolveProject(roomId: string): string {
    const session = this.sessions.get(roomId);
    return session?.project ?? this.config.projects.defaultProject;
  }

  /**
   * Wait for Claude Code to be ready in a project window.
   */
  private waitForReady(project: string, timeoutMs: number = 30000): Promise<void> {
    return new Promise((resolve) => {
      const start = Date.now();
      const interval = setInterval(() => {
        const lines = this.tmux.captureLines(project, 5);
        if (lines && /[>❯]/m.test(lines)) {
          clearInterval(interval);
          log.info(`Claude ready in project "${project}"`);
          resolve();
          return;
        }
        if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          log.warn(`Timed out waiting for Claude to be ready in project "${project}", proceeding anyway`);
          resolve();
        }
      }, 500);
    });
  }

  /** Route and handle a hook event from Claude Code. */
  private async handleHookEvent(payload: HookPayload): Promise<void> {
    const roomId = this.resolveRoomFromHook(payload);
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
      const project = this.resolveProject(roomId);
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
      await this.matrix.sendHtmlMessage(roomId, text, html);
    }
  }

  /**
   * Resolve which Matrix room a hook event belongs to.
   * Uses cwd -> project -> lastActiveRoom mapping.
   */
  private resolveRoomFromHook(payload: HookPayload): string | undefined {
    if (payload.cwd) {
      const project = this.tmux.findProjectByCwd(payload.cwd);
      if (project) {
        const roomId = this.lastActiveRoom.get(project);
        if (roomId) return roomId;
      }
    }

    // Fallback: if only one room is active, use it
    if (this.lastActiveRoom.size === 1) {
      return [...this.lastActiveRoom.values()][0];
    }

    return undefined;
  }
}
