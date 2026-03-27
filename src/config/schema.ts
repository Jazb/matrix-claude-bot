/**
 * Configuration schema and types for the Matrix Claude bot.
 *
 * All settings are loaded from environment variables with sensible defaults.
 * Required variables will cause the bot to exit with a clear error if missing.
 */

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
}

// -- Project mapping --

export interface ProjectsConfig {
  /**
   * Map of project name → absolute directory path.
   * Parsed from PROJECTS env var as comma-separated "name=/path" pairs.
   * Example: "myproject=/home/user/project,other=/home/user/other"
   */
  projects: Record<string, string>;
  /** Default project name to use when none is specified */
  defaultProject: string;
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
