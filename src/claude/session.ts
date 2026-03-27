/**
 * Session persistence for Claude Code conversations.
 *
 * Stores the Claude --resume session_id per Matrix room so that
 * consecutive messages continue the same conversation context.
 * Sessions are saved to disk as JSON.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { createLogger } from "../utils/logger.js";

const log = createLogger("session");

export interface SessionData {
  sessionId: string | null;
  project: string;
}

export class SessionStore {
  private sessions: Record<string, SessionData> = {};

  constructor(private readonly filePath: string) {
    this.load();
  }

  /** Load sessions from disk. Non-fatal if missing or corrupt. */
  private load(): void {
    if (!existsSync(this.filePath)) {
      log.debug("No sessions file found, starting fresh");
      return;
    }
    try {
      this.sessions = JSON.parse(readFileSync(this.filePath, "utf8"));
      log.info(`Loaded ${Object.keys(this.sessions).length} sessions`);
    } catch {
      log.warn("Corrupt sessions file, starting fresh");
      this.sessions = {};
    }
  }

  /** Persist current sessions to disk. */
  private save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.filePath, JSON.stringify(this.sessions, null, 2));
  }

  get(roomId: string): SessionData | null {
    return this.sessions[roomId] ?? null;
  }

  set(roomId: string, data: Partial<SessionData>): void {
    this.sessions[roomId] = { ...this.sessions[roomId], ...data } as SessionData;
    this.save();
  }

  clear(roomId: string): void {
    delete this.sessions[roomId];
    this.save();
  }
}
