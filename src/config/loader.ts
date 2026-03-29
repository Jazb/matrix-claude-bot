/**
 * Loads configuration from environment variables.
 *
 * Required env vars:
 *   MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN, MATRIX_ALLOWED_USER_ID,
 *   PROJECTS (comma-separated "name=/path" pairs), GROQ_API_KEY
 *
 * Optional env vars (with defaults):
 *   DEFAULT_PROJECT, CLAUDE_BINARY_PATH, CLAUDE_TIMEOUT, CLAUDE_MAX_TURNS,
 *   GROQ_MODEL, GROQ_ENDPOINT, GROQ_LANGUAGE, MAX_MESSAGE_LENGTH,
 *   TMP_DIR, SESSIONS_FILE, LOG_LEVEL
 */

import type { AppConfig } from "./schema.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[CONFIG] Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function parseProjects(raw: string): Record<string, string> {
  const projects: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) {
      console.error(`[CONFIG] Invalid PROJECTS entry (expected "name=/path"): ${trimmed}`);
      process.exit(1);
    }
    const name = trimmed.slice(0, eqIndex).trim().toLowerCase();
    const path = trimmed.slice(eqIndex + 1).trim();
    projects[name] = path;
  }
  if (Object.keys(projects).length === 0) {
    console.error("[CONFIG] PROJECTS must contain at least one entry");
    process.exit(1);
  }
  return projects;
}

export function loadConfig(): AppConfig {
  const projects = parseProjects(required("PROJECTS"));
  const defaultProject = optional("DEFAULT_PROJECT", Object.keys(projects)[0]);

  if (!projects[defaultProject]) {
    console.error(`[CONFIG] DEFAULT_PROJECT "${defaultProject}" not found in PROJECTS`);
    process.exit(1);
  }

  return {
    matrix: {
      homeserverUrl: required("MATRIX_HOMESERVER_URL"),
      accessToken: required("MATRIX_ACCESS_TOKEN"),
      allowedUserId: required("MATRIX_ALLOWED_USER_ID"),
      enableE2ee: optional("MATRIX_ENABLE_E2EE", "true") === "true",
      cryptoStoragePath: optional("MATRIX_CRYPTO_STORAGE_PATH", "./data/crypto"),
      password: optional("MATRIX_PASSWORD", ""),
    },
    projects: {
      projects,
      defaultProject,
    },
    claude: {
      binaryPath: optional("CLAUDE_BINARY_PATH", "/usr/bin/claude"),
      timeout: Number(optional("CLAUDE_TIMEOUT", "300000")),
      maxTurns: Number(optional("CLAUDE_MAX_TURNS", "25")),
    },
    groq: {
      apiKey: optional("GROQ_API_KEY", ""),
      model: optional("GROQ_MODEL", "whisper-large-v3-turbo"),
      endpoint: optional("GROQ_ENDPOINT", "https://api.groq.com/openai/v1/audio/transcriptions"),
      language: optional("GROQ_LANGUAGE", "auto"),
    },
    bot: {
      maxMessageLength: Number(optional("MAX_MESSAGE_LENGTH", "4096")),
      tmpDir: optional("TMP_DIR", "/tmp/matrix-claude-bot"),
      sessionsFile: optional("SESSIONS_FILE", "./data/sessions.json"),
      logLevel: optional("LOG_LEVEL", "info"),
    },
    bridge: {
      mode: (optional("BOT_MODE", "bot") as "bot" | "bridge" | "ide"),
      claudeArgs: optional("CLAUDE_EXTRA_ARGS", "").split(",").map(s => s.trim()).filter(Boolean),
      socketDir: optional("BRIDGE_SOCKET_DIR", "/tmp"),
      hookTimeout: Number(optional("BRIDGE_HOOK_TIMEOUT", "10000")),
    },
  };
}
