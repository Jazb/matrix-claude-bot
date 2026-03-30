/**
 * Tmux Manager — Manages a single tmux session with per-project windows.
 *
 * Instead of one tmux session per Matrix room, we run ONE session ("claude-bridge")
 * with multiple windows (tabs). Each window is named after a project and runs
 * Claude Code in that project's directory.
 *
 * Matrix rooms are mapped to projects, and messages are routed to the correct
 * tmux window based on the room's active project.
 */

import { execSync } from "child_process";
import { createLogger } from "../utils/logger.js";

const log = createLogger("tmux");

const SESSION_NAME = "claude-bridge";

interface TmuxWindow {
  project: string;
  cwd: string;
}

export class TmuxManager {
  private readonly windows = new Map<string, TmuxWindow>();
  private sessionCreated = false;

  constructor() {
    this.checkTmuxInstalled();
    this.detectExistingSession();
  }

  private checkTmuxInstalled(): void {
    try {
      execSync("tmux -V", { stdio: "pipe" });
    } catch {
      throw new Error("tmux is not installed. Bridge mode requires tmux. Install it with: sudo apt install tmux");
    }
  }

  /** Detect if a previous session exists (e.g., after a bot crash). */
  private detectExistingSession(): void {
    try {
      execSync(`tmux has-session -t "${SESSION_NAME}"`, { stdio: "pipe" });
      // Stale session from a previous run — kill it for a clean start
      log.info(`Killing stale tmux session "${SESSION_NAME}"`);
      execSync(`tmux kill-session -t "${SESSION_NAME}"`, { stdio: "pipe" });
    } catch {
      // No existing session — good
    }
  }

