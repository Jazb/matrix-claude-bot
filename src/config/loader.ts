/**
 * Loads configuration from environment variables.
 *
 * Required env vars:
 *   MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN, MATRIX_ALLOWED_USER_ID,
 *   PROJECTS (comma-separated entries), GROQ_API_KEY
 *
 * Optional env vars (with defaults):
 *   DEFAULT_PROJECT, PERMISSION_MODE, CLAUDE_BINARY_PATH, CLAUDE_TIMEOUT,
 *   CLAUDE_MAX_TURNS, GROQ_MODEL, GROQ_ENDPOINT, GROQ_LANGUAGE,
 *   MAX_MESSAGE_LENGTH, TMP_DIR, SESSIONS_FILE, LOG_LEVEL
 *
 * PROJECTS format:
 *   Simple:          "myproject=/home/user/project"
 *   With permission: "myproject=/home/user/project:bypassPermissions"
 *   Mixed:           "safe=/home/safe,dangerous=/home/dev:bypassPermissions"
 */

import type { AppConfig, PermissionConfig, PermissionMode, ProjectEntry } from "./schema.js";

const VALID_PERMISSION_MODES: PermissionMode[] = [
  "default", "acceptEdits", "plan", "auto", "bypassPermissions",
];

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

/**
 * Parse a permission mode string into a PermissionConfig.
 *
 * Accepts:
 *   "default", "acceptEdits", "plan", "auto", "bypassPermissions"
 *   "allowedTools:Bash(npm *),Edit,Read"
 */
export function parsePermissionMode(raw: string): PermissionConfig {
  const trimmed = raw.trim();

  if (trimmed.startsWith("allowedTools:")) {
    const tools = trimmed.slice("allowedTools:".length).split(";").map(t => t.trim()).filter(Boolean);
    return { mode: "default", allowedTools: tools };
  }

  if (!VALID_PERMISSION_MODES.includes(trimmed as PermissionMode)) {
    throw new Error(
      `Invalid permission mode "${trimmed}". Valid: ${VALID_PERMISSION_MODES.join(", ")}, or "allowedTools:..."`,
    );
  }

  return { mode: trimmed as PermissionMode, allowedTools: [] };
}

/**
 * Parse PROJECTS env var.
 *
 * Format: "name=/path[:permissionMode],name2=/path2[:permissionMode]"
 * The permission mode suffix is optional per project.
 */
function parseProjects(raw: string): Record<string, ProjectEntry> {
  const projects: Record<string, ProjectEntry> = {};

  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) {
      console.error(`[CONFIG] Invalid PROJECTS entry (expected "name=/path[:mode]"): ${trimmed}`);
      process.exit(1);
    }

    const name = trimmed.slice(0, eqIndex).trim().toLowerCase();
    const rest = trimmed.slice(eqIndex + 1).trim();

    // Check for permission mode suffix — last colon-separated segment
    // Must be careful: paths can contain colons on some systems, but permission
    // mode values are a known set, so we check from the right.
    const lastColon = rest.lastIndexOf(":");
    let path = rest;
    let permission: PermissionConfig | null = null;

    if (lastColon > 0) {
      const maybePerm = rest.slice(lastColon + 1);
      // Check if the suffix looks like a permission mode
      if (VALID_PERMISSION_MODES.includes(maybePerm as PermissionMode) || maybePerm.startsWith("allowedTools:")) {
        path = rest.slice(0, lastColon);
        permission = parsePermissionMode(maybePerm);
      }
    }

    projects[name] = { path, permission };
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

  const defaultPermission = parsePermissionMode(optional("PERMISSION_MODE", "default"));

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
      defaultPermission,
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
      healthPort: Number(optional("HEALTH_PORT", "8081")),
    },
    bridge: {
      mode: (optional("BOT_MODE", "bot") as "bot" | "bridge" | "ide"),
      claudeArgs: optional("CLAUDE_EXTRA_ARGS", "").split(",").map(s => s.trim()).filter(Boolean),
      socketDir: optional("BRIDGE_SOCKET_DIR", "/tmp"),
      hookTimeout: Number(optional("BRIDGE_HOOK_TIMEOUT", "10000")),
    },
  };
}
