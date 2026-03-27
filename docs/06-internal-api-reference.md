# Internal API Reference

Documentation of the classes, interfaces, and functions exported by each module.

## config/

### `loadConfig(): AppConfig`

Loads all configuration from environment variables. Exits with `process.exit(1)` if a required variable is missing or the format is invalid.

### `AppConfig`

```typescript
interface AppConfig {
  matrix: MatrixConfig;
  projects: ProjectsConfig;
  claude: ClaudeConfig;
  groq: GroqConfig;
  bot: BotConfig;
}
```

### `MatrixConfig`

```typescript
interface MatrixConfig {
  homeserverUrl: string;      // Homeserver URL
  accessToken: string;        // Bot access token
  allowedUserId: string;      // Authorized user ID (@user:server)
  enableE2ee: boolean;        // Enable end-to-end encryption
  cryptoStoragePath: string;  // Directory for E2EE keys (SQLite)
}
```

### `ProjectsConfig`

```typescript
interface ProjectsConfig {
  projects: Record<string, string>;  // name -> absolute path
  defaultProject: string;            // default project
}
```

### `ClaudeConfig`

```typescript
interface ClaudeConfig {
  binaryPath: string;  // Path to the claude binary
  timeout: number;     // Timeout in ms
  maxTurns: number;    // Maximum agentic turns
}
```

### `GroqConfig`

```typescript
interface GroqConfig {
  apiKey: string;    // Groq API key
  model: string;     // Whisper model
  endpoint: string;  // Endpoint URL
  language: string;  // Language or "auto"
}
```

### `BotConfig`

```typescript
interface BotConfig {
  maxMessageLength: number;  // Max chars per message
  tmpDir: string;            // Temporary directory
  sessionsFile: string;      // Sessions file path
  logLevel: string;          // debug|info|warn|error
}
```

### `BridgeConfig`

```typescript
interface BridgeConfig {
  mode: "bot" | "bridge" | "ide";  // Operation mode
  claudeArgs: string[];            // Extra args for Claude (e.g.: ["--model", "sonnet"])
  socketDir: string;               // Directory for Unix sockets IPC (bridge)
  hookTimeout: number;             // Hook timeout in ms (bridge)
}
```

---

## claude/

### `class SessionStore`

Persists Claude Code sessions per Matrix room.

**Constructor:**

```typescript
new SessionStore(filePath: string)
```

Loads the JSON file if it exists. If it's corrupt, starts with an empty map.

**Methods:**

| Method | Description |
|--------|------------|
| `get(roomId: string): SessionData \| null` | Gets the session for a room |
| `set(roomId: string, data: Partial<SessionData>): void` | Updates (merges) the session for a room |
| `clear(roomId: string): void` | Deletes the session for a room |

### `SessionData`

```typescript
interface SessionData {
  sessionId: string | null;  // Claude session ID for --resume
  project: string;           // Active project name
}
```

### `class ClaudeRunner`

Executes prompts in Claude Code as a subprocess.

**Constructor:**

```typescript
new ClaudeRunner(
  config: ClaudeConfig,
  projectsConfig: ProjectsConfig,
  sessions: SessionStore,
  queue: SerialQueue,
)
```

**Methods:**

| Method | Description |
|--------|------------|
| `run(roomId: string, prompt: string): Promise<string>` | Executes a prompt and returns the response |

The `run` method:
1. Looks up the room's session to get the project and session_id
2. Builds the arguments: `-p`, `--output-format json`, `--max-turns`, `--resume`
3. Spawns the process with explicit env and closed stdin
4. Parses the JSON output
5. Saves the session_id for future messages
6. Returns the response text

---

## transcriber/

### `class GroqTranscriber`

Transcribes audio to text via the Groq API.

**Constructor:**

```typescript
new GroqTranscriber(config: GroqConfig)
```

**Methods and properties:**

| Member | Description |
|---------|------------|
| `transcribe(filePath: string): Promise<string>` | Transcribes an audio file |
| `available: boolean` (getter) | `true` if an API key is configured |

The `transcribe` method:
1. Reads the file from disk
2. Determines the MIME type by extension
3. Builds a FormData with file, model, response_format, temperature, language
4. POSTs to the Groq endpoint with Authorization bearer
5. Parses the response and returns the text

---

## queue/

### `class SerialQueue`

FIFO queue that executes one task at a time.

**Methods and properties:**

| Member | Description |
|---------|------------|
| `enqueue<T>(task: () => Promise<T>): Promise<T>` | Enqueues a task. Resolves when complete |
| `setChildProcess(cp: ChildProcess): void` | Associates a child process with the current task |
| `cancelCurrent(): boolean` | Sends SIGTERM to the current process |
| `length: number` (getter) | Number of pending tasks |
| `busy: boolean` (getter) | `true` if a task is running |

---

## matrix/

### `createMatrixClient(matrixConfig, botConfig): Promise<MatrixClientWrapper>`

