/**
 * Claude Code process runner.
 *
 * Spawns `claude -p "..." --output-format json` as a child process and
 * parses the JSON output to extract the assistant's response text and
 * session ID for resumption.
 *
 * Key design decisions (learned from the Telegram bot):
 * - stdin is set to 'ignore' — without this, Claude hangs waiting for input
 * - Environment is explicit — PM2/systemd don't load .bashrc
 * - Full path to binary — avoids ENOENT when PATH is incomplete
 */

import { spawn } from "child_process";
import type { ClaudeConfig, ProjectsConfig } from "../config/schema.js";
import { SessionStore } from "./session.js";
import type { SerialQueue } from "../queue/serial-queue.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("claude");

interface ClaudeResult {
  text: string;
  sessionId: string | null;
}

export class ClaudeRunner {
  constructor(
    private readonly config: ClaudeConfig,
    private readonly projectsConfig: ProjectsConfig,
    private readonly sessions: SessionStore,
    private readonly queue: SerialQueue,
  ) {}

  /**
   * Run a prompt through Claude Code for a specific Matrix room.
   * Uses --resume if a session exists to maintain conversation continuity.
   */
  async run(roomId: string, prompt: string): Promise<string> {
    const session = this.sessions.get(roomId);
    const project = session?.project ?? this.projectsConfig.defaultProject;
    const cwd = this.projectsConfig.projects[project];

    if (!cwd) {
      throw new Error(`Unknown project "${project}". Available: ${Object.keys(this.projectsConfig.projects).join(", ")}`);
    }

    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--max-turns", String(this.config.maxTurns),
    ];

    if (session?.sessionId) {
      args.push("--resume", session.sessionId);
    }

    log.info(`Running prompt in project "${project}" (cwd: ${cwd})`);
    log.debug(`Args: ${args.join(" ")}`);

    const result = await this.spawn(args, cwd);

    if (result.sessionId) {
      this.sessions.set(roomId, { sessionId: result.sessionId, project });
    }

    return result.text;
  }

  private spawn(args: string[], cwd: string): Promise<ClaudeResult> {
    // Explicit env — systemd/PM2 don't inherit shell profile
    const env: Record<string, string> = {
      HOME: process.env["HOME"] ?? "/root",
      PATH: process.env["PATH"] ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      TERM: "dumb",
      USER: process.env["USER"] ?? "root",
      LANG: "en_US.UTF-8",
    };

    // Forward Claude auth tokens if present
    const oauthToken = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    if (oauthToken) env["CLAUDE_CODE_OAUTH_TOKEN"] = oauthToken;

    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (apiKey) env["ANTHROPIC_API_KEY"] = apiKey;

    return new Promise((resolve, reject) => {
      // CRITICAL: stdin must be 'ignore'. Without this, Claude hangs indefinitely
      // because it detects an open stdin pipe and waits for input that never comes.
      const child = spawn(this.config.binaryPath, args, {
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
        reject(new Error("Claude timed out. Try a more specific prompt."));
      }, this.config.timeout);

      child.on("close", (code) => {
        clearTimeout(timeout);

        if (code !== 0 && !stdout) {
          const errMsg = stderr.slice(0, 500) || `Claude exited with code ${code}`;
          reject(new Error(errMsg));
          return;
        }

        try {
          const parsed = parseClaudeOutput(stdout);
          resolve(parsed);
        } catch {
          resolve({ text: stdout?.slice(0, 4000) || "Claude returned no response.", sessionId: null });
        }
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }
}

/**
 * Parse Claude's JSON output format.
 *
 * Claude with --output-format json may output multiple JSON lines.
 * We look for the session_id and the result text across all lines.
 */
function parseClaudeOutput(raw: string): ClaudeResult {
  const lines = raw.trim().split("\n").filter(Boolean);
  let text = "";
  let sessionId: string | null = null;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.session_id) sessionId = obj.session_id;
      if (obj.result) text = extractText(obj.result);
    } catch {
      // Not JSON — skip
    }
  }

  // Fallback: try parsing the entire output as a single JSON object
  if (!text) {
    try {
      const obj = JSON.parse(raw);
      if (obj.result) text = extractText(obj.result);
      if (obj.session_id) sessionId = obj.session_id;
    } catch {
      text = raw.slice(0, 4000);
    }
  }

  return { text: text || "No response.", sessionId };
}

function extractText(result: unknown): string {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    return result
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
  return JSON.stringify(result).slice(0, 4000);
}
