# Configuration

All configuration is loaded from environment variables. The bot validates required variables on startup and exits with a clear error if any are missing.

## Environment variables

### Required

| Variable | Description | Example |
|----------|------------|---------|
| `MATRIX_HOMESERVER_URL` | Matrix homeserver URL | `https://matrix.org` |
| `MATRIX_ACCESS_TOKEN` | Bot's access token (from programmatic login) | `mct_abc123...` |
| `MATRIX_ALLOWED_USER_ID` | Authorized Matrix user ID | `@username:matrix.org` |
| `PROJECTS` | Projects as `name=path` pairs separated by comma | `web=/home/user/web,api=/home/user/api` |
| `GROQ_API_KEY` | Groq API key for transcription | `gsk_abc123...` |

Additionally, you need **one** of these to authenticate Claude Code:

| Variable | Description |
|----------|------------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code OAuth token (obtained with `claude setup-token`) |
| `ANTHROPIC_API_KEY` | Direct Anthropic API key |

### Optional (with defaults)

| Variable | Default | Description |
|----------|---------|------------|
| `DEFAULT_PROJECT` | First project in `PROJECTS` | Active project on startup |
| `CLAUDE_BINARY_PATH` | `/usr/bin/claude` | Absolute path to the Claude binary |
| `CLAUDE_TIMEOUT` | `300000` (5 min) | Maximum timeout in ms per invocation |
| `CLAUDE_MAX_TURNS` | `25` | Maximum agentic turns per invocation |
| `MATRIX_ENABLE_E2EE` | `true` | Enable end-to-end encryption |
| `MATRIX_CRYPTO_STORAGE_PATH` | `./data/crypto` | Directory for E2EE keys (SQLite) |
| `GROQ_MODEL` | `whisper-large-v3-turbo` | Whisper model to use |
| `GROQ_ENDPOINT` | `https://api.groq.com/openai/v1/audio/transcriptions` | API endpoint |
| `GROQ_LANGUAGE` | `auto` | Audio language (ISO-639-1 or `auto`) |
| `MAX_MESSAGE_LENGTH` | `4096` | Maximum characters per Matrix message |
| `TMP_DIR` | `/tmp/matrix-claude-bot` | Directory for temporary files |
| `SESSIONS_FILE` | `./data/sessions.json` | Path to the sessions file |
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |

### Operation mode

| Variable | Default | Description |
|----------|---------|------------|
| `BOT_MODE` | `bot` | Operation mode: `bot`, `bridge` or `ide` |
| `CLAUDE_EXTRA_ARGS` | (empty) | Extra args for Claude in bridge/ide (e.g.: `--model,sonnet`) |
| `BRIDGE_SOCKET_DIR` | `/tmp` | Directory for IPC Unix sockets (bridge only) |
| `BRIDGE_HOOK_TIMEOUT` | `10000` | Hook timeout in ms (bridge only) |

**Available modes:**

- **`bot`** (default): one-shot subprocess `claude -p` per message. Simple, robust, low resource usage.
- **`bridge`**: interactive Claude in tmux with hooks. Allows dynamically approving tools from Matrix. Requires tmux installed.
- **`ide`** (recommended): native MCP protocol via WebSocket. Same reliability as bot + IDE protocol interactivity. Supports diff review from Matrix.

## PROJECTS format

The `PROJECTS` variable uses a comma-separated pairs format:

```
PROJECTS=name1=/absolute/path/1,name2=/absolute/path/2
```

Rules:
- Names are normalized to lowercase
- Paths must be absolute
- At least one project is required
- Spaces around commas and `=` are ignored

Valid examples:

```bash
# Single project
PROJECTS=web=/home/user/webapp

# Multiple projects
PROJECTS=frontend=/home/user/frontend, backend=/home/user/backend, infra=/home/user/terraform

# With spaces (ignored)
PROJECTS= web = /home/user/web , api = /home/user/api
```

## .env file

For local development, create a `.env` file in the project root:

```bash
cp .env.example .env
chmod 600 .env  # protect tokens
```

The `.env` file is NOT loaded automatically. To load the variables:

```bash
# Option 1: bash source
bash -c 'set -a && source .env && set +a && npx tsx src/index.ts'

# Option 2: PM2 ecosystem (recommended for production)
```

## PM2 configuration

For production with PM2, copy and edit the example file:

```bash
cp ecosystem.config.example.cjs ecosystem.config.cjs
chmod 600 ecosystem.config.cjs
```

```javascript
module.exports = {
  apps: [{
    name: "matrix-claude-bot",
    script: "dist/index.js",
    cwd: "/opt/matrix-claude-bot",
    env: {
      HOME: "/root",
      MATRIX_HOMESERVER_URL: "https://matrix.org",
      MATRIX_ACCESS_TOKEN: "mct_your_token",
      MATRIX_ALLOWED_USER_ID: "@your_username:matrix.org",
      MATRIX_ENABLE_E2EE: "true",
      MATRIX_CRYPTO_STORAGE_PATH: "./data/crypto",
      PROJECTS: "myproject=/home/user/myproject",
      GROQ_API_KEY: "gsk_your_key",
      CLAUDE_CODE_OAUTH_TOKEN: "your_oauth_token",
      LOG_LEVEL: "info",
    },
    max_memory_restart: "200M",
    restart_delay: 5000,
    max_restarts: 10,
    autorestart: true,
  }],
};
```

Notes:
- `HOME` is necessary so Claude can find `~/.claude/settings.json`
- `max_memory_restart` restarts the bot if it consumes more than 200MB
- `restart_delay` waits 5 seconds between restarts to avoid loops
- `MATRIX_CRYPTO_STORAGE_PATH` must be persistent — if deleted, E2EE keys are lost

## Type schema

The configuration is fully typed in `src/config/schema.ts`:

```typescript
interface AppConfig {
  matrix: MatrixConfig;    // homeserverUrl, accessToken, allowedUserId, enableE2ee, cryptoStoragePath
  projects: ProjectsConfig; // projects (map), defaultProject
  claude: ClaudeConfig;     // binaryPath, timeout, maxTurns
  groq: GroqConfig;         // apiKey, model, endpoint, language
  bot: BotConfig;           // maxMessageLength, tmpDir, sessionsFile, logLevel
  bridge: BridgeConfig;     // mode, claudeArgs, socketDir, hookTimeout
}
```

Each interface is documented with inline JSDoc. See `src/config/schema.ts` for the complete reference.
