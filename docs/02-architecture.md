# Architecture

## Overview

The bot follows a modular architecture with clear separation of responsibilities and supports three operation modes:

```
src/
 |-- config/         Configuration loading and validation
 |-- matrix/         Connection to the Matrix homeserver + E2EE
 |-- claude/         Claude Code execution and sessions (bot mode)
 |-- bridge/         Bridge mode: tmux + hooks + IPC socket
 |-- ide/            IDE mode: MCP WebSocket + JSON-RPC 2.0
 |-- transcriber/    Audio transcription via Groq
 |-- queue/          Serial task queue
 |-- utils/          Logger, message splitting
 '-- index.ts        Entry point, wiring and event handlers
```

## Operation modes

The bot supports three modes, selected with `BOT_MODE`:

| Mode | Variable | Description |
|------|----------|-------------|
| **Bot** | `BOT_MODE=bot` | One-shot subprocess: `claude -p` per message. Simple and robust. Default. |
| **Bridge** | `BOT_MODE=bridge` | Interactive Claude in tmux. Hooks (PreToolUse, Notification, Stop) are forwarded via IPC to Matrix. Allows dynamically approving/rejecting tools. |
| **IDE** | `BOT_MODE=ide` | Claude Code's native MCP protocol via WebSocket (the same one used by VS Code, JetBrains, and Emacs). Combines the reliability of the one-shot subprocess with the interactivity of the IDE protocol. **Recommended.** |

### Bot Mode — One-shot subprocess

```
User -> Matrix (E2EE) -> Bot -> claude -p "prompt" --output-format json -> response -> Matrix
```

- Launches `claude -p` as a subprocess for each message
- `stdin: 'ignore'` to prevent Claude from hanging
- `--resume <session_id>` to maintain continuity
- Serial queue: only 1 process at a time

### Bridge Mode — tmux + hooks

```
User -> Matrix (E2EE) -> Bot -> tmux send-keys "prompt" -> Interactive Claude
                                       |
                                   Hooks (PreToolUse, Notification, Stop)
                                       |
                                   IPC Unix Socket -> Bot -> Matrix
```

- Claude runs interactively inside tmux
- Claude Code hooks notify the bot via IPC socket
- Tool permissions are approved/rejected from Matrix
- Reads JSONL transcripts to obtain responses

### IDE Mode — MCP WebSocket (recommended)

```
User -> Matrix (E2EE) -> Bot -> claude -p "prompt" --output-format json --ide
                                       |                                    |
                                       |                          Claude connects to MCP server
                                       |                                    |
                                   WebSocket MCP Server <------- JSON-RPC 2.0
                                       |
                                   Tools: openDiff, getDiagnostics, openFile...
                                       |
                                   Diff review -> Matrix -> User approves/rejects
```

- Combines one-shot subprocess (reliability) with IDE protocol (interactivity)
- MCP WebSocket server on a random port with lockfile at `~/.claude/ide/{PORT}.lock`
- Claude Code discovers the server via lockfile and connects automatically with `--ide`
- IDE protocol tools (openDiff, openFile, getDiagnostics) are forwarded to Matrix
- Diffs are presented to the user for approval/rejection
- Keepalive ping every 30s

## Text message flow (with E2EE)

```
1. Matrix sync receives m.room.encrypted event
2. The SDK (RustSdkCryptoStorageProvider) decrypts with Megolm
3. room.decrypted_event is emitted, then room.message with the decrypted event
4. Auth guard: ignored if sender != MATRIX_ALLOWED_USER_ID
5. The msgtype and body are extracted from the event
6. If it starts with "!" -> the corresponding command is executed
7. If not -> it is sent to handlePrompt()
8. handlePrompt() enqueues the task in SerialQueue
9. The typing indicator is activated
10. Depending on the mode:
    - Bot: ClaudeRunner.run() launches claude -p "prompt" --output-format json --resume <session_id>
    - Bridge: tmux send-keys injects the prompt into the interactive session
    - IDE: IdeRunner.handleMessage() launches claude -p "prompt" --output-format json --ide --resume <session_id>
11. The response is parsed (JSON in bot/ide, JSONL transcript in bridge)
12. The session_id is saved for next time
13. Markdown is rendered to HTML with marked
14. The response is split into chunks of 4096 chars
15. The chunks are sent automatically encrypted to the room
```

