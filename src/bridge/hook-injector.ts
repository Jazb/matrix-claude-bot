/**
 * Hook Injector — Generates Claude Code --settings JSON with hooks configured.
 *
 * Creates a settings object that configures Claude Code hooks to call hook-ping,
 * which forwards structured JSON payloads to the bridge's IPC socket.
 * This works in ANY directory without relying on project-local .claude hooks.
 *
 * Ported from Jackpoint's lib/hook-injector.js to TypeScript.
 */

import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_PING_PATH = join(__dirname, "hook-ping.js");

/**
 * Generate hook settings JSON for the --settings flag.
 * All hooks point to our IPC socket via the hook-ping script.
 */
export function generateHooksSettings(socketPath: string, hookTimeout: number): string {
  const hookCmd = `CLAUDE_MATRIX_SOCKET="${socketPath}" node "${HOOK_PING_PATH}"`;

  const hookEntry = (matcher?: string) => {
    const entry: Record<string, unknown> = {
      hooks: [{ type: "command", command: hookCmd, timeout: hookTimeout }],
    };
    if (matcher) entry.matcher = matcher;
    return entry;
  };

  const settings = {
    hooks: {
      SessionStart: [hookEntry()],
      PreToolUse: [hookEntry("AskUserQuestion")],
      Stop: [hookEntry()],
      Notification: [hookEntry()],
    },
  };

  return JSON.stringify(settings);
}

/** Get the absolute path to the compiled hook-ping.js script. */
export function getHookPingPath(): string {
  return HOOK_PING_PATH;
}
