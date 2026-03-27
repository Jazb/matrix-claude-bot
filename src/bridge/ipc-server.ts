/**
 * IPC Server — Unix socket server for receiving Claude Code hook payloads.
 *
 * Creates a Unix socket that receives JSON payloads from the hook-ping script.
 * Each hook event from Claude Code (SessionStart, PreToolUse, Stop, Notification)
 * is forwarded here via the lightweight hook-ping process.
 *
 * Ported from Jackpoint's lib/ipc-server.js to TypeScript.
 */

import { createServer, type Server } from "net";
import { EventEmitter } from "events";
import { existsSync, unlinkSync } from "fs";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ipc");

/** Hook payload from Claude Code's hook system. */
export interface HookPayload {
  hook_event_name: "SessionStart" | "PreToolUse" | "Stop" | "Notification";
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  transcript_path?: string;
  notification_type?: string;
  message?: string;
}

export class IPCServer extends EventEmitter {
  private server: Server | null = null;
  readonly socketPath: string;

  constructor(socketDir: string, id: string) {
    super();
    this.socketPath = `${socketDir}/claude-bridge-${id}.sock`;
  }

  /** Start the Unix socket server. Returns the socket path. */
  start(): string {
    // Clean up stale socket file
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        // Ignore
      }
    }

    this.server = createServer((connection) => {
      let data = "";

      connection.on("data", (chunk) => {
        data += chunk.toString();
      });

      connection.on("end", () => {
        try {
          const payload = JSON.parse(data) as HookPayload;
          log.debug(`Received hook: ${payload.hook_event_name}`);
          this.emit("hook", payload);
        } catch (err) {
          log.debug(`Failed to parse hook payload: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

      connection.on("error", (err) => {
        log.debug(`Connection error: ${err.message}`);
      });
    });

    this.server.on("error", (err) => {
      log.error(`Server error: ${err.message}`);
    });

    this.server.listen(this.socketPath, () => {
      log.info(`IPC server listening on ${this.socketPath}`);
    });

    return this.socketPath;
  }

  /** Stop the server and clean up the socket file. */
  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }

    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
        log.debug(`Socket file removed: ${this.socketPath}`);
      } catch {
        // Ignore
      }
    }
  }
}