  /**
   * Start a new tmux window for a project.
   * On the first call, creates the tmux session with the first window.
   * Subsequent calls add windows to the existing session.
   */
  startWindow(
    project: string,
    cwd: string,
    claudeBinaryPath: string,
    claudeArgs: string[],
    settingsJson: string,
  ): void {
    // Kill existing window for this project if any
    if (this.windows.has(project)) {
      this.killWindow(project);
    }

    const windowName = this.sanitizeWindowName(project);

    if (!this.sessionCreated) {
      // First window — create the session
      try {
        execSync(
          `tmux new-session -d -s "${SESSION_NAME}" -n "${windowName}" -c "${cwd}"`,
          { stdio: "pipe" },
        );
        this.sessionCreated = true;
      } catch (err) {
        throw new Error(
          `Failed to create tmux session: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      // Additional window — add to existing session
      try {
        execSync(
          `tmux new-window -t "${SESSION_NAME}" -n "${windowName}" -c "${cwd}"`,
          { stdio: "pipe" },
        );
      } catch (err) {
        throw new Error(
          `Failed to create tmux window "${windowName}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Build and send the Claude command
    const args = ["--settings", `'${settingsJson}'`, ...claudeArgs];
    const cmd = `${claudeBinaryPath} ${args.join(" ")}`;
    const target = `${SESSION_NAME}:${windowName}`;

    execSync(`tmux send-keys -t "${target}" ${this.escapeForShell(cmd)} C-m`, {
      stdio: "pipe",
    });

    this.windows.set(project, { project, cwd });
    log.info(`Started tmux window "${windowName}" for project "${project}" in ${cwd}`);
  }

  /**
   * Send user input to the tmux window for a project.
   */
  sendInput(project: string, text: string): boolean {
    const window = this.windows.get(project);
    if (!window) {
      log.warn(`No tmux window for project "${project}"`);
      return false;
    }

    const target = `${SESSION_NAME}:${this.sanitizeWindowName(project)}`;

    try {
      const escaped = this.escapeForTmux(text);
      execSync(`tmux send-keys -t "${target}" -l ${escaped}`, { stdio: "pipe" });
      execSync(`tmux send-keys -t "${target}" C-m`, { stdio: "pipe" });
      log.debug(`Sent input to tmux window "${project}"`);
      return true;
    } catch (err) {
      log.error(`Failed to send to tmux window "${project}": ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Send Ctrl-C to the tmux window for a project. */
  sendInterrupt(project: string): boolean {
    const window = this.windows.get(project);
    if (!window) return false;

    const target = `${SESSION_NAME}:${this.sanitizeWindowName(project)}`;

    try {
      execSync(`tmux send-keys -t "${target}" C-c`, { stdio: "pipe" });
      log.info(`Sent Ctrl-C to tmux window "${project}"`);
      return true;
    } catch {
      return false;
    }
  }

  /** Capture the last N lines from the tmux pane for a project. */
  captureLines(project: string, lineCount: number = 30): string | null {
    const window = this.windows.get(project);
    if (!window) return null;

    const target = `${SESSION_NAME}:${this.sanitizeWindowName(project)}`;

    try {
      const output = execSync(
        `tmux capture-pane -t "${target}" -p -S -${lineCount}`,
        { stdio: "pipe", encoding: "utf-8" },
      );
      return output.trimEnd();
    } catch {
      return null;
    }
  }

  /** Kill a single project window. */
  killWindow(project: string): void {
    const window = this.windows.get(project);
    if (!window) return;

    const target = `${SESSION_NAME}:${this.sanitizeWindowName(project)}`;

    try {
      execSync(`tmux kill-window -t "${target}"`, { stdio: "pipe" });
      log.info(`Killed tmux window "${project}"`);
    } catch {
      // Window might already be dead
    }

    this.windows.delete(project);

    // If no windows left, session is dead
    if (this.windows.size === 0) {
      this.sessionCreated = false;
    }
  }

  /** Check if the tmux window for a project is still alive. */
  isAlive(project: string): boolean {
    const window = this.windows.get(project);
    if (!window) return false;

    try {
      // List windows and check if ours exists
      const output = execSync(
        `tmux list-windows -t "${SESSION_NAME}" -F "#{window_name}"`,
        { stdio: "pipe", encoding: "utf-8" },
      );
      const windowNames = output.trim().split("\n");
      if (windowNames.includes(this.sanitizeWindowName(project))) {
        return true;
      }
    } catch {
      // Session might be dead
    }

    this.windows.delete(project);
    if (this.windows.size === 0) this.sessionCreated = false;
    return false;
  }

  /** Find the project name for a given cwd (supports subdirectories). */
  findProjectByCwd(cwd: string): string | undefined {
    // Exact match first
    for (const [project, window] of this.windows) {
      if (window.cwd === cwd) return project;
    }
    // Subdirectory match
    for (const [project, window] of this.windows) {
      if (cwd.startsWith(window.cwd)) return project;
    }
    return undefined;
  }

  /** Get all tracked project names. */
  getProjects(): string[] {
    return [...this.windows.keys()];
  }

  /** Kill the entire tmux session. */
  killAll(): void {
    try {
      execSync(`tmux kill-session -t "${SESSION_NAME}"`, { stdio: "pipe" });
      log.info(`Killed tmux session "${SESSION_NAME}"`);
    } catch {
      // Session might already be dead
    }
    this.windows.clear();
    this.sessionCreated = false;
  }

  /** Sanitize project name for use as tmux window name. */
  private sanitizeWindowName(project: string): string {
    // tmux doesn't allow dots or colons in window names
    return project.replace(/[.:]/g, "-");
  }

  /** Escape text for tmux send-keys -l (literal mode). */
  private escapeForTmux(text: string): string {
    const escaped = text
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\$/g, "\\$")
      .replace(/`/g, "\\`");
    return `"${escaped}"`;
  }

  /** Escape a command for shell execution. */
  private escapeForShell(cmd: string): string {
    const escaped = cmd
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\$/g, "\\$")
      .replace(/`/g, "\\`");
    return `"${escaped}"`;
  }
}