## Audio message flow (with E2EE)

```
1. Matrix sync receives m.room.encrypted event with msgtype m.audio
2. SDK decrypts the event
3. It detects whether the media is encrypted (content.file) or plain (content.url):
   - E2EE: downloaded via /_matrix/client/v1/media/download/ (authenticated endpoint)
           and decrypted with Attachment.decrypt() from the Rust crypto SDK
   - Plain: downloaded via client.downloadContent() with mxc:// URL
4. The file is sent to Groq API (whisper-large-v3-turbo)
5. Groq returns the transcribed text
6. The transcription is shown to the user
7. The transcribed text is processed as a prompt (text flow, step 7+)
```

## Image flow (with E2EE)

```
1. Matrix sync receives m.room.encrypted event with msgtype m.image
2. SDK decrypts the event
3. The image is downloaded and decrypted (same process as audio)
4. It is saved to /tmp/matrix-claude-bot/img_<timestamp>.<ext>
5. The prompt is constructed: "Read the image at /tmp/img_xxx.jpg and respond: <caption>"
6. Claude Code reads the image from disk and responds
```

## Key components

### SerialQueue (`src/queue/serial-queue.ts`)

Only one Claude process can run at a time. If messages arrive while another is being processed, they are queued in FIFO order.

```
Message 1 -> [running] --------> response 1
Message 2 -> [queue pos 1] -> [running] -> response 2
Message 3 -> [queue pos 2] -> [queue pos 1] -> [running] -> response 3
```

The queue also allows canceling the current task via `!cancel`, which sends SIGTERM to the child process.

### SessionStore (`src/claude/session.ts`)

Persists the Claude Code `session_id` per Matrix room. This allows consecutive messages to maintain conversation context using `--resume`.

Data is stored in a JSON file (`data/sessions.json`):

```json
{
  "!abc123:matrix.org": {
    "sessionId": "550e8400-e29b-41d4-a716-446655440000",
    "project": "myproject"
  }
}
```

### ClaudeRunner (`src/claude/runner.ts`)

Launches Claude Code as a subprocess with `child_process.spawn()`. Critical design decisions:

1. **stdin: 'ignore'** — Without this, Claude hangs indefinitely waiting for input from a pipe that never delivers.
2. **Explicit env** — PM2/systemd do not load `.bashrc`, so HOME, PATH, and authentication tokens are passed manually.
3. **Absolute path to binary** — Avoids `ENOENT` errors when PATH does not include Claude's directory.
4. **Configurable timeout** — Kills the process if it takes too long (default: 5 minutes).

### GroqTranscriber (`src/transcriber/groq.ts`)

Sends audio to the Groq API for transcription. Uses Node 18+ native `fetch` and `FormData` for the multipart, with no external dependencies.

Supported formats: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm.

### MatrixClientWrapper (`src/matrix/client.ts`)

Wrapper around `matrix-bot-sdk` that exposes a simplified interface:

- `start()` / `stop()` — Starts/stops the sync loop (with E2EE if enabled)
- `sendText()` / `sendNotice()` — Sends messages with markdown rendered to HTML (automatically encrypted in E2EE rooms)
- `setTyping()` — Typing indicator (best-effort)
- `downloadMedia()` — Downloads unencrypted files from `mxc://` URLs
- `downloadEncryptedMedia()` — Downloads and decrypts E2EE files (audio, images, attachments)

Includes `AutojoinRoomsMixin` so the bot accepts invitations automatically.

On startup, it prints the bot's Device ID in logs to facilitate manual verification from Element.

When E2EE is enabled:
- A `RustSdkCryptoStorageProvider` is created that stores Olm/Megolm keys in SQLite
- The SDK automatically decrypts `m.room.encrypted` events before emitting `room.message`
- The SDK automatically encrypts when sending messages to encrypted rooms
- Key exchange (key claim, key upload) is transparent
- Encrypted media (audio, images) are downloaded via the authenticated endpoint `/_matrix/client/v1/media/download/` and decrypted with `Attachment.decrypt()` from the Rust crypto SDK

