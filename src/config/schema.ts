/**
 * Configuration schema and types for the Matrix Claude bot.
 *
 * All settings are loaded from environment variables with sensible defaults.
 * Required variables will cause the bot to exit with a clear error if missing.
 */

// -- Permission modes --

/**
 * Claude Code permission modes that control how tool calls are approved.
 *
 * See: https://code.claude.com/docs/en/permission-modes
 *
 * - "default"            — Prompts for commands and edits (standard)
 * - "acceptEdits"        — Auto-approves file edits, prompts for commands
 * - "plan"               — Read-only, no file modifications or commands
 * - "auto"               — AI safety classifier auto-approves most actions
 * - "bypassPermissions"  — Skips all permission checks (use in isolated envs only)
 *
 * Can also specify allowed tools inline: "allowedTools:Bash(npm *),Edit,Read"
 */
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "auto"
  | "bypassPermissions";

export interface PermissionConfig {
  /** The permission mode to use */
  mode: PermissionMode;
  /** Specific tools to pre-approve (--allowedTools). Only used when mode is "default". */
  allowedTools: string[];
}

// -- Matrix connection --

export interface MatrixConfig {
  /** Matrix homeserver URL (e.g. https://matrix.org) */
  homeserverUrl: string;
  /** Bot access token obtained via login or registration */
  accessToken: string;
  /** Matrix user ID allowed to interact with the bot (e.g. @user:matrix.org) */
  allowedUserId: string;
  /** Enable E2EE (end-to-end encryption) support */
  enableE2ee: boolean;
  /** Directory for crypto storage (Olm/Megolm keys) */
  cryptoStoragePath: string;
  /** Matrix account password — used for cross-signing bootstrap (optional) */
  password: string;
}

// -- Project mapping --

export interface ProjectEntry {
  /** Absolute directory path */
  path: string;
  /** Permission mode override for this project (null = use global default) */
  permission: PermissionConfig | null;
}

export interface ProjectsConfig {
  /**
   * Map of project name → project entry.
   * Parsed from PROJECTS env var as comma-separated entries.
   *
   * Simple:  "myproject=/home/user/project"
   * With permission: "myproject=/home/user/project:bypassPermissions"
   */
  projects: Record<string, ProjectEntry>;
  /** Default project name to use when none is specified */
  defaultProject: string;
  /** Global default permission mode (applies when project has no override) */
  defaultPermission: PermissionConfig;
}

// -- Claude Code execution --

export interface ClaudeConfig {
  /** Absolute path to the claude binary */
  binaryPath: string;
  /** Maximum execution time in milliseconds */
  timeout: number;
  /** Maximum agentic turns per invocation */
  maxTurns: number;
}

// -- Groq speech-to-text --

export interface GroqConfig {
  /** Groq API key for speech-to-text */
  apiKey: string;
  /** Whisper model to use */
  model: string;
  /** API endpoint URL */
  endpoint: string;
  /** Language hint (ISO-639-1) or "auto" for detection */
  language: string;
}

// -- Bot behaviour --

export interface BotConfig {
  /** Maximum characters per Matrix message before splitting */
  maxMessageLength: number;
  /** Directory for temporary files (audio downloads, images) */
  tmpDir: string;
  /** Path to the sessions persistence file */
  sessionsFile: string;
  /** Log level: "debug" | "info" | "warn" | "error" */
  logLevel: string;
  /** Port for HTTP health check endpoint (0 = disabled) */
  healthPort: number;
}

// -- Bridge mode --

export interface BridgeConfig {
  /** Operating mode: "bot" (one-shot subprocess), "bridge" (tmux + hooks), or "ide" (MCP WebSocket) */
  mode: "bot" | "bridge" | "ide";
  /** Extra CLI arguments for Claude in bridge mode (e.g. ["--model", "sonnet"]) */
  claudeArgs: string[];
  /** Directory for Unix socket files */
  socketDir: string;
  /** Hook timeout in milliseconds */
  hookTimeout: number;
}

// -- Aggregate --

export interface AppConfig {
  matrix: MatrixConfig;
  projects: ProjectsConfig;
  claude: ClaudeConfig;
  groq: GroqConfig;
  bot: BotConfig;
  bridge: BridgeConfig;
}