Creates and validates a Matrix client. Configures auto-join and silences SDK logs.

### `MatrixClientWrapper`

```typescript
interface MatrixClientWrapper {
  client: MatrixClient;   // Raw matrix-bot-sdk instance
  userId: string;         // Bot user ID
  start(): Promise<void>; // Starts sync loop + prints device info for verification
  stop(): void;           // Stops the sync loop
  sendText(roomId: string, text: string): Promise<string>;    // Renders markdown to HTML
  sendNotice(roomId: string, text: string): Promise<string>;  // Unformatted notice
  setTyping(roomId: string, typing: boolean): Promise<void>;
  downloadMedia(mxcUrl: string, destPath: string): Promise<void>;                // Unencrypted media
  downloadEncryptedMedia(file: EncryptedFileInfo, destPath: string): Promise<void>; // E2EE media
}
```

### `EncryptedFileInfo`

Metadata for an encrypted file in an E2EE message. Corresponds to the `content.file` field of the Matrix event.

```typescript
interface EncryptedFileInfo {
  url: string;        // mxc:// URL of the encrypted file
  key: { kty: "oct"; key_ops: string[]; alg: "A256CTR"; k: string; ext: true };
  iv: string;         // Initialization vector
  hashes: Record<string, string>;  // SHA-256 hash of the encrypted content
  v: string;          // Encryption scheme version
}
```

Encrypted media downloads use the authenticated endpoint `/_matrix/client/v1/media/download/` (since matrix.org deprecated the legacy endpoint `/_matrix/media/v3/download/`) and decrypt with `Attachment.decrypt()` from the Rust crypto SDK.

---

## bridge/

### `class BridgeRunner`

Orchestrator for bridge mode (tmux + hooks).

**Constructor:**

```typescript
new BridgeRunner(config: AppConfig, matrix: MatrixClientWrapper, sessionStore: SessionStore)
```

**Methods:**

| Method | Description |
|--------|------------|
| `handleMessage(roomId: string, prompt: string): Promise<string \| null>` | Injects prompt into tmux and waits for response |
| `newSession(roomId: string): Promise<void>` | Destroys tmux session and clears state |
| `cancel(roomId: string): boolean` | Cancels the current task |
| `getStatus(roomId: string, lines?: number): { alive: boolean; output?: string }` | Status of the tmux session |
| `stop(): void` | Cleans up all sessions and the IPC server |

---

## ide/

### `class IdeRunner`

Orchestrator for IDE mode (MCP WebSocket + one-shot subprocess).

**Constructor:**

```typescript
new IdeRunner(config: AppConfig, matrix: MatrixClientWrapper, sessionStore: SessionStore)
```

**Methods:**

| Method | Description |
|--------|------------|
| `handleMessage(roomId: string, prompt: string): Promise<string \| null>` | Launches `claude -p --ide` and returns response |
| `newSession(roomId: string): Promise<void>` | Stops the room's MCP server and clears session |
| `cancel(roomId: string): boolean` | Cancels the current subprocess |
| `getStatus(roomId: string): { alive: boolean; connected: boolean }` | MCP server status |
| `handleDiffResponse(roomId: string, text: string): boolean` | Processes a diff response (y/n). Returns true if handled |
| `stop(): void` | Cleans up all MCP servers and cancels tasks |

### `class McpServer`

WebSocket server that implements the MCP (Model Context Protocol) version `2024-11-05`.

**Constructor:**

```typescript
new McpServer(workspaceFolders: string[], sessionName: string)
```

**Methods:**

| Method | Description |
|--------|------------|
| `start(): void` | Starts the WebSocket server and creates lockfile |
| `stop(): void` | Stops the server and removes lockfile |
| `connected: boolean` (getter) | True if Claude Code is connected |
| `sendToolResponse(requestId, content): void` | Sends tool response to Claude |
| `sendToolError(requestId, message): void` | Sends tool error to Claude |
| `storeDeferredResponse(uniqueKey, requestId): void` | Stores a deferred response |
| `completeDeferredResponse(uniqueKey, content): void` | Completes a deferred response |
| `sendNotification(method, params?): void` | Sends JSON-RPC notification |

**Emitted events:**

| Event | Parameters | Description |
|--------|-----------|-------------|
| `connected` | — | Claude Code connected to the WebSocket |
| `disconnected` | — | Claude Code disconnected |
| `tool_call` | `(requestId, toolName, args)` | Claude invokes a tool |

---

## utils/

### `createLogger(component: string)`

Returns a logger object with `debug`, `info`, `warn`, `error` methods. Logs are written to stderr with the format:

```
2024-01-15T10:30:00.000Z [INFO] [component] message
```

### `setLogLevel(level: string): void`

Sets the minimum log level. The levels are: `debug` < `info` < `warn` < `error`.

### `splitMessage(text: string, maxLength: number): string[]`

Splits a long text into chunks that don't exceed `maxLength`. Attempts to split at line breaks, then at spaces, and as a last resort does a hard cut.
