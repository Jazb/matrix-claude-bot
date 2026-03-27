# Quick Start Guide

A Matrix bot that acts as a remote Claude Code terminal. You send text, audio, or images from your phone (Element, FluffyChat, any Matrix client) and Claude Code responds as if you were in the terminal. Supports end-to-end encryption (E2EE) and three operation modes.

## What you will set up

```
Any Matrix client (mobile/web/desktop)
    |
    v  long-poll sync (E2EE)
[Node.js Bot + matrix-bot-sdk]  --- PM2/systemd --- your server
    |
    |-- Text (encrypted) ---> decrypt --> claude -p "..." --output-format json [--ide]
    |-- Audio (OGG/MP3/...) --> decrypt+decipher --> Groq API (whisper) --> text --> claude -p
    '-- Image --> decrypt+decipher --> /tmp/ --> claude -p "Read image at /tmp/x.jpg and ..."
                                  |
                           cwd: your project
                           --resume <session_id> (continuity between messages)
```

- **Three modes**: bot (one-shot), bridge (tmux+hooks), IDE (MCP WebSocket, recommended).
- **Full E2EE**: end-to-end encryption with Megolm/Olm via Rust crypto SDK, including download and decryption of media (audio, images).
- **Rendered Markdown**: responses with HTML formatting in Matrix.
- **Long-poll sync** (no webhooks): no need to open ports or configure a reverse proxy.
- **Serial queue**: only 1 Claude task at a time (ideal for small servers).
- **Persistent session**: each message continues the previous conversation with `--resume`.
- **Cloud transcription**: Groq API with Whisper, no local compilation needed.

## Prerequisites

