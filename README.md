# Matrix Claude Bot

Matrix bot that runs [Claude Code](https://docs.anthropic.com/en/docs/claude-code) as a service. Send text, voice messages, or images from any Matrix client and get Claude Code responses — with E2EE, project switching, and three operating modes.

## How It Works

```
Matrix client (Element, FluffyChat, ...)
      │
      ▼
Matrix Claude Bot ──► Claude Code subprocess
      │                     │
      ├─ Bot mode:     one-shot per message
      ├─ Bridge mode:  persistent tmux + hooks
      └─ IDE mode:     MCP WebSocket protocol
```

> **This is a standalone bot, not a channel plugin.** It runs as a service (daemon) and spawns its own Claude Code processes. No terminal session required — deploy it on a server and interact from anywhere.

## Features

- **Three operating modes**: bot (simple), bridge (interactive), IDE (full protocol)
- **E2EE**: end-to-end encryption with auto cross-signing and verification
- **Voice messages**: automatic transcription via Groq Whisper
- **Project switching**: multiple projects, switch with `/project name`
- **Session persistence**: resume conversations across restarts
- **Message splitting**: long responses split to fit Matrix limits
- **Serial queue**: messages processed in order, no race conditions

## Requirements

- Node.js 22+
- Claude Code CLI installed and authenticated
- Matrix account with E2EE enabled
- [Groq API key](https://console.groq.com/keys) (optional, for voice messages)

## Quick Start

```bash
# Clone and install
git clone https://github.com/jatkzu/matrix-claude-bot.git
cd matrix-claude-bot
npm install

# Configure
cp .env.example .env
# Edit .env with your credentials

# Build and run
npm run build
npm start

# Or run in development
npm run dev
```

## Configuration

Copy `.env.example` and fill in:

```bash
# Required
MATRIX_HOMESERVER_URL=https://matrix.org
MATRIX_ACCESS_TOKEN=syt_...
MATRIX_ALLOWED_USER_ID=@you:matrix.org
PROJECTS=myproject=/home/user/myproject

# Claude auth (one of these)
CLAUDE_CODE_OAUTH_TOKEN=your_oauth_token
# ANTHROPIC_API_KEY=sk-ant-...

# Voice transcription (optional)
GROQ_API_KEY=gsk_...

# Operating mode (optional, default: bot)
# BOT_MODE=bot        # one-shot subprocess
# BOT_MODE=bridge     # persistent tmux + hooks
# BOT_MODE=ide        # MCP WebSocket (recommended)
```

See [`.env.example`](.env.example) for all options.

## Operating Modes

### Bot Mode (default)

Spawns `claude -p "prompt"` per message. Stateless, reliable, low overhead. Best for simple Q&A.

### Bridge Mode

Runs Claude continuously in a tmux session. Hook events (tool approvals, questions) are forwarded to Matrix. You approve/deny tools from your phone.

```bash
BOT_MODE=bridge
```

Requires `tmux` installed.

### IDE Mode (recommended)

Uses Claude Code's native MCP WebSocket protocol — the same protocol used by VS Code, JetBrains, and Emacs integrations. Combines subprocess reliability with interactive tool approval.

```bash
BOT_MODE=ide
```

## Bot Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/project name` | Switch active project |
| `/projects` | List configured projects |
| `/new` | Start fresh conversation |
| `/status` | Show current session info |

## Voice Messages

Audio messages (`m.audio`) are automatically transcribed via Groq Whisper. The transcription is displayed in chat, then processed as a text message.

Supports: OGG, MP3, WAV, FLAC, WebM, M4A, MP4

## Project Structure

```
src/
├── index.ts              # Entry point, Matrix event handlers
├── config/
│   ├── schema.ts         # Configuration schema (Zod)
│   └── loader.ts         # Environment variable loader
├── matrix/
│   └── client.ts         # Matrix SDK client, E2EE, auto-verification
├── claude/
│   ├── runner.ts         # Claude subprocess spawner
│   └── session.ts        # Session state management
├── transcriber/
│   └── groq.ts           # Groq Whisper speech-to-text
├── bridge/
│   ├── bridge-runner.ts  # Tmux + hook orchestrator
│   ├── ipc-server.ts     # Unix socket for hook events
│   ├── hook-injector.ts  # Hook settings generator
│   └── tmux-manager.ts   # tmux send-keys injection
├── ide/
│   ├── ide-runner.ts     # WebSocket MCP server lifecycle
│   └── mcp-server.ts     # MCP JSON-RPC implementation
├── queue/
│   └── serial-queue.ts   # Serial message processing
└── utils/
    ├── logger.ts         # Logging
    └── split-message.ts  # Message splitting for Matrix limits
```

## Deployment

### PM2 (recommended)

```bash
cp ecosystem.config.example.cjs ecosystem.config.cjs
# Edit with your settings
pm2 start ecosystem.config.cjs
```

### systemd

```ini
[Unit]
Description=Matrix Claude Bot
After=network.target

[Service]
Type=simple
User=bot
WorkingDirectory=/opt/matrix-claude-bot
ExecStart=/usr/bin/node dist/index.js
Restart=always
EnvironmentFile=/opt/matrix-claude-bot/.env

[Install]
WantedBy=multi-user.target
```

## Testing

```bash
npm test              # run tests
npm run test:watch    # watch mode
npm run typecheck     # type checking
npm run lint          # linting
```

## Documentation

Detailed documentation is available in the [`docs/`](docs/) directory in both English and Spanish:

| # | English | Español |
|---|---------|---------|
| 1 | [Quick Start](docs/01-quick-start.md) | [Guía de inicio rápido](docs/01-guia-inicio-rapido.md) |
| 2 | [Architecture](docs/02-architecture.md) | [Arquitectura](docs/02-arquitectura.md) |
| 3 | [Configuration](docs/03-configuration.md) | [Configuración](docs/03-configuracion.md) |
| 4 | [Groq Transcription](docs/04-groq-transcription.md) | [Transcripción Groq](docs/04-transcripcion-groq.md) |
| 5 | [Common Errors](docs/05-common-errors.md) | [Errores comunes](docs/05-errores-comunes.md) |
| 6 | [Internal API Reference](docs/06-internal-api-reference.md) | [Referencia API interna](docs/06-referencia-api-interna.md) |
| 7 | [Tests](docs/07-tests-en.md) | [Tests](docs/07-tests.md) |
| 8 | [Production Deployment](docs/08-production-deployment.md) | [Despliegue producción](docs/08-despliegue-produccion.md) |
| 9 | [Future Improvements](docs/09-future-improvements.md) | [Mejoras futuras](docs/09-mejoras-futuras.md) |

## License

MIT
