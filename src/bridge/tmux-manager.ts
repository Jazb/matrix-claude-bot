/**
 * Tmux Manager — Manages tmux sessions for Claude Code in bridge mode.
 *
 * Each Matrix room maps to a tmux session where Claude Code runs interactively.
 * User messages are injected via `tmux send-keys`, and Claude's output is
 * captured via hooks (not terminal parsing).
 *
 * Inspired by Jackpoint's tmux management patterns.
 */

import { execSync } from "child_process";
import { createLogger } from "../utils/logger.js";

const log = createLogger("tmux");

interface TmuxSession {
  sessionName: string;
  project: string;
  cwd: string;
}

export class TmuxManager {
  private readonly sessions = new Map<string, TmuxSession>();

  constructor() {
    this.checkTmuxInstalled();
  }

  private checkTmuxInstalled(): void {
    try {
      execSync("tmux -V", { stdio: "pipe" });
    } catch {
      throw new Error("tmux is not installed. Bridge mode requires tmux. Install it with: sudo apt install tmux");
    }
  }

  /**
   * Start a new tmux session for a Matrix room with Claude Code running inside.
   */
  startSession(
    roomId: string,
    project: string,
    cwd: string,
    claudeBinaryPath: string,
    claudeArgs: string[],
    settingsJson: string,
  ): void {
    // Kill existing session for this room if any
    if (this.sessions.has(roomId)) {
      this.killSession(roomId);
    }

    const sessionName = this.roomIdToSessionName(roomId);

    // Create detached tmux session
    try {
      execSync(`tmux new-session -d -s "${sessionName}" -c "${cwd}"`, { stdio: "pipe" });
    } catch (err) {
      // Session might already exist from a previous crash
      try {
        execSync(`tmux kill-session -t "${sessionName}"`, { stdio: "pipe" });
        execSync(`tmux new-session -d -s "${sessionName}" -c "${cwd}"`, { stdio: "pipe" });
      } catch {
        throw new Error(`Failed to create tmux session "${sessionName}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Build the Claude command with --settings for hooks
    const args = ["--settings", `'${settingsJson}'`, ...claudeArgs];
    const cmd = `${claudeBinaryPath} ${args.join(" ")}`;

    // Send the command to the tmux session
    execSync(`tmux send-keys -t "${sessionName}" ${this.escapeForShell(cmd)} C-m`, { stdio: "pipe" });

    this.sessions.set(roomId, { sessionName, project, cwd });
    log.info(`Started tmux session "${sessionName}" for room ${roomId} in ${cwd}`);
  }

  /**
   * Send user input to the tmux session for a room.
   * Equivalent to the user typing text and pressing Enter.
   */
  sendInput(roomId: string, text: string): boolean {
    const session = this.sessions.get(roomId);
    if (!session) {
      log.warn(`No tmux session for room ${roomId}`);
      return false;
    }

    try {
      const escaped = this.escapeForTmux(text);
      // -l flag sends literal text (no key name interpretation)
      execSync(`tmux send-keys -t "${session.sessionName}" -l ${escaped}`, { stdio: "pipe" });
      execSync(`tmux send-keys -t "${session.sessionName}" C-m`, { stdio: "pipe" });
      log.debug(`Sent input to tmux session "${session.sessionName}"`);
      return true;
    } catch (err) {
      log.error(`Failed to send to tmux "${session.sessionName}": ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Send Ctrl-C to the tmux session (cancel current operation).
   */
  sendInterrupt(roomId: string): boolean {
    const session = this.sessions.get(roomId);
    if (!session) return false;

    try {
      execSync(`tmux send-keys -t "${session.sessionName}" C-c`, { stdio: "pipe" });
      log.info(`Sent Ctrl-C to tmux session "${session.sessionName}"`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Capture the last N lines from the tmux pane.
   */
  captureLines(roomId: string, lineCount: number = 30): string | null {
    const session = this.sessions.get(roomId);
    if (!session) return null;

    try {
      const output = execSync(
        `tmux capture-pane -t "${session.sessionName}" -p -S -${lineCount}`,
        { stdio: "pipe", encoding: "utf-8" },
      );
      return output.trimEnd();
    } catch {
      return null;
    }
  }

  /** Kill the tmux session for a room. */
  killSession(roomId: string): void {
    const session = this.sessions.get(roomId);
    if (!session) return;

    try {
      execSync(`tmux kill-session -t "${session.sessionName}"`, { stdio: "pipe" });
      log.info(`Killed tmux session "${session.sessionName}"`);
    } catch {
      // Session might already be dead
    }

    this.sessions.delete(roomId);
  }

  /** Check if the tmux session for a room is still alive. */
  isAlive(roomId: string): boolean {
    const session = this.sessions.get(roomId);
    if (!session) return false;

    try {
      execSync(`tmux has-session -t "${session.sessionName}"`, { stdio: "pipe" });
      return true;
    } catch {
      // Session is dead — clean up our map
      this.sessions.delete(roomId);
      return false;
    }
  }

  /** Get session info for a room. */
  getSession(roomId: string): TmuxSession | undefined {
    return this.sessions.get(roomId);
  }

  /** Find the room ID for a given cwd. */
  findRoomByCwd(cwd: string): string | undefined {
    for (const [roomId, session] of this.sessions) {
      if (session.cwd === cwd) return roomId;
    }
    return undefined;
  }

  /** Kill all tmux sessions. */
  killAll(): void {
    for (const roomId of [...this.sessions.keys()]) {
      this.killSession(roomId);
    }
  }

  /** Convert a Matrix room ID to a valid tmux session name. */
  private roomIdToSessionName(roomId: string): string {
    // Room IDs like "!abc123:matrix.org" → "claude-abc123"
    const cleaned = roomId.replace(/^!/, "").replace(/:.*$/, "").replace(/[^a-zA-Z0-9]/g, "");
    return `claude-${cleaned.slice(0, 20)}`;
  }

  /** Escape text for tmux send-keys -l (literal mode). */
  private escapeForTmux(text: string): string {
    // Wrap in double quotes, escaping special chars
    const escaped = text
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\$/g, "\\$")
      .replace(/`/g, "\\`");
    return `"${escaped}"`;
  }

  /** Escape a command for shell execution. */
  private escapeForShell(cmd: string): string {
    // Wrap in double quotes for tmux send-keys
    const escaped = cmd
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\$/g, "\\$")
      .replace(/`/g, "\\`");
    return `"${escaped}"`;
  }
}