- A server with Claude Code installed and authenticated (`claude login` or `claude setup-token`)
- Node.js 18+ and npm
- A Matrix account for the bot (separate from yours)
- A Groq API key (free at https://console.groq.com/keys)

## Step 1: Create the bot's Matrix account

1. Go to https://app.element.io or your preferred Matrix client
2. Register a new account for the bot (e.g.: `your-bot`, `claude-bot`, etc.)
3. Note the **username** and **password** — you will need them for the programmatic login

**Important:** Do NOT use the Element access token directly. You need to create a **dedicated device** for the bot via programmatic login. If you use the Element token, the bot inherits that device ID and later when enabling E2EE the crypto keys will conflict (see common errors section).

## Step 2: Obtain access token with a dedicated device

Use Node.js to perform a login that creates a device owned by the bot:

```bash
node -e '
const body = JSON.stringify({
  type: "m.login.password",
  identifier: { type: "m.id.user", user: "YOUR_BOT_USERNAME" },
  password: "YOUR_BOT_PASSWORD",
  device_id: "CLAUDE_BOT",
  initial_device_display_name: "Matrix Claude Bot"
});
fetch("https://YOUR_HOMESERVER/_matrix/client/v3/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body
}).then(r => r.json()).then(d => console.log(JSON.stringify(d, null, 2)));
'
```

The response contains:

```json
{
  "access_token": "mct_xxxxx",
  "device_id": "CLAUDE_BOT",
  "user_id": "@your-bot:matrix.org"
}
```

Copy the `access_token`. This token is associated with the `CLAUDE_BOT` device, which is exclusive to the bot and will not conflict with Element sessions.

**Why not use curl:** If the password contains special characters (`!`, `$`, etc.), bash interprets them incorrectly. Node.js with `fetch` avoids these escaping issues.

## Step 3: Get your Matrix user ID

Your user ID is your `@username:server.com`. You can find it in Element under Settings > General.

## Step 4: Get a Groq API key

1. Go to https://console.groq.com/keys
2. Create a new API key
3. Copy the value (`gsk_...`)

Groq offers a free tier with generous limits. The `whisper-large-v3-turbo` model costs $0.04/hour of audio.

## Step 5: Install the bot

```bash
# Clone or copy the project
cd /opt
cp -r /path/to/matrix-claude-bot .
cd matrix-claude-bot

# Install dependencies (includes the native crypto SDK)
npm install

# Compile TypeScript
npm run build
```

## Step 6: Configure

Copy the example file and fill in your values:

```bash
cp .env.example .env
chmod 600 .env  # protect tokens
```

Edit `.env` with your data:

```bash
# Matrix
MATRIX_HOMESERVER_URL=https://matrix.org
MATRIX_ACCESS_TOKEN=mct_your_token_from_step_2
MATRIX_ALLOWED_USER_ID=@your_username:matrix.org

# E2EE (enabled by default)
MATRIX_ENABLE_E2EE=true
MATRIX_CRYPTO_STORAGE_PATH=./data/crypto

# Projects
PROJECTS=myproject=/home/user/my-project

# Groq
GROQ_API_KEY=gsk_your_api_key

# Claude
CLAUDE_BINARY_PATH=/usr/local/bin/claude  # adjust with: which claude

# Claude auth (one of these)
CLAUDE_CODE_OAUTH_TOKEN=your_oauth_token
# ANTHROPIC_API_KEY=sk-ant-your-key

# Operation mode (bot | bridge | ide)
BOT_MODE=ide  # recommended for interactivity
```

## Step 7: Configure Claude Code permissions

Claude Code needs pre-authorized permissions because there is no interactive terminal to approve them.

**Option A: Global permissions** — Edit `~/.claude/settings.json` (affects all Claude sessions for the user):

```json
{
  "permissions": {
    "allow": [
      "Bash", "Edit", "Write", "Read",
      "Glob", "Grep", "WebSearch", "WebFetch",
      "NotebookEdit", "Task"
    ]
  }
}
```

**Option B: Per-project permissions** — Create `.claude/settings.json` inside each project configured in `PROJECTS`. This is more secure because it limits permissions to the project scope.

Adjust the permissions according to your needs.

## Step 8: Run

### Development (with hot-reload)

```bash
# Load variables and run
bash -c 'set -a && source .env && set +a && npx tsx src/index.ts'
```

Or in background with logs to a file:

```bash
bash -c 'set -a && source .env && set +a && npx tsx src/index.ts &>/tmp/matrix-bot.log &'

# View logs
tail -f /tmp/matrix-bot.log
```

### Production (compiled)

```bash
npm run build
bash -c 'set -a && source .env && set +a && node dist/index.js'
```

### With PM2 (recommended for production)

```bash
npm install -g pm2
pm2 startup systemd

cp ecosystem.config.example.cjs ecosystem.config.cjs
chmod 600 ecosystem.config.cjs
# Edit ecosystem.config.cjs with your values

npm run build
pm2 start ecosystem.config.cjs
pm2 save
```

## Step 9: Test

1. Open your Matrix client with your personal account
2. Start a **DM** with the bot account (e.g.: `@your-bot:matrix.org`)
3. The bot accepts the invitation automatically (AutojoinMixin)
4. **First message:** Type "Hello" — the first message may take a few seconds while E2EE keys are exchanged
5. You should see the typing indicator and then Claude's response
6. **Continuity:** Send a second message — it maintains conversation context
7. **New session:** Type `!new` — clears the session
8. **Audio:** Send a voice note — it gets transcribed with Groq and responded to
9. **Image:** Send a photo with a caption — Claude analyzes it
10. **Switch project:** `!project othername`

## Available commands

| Command | Description | Modes |
|---------|------------|-------|
| `!help` | Show help | all |
| `!new` | New session (clears context) | all |
| `!project NAME` | Switch project | all |
| `!status` | Session info, queue and configuration | all |
| `!cancel` | Cancel the running task | all |
| `!lines [N]` | View last N lines of the terminal | bridge only |

In IDE mode, replying **y** or **n** to a diff presented by Claude applies or rejects the change.

## Verify that E2EE is working

In Element, when you open the DM with the bot, you should see the shield icon on messages. If the bot responds and you see the shield, E2EE is working correctly.

### Verify the bot's device

On startup, the bot prints its Device ID in the logs:

```
━━━ Device Verification Info ━━━
  User:      @your-bot:matrix.org
  Device ID: CLAUDE_BOT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

To remove the "unverified device" warning in Element:

1. In Element, click on the bot's profile > Sessions
2. Click on the `CLAUDE_BOT` device
3. Select "Manually verify by text" and confirm the Device ID

**Note:** Do not use "Start verification" — `matrix-bot-sdk` does not implement interactive verification. The warning is cosmetic; encryption works correctly without verification.

If you see `!status` and it says `Processing: No`, the bot is idle and ready to receive messages.