### BridgeRunner (`src/bridge/bridge-runner.ts`)

Orchestrator for bridge mode. Manages:

- **TmuxManager**: creates/destroys tmux sessions per Matrix room
- **IpcServer**: Unix socket that receives payloads from Claude Code hooks
- **HookInjector**: generates the `--settings` configuration with hooks that forward events to the IPC socket
- **TranscriptReader**: reads the latest response from Claude's JSONL transcript

### IdeRunner (`src/ide/ide-runner.ts`)

Orchestrator for IDE mode. Manages:

- **McpServer**: per-room WebSocket MCP server, implements the JSON-RPC 2.0 protocol
- **One-shot subprocess**: `claude -p "prompt" --output-format json --ide` per message
- **Diff review**: forwards diffs to Matrix and waits for user approval/rejection
- **Deferred responses**: stores request IDs to complete when the user responds

### McpServer (`src/ide/mcp-server.ts`)

WebSocket server that implements the MCP (Model Context Protocol) version `2024-11-05`. Same protocol used by VS Code, JetBrains, and Emacs (monet.el).

- Listens on a random port on `127.0.0.1`
- Creates lockfile at `~/.claude/ide/{PORT}.lock` so Claude Code can discover it
- Handles JSON-RPC 2.0: `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`
- Exposed tools: `openFile`, `saveDocument`, `getDiagnostics`, `openDiff`, `getWorkspaceFolders`, `getCurrentSelection`, `getLatestSelection`, `checkDocumentDirty`, `getOpenEditors`, `closeAllDiffTabs`, `close_tab`
- Simple tools are resolved locally; complex tools (`openDiff`) are forwarded to Matrix
- Keepalive: `notifications/tools/list_changed` every 30s

### E2EE: Key flow

```
1. Bot starts -> crypto.prepare() initializes OlmMachine
2. Device keys and one-time keys are uploaded to the homeserver
3. When joining an E2EE room, Megolm keys are exchanged via to-device messages
4. Each sync processes to-device messages first (to have keys before events)
5. Then processes room events, decrypting m.room.encrypted ones
6. When sending, encrypts with the room's Megolm keys
```

## Design patterns

### Inspired by the Telegram bot

| Pattern | Origin | Adaptation |
|---------|--------|-----------|
| Serial queue | Telegram tutorial | Same logic, typed with generics |
| Sessions with `--resume` | Telegram tutorial | Per Matrix room instead of Telegram chat |
| stdin `'ignore'` | Telegram tutorial | Critical — without this Claude hangs |
| Explicit env | Telegram tutorial | Same technique for PM2 |
| Message splitting | Telegram tutorial | Same 4096 char limit |
| Configurable timeout | Telegram tutorial | Via env var instead of constant |

### Inspired by Jackpoint

| Pattern | Origin | Adaptation |
|---------|--------|-----------|
| matrix-bot-sdk | Jackpoint | Same SDK, npm-published version |
| AutojoinRoomsMixin | Jackpoint | So the bot accepts DMs |
| Typing indicators | Jackpoint | While Claude is working |
| Silence SDK logs | Jackpoint | LogService.setLevel(WARN) |

### Original improvements

| Improvement | Description |
|-------------|------------|
| TypeScript strict | Types throughout the codebase |
| Config via env vars | Everything configurable, sensible defaults |
| Groq API | No local whisper.cpp (no compiling C++, no 388MB RAM) |
| Native E2EE | Full end-to-end encryption support |
| E2EE media | Download and decryption of encrypted audio/images |
| Markdown HTML | Markdown to HTML rendering with `marked` in Matrix messages |
| Three modes | Bot (one-shot), Bridge (tmux+hooks), IDE (MCP WebSocket) |
| MCP protocol | Same IDE protocol as VS Code/JetBrains/Emacs |
| Unit tests | 23 tests with vitest |
| Modular | Each component in its own directory with barrel exports |
