# Common Errors and Solutions

This section documents real problems encountered while setting up and operating the bot, along with their causes and solutions. It includes errors discovered during the development of the original Telegram bot and E2EE-specific problems found during production testing.

## 1. Claude Hangs Indefinitely

**Symptom:** You send a message, the bot shows the typing indicator but never responds. In the logs you see `Running prompt in project "..."` and then silence.

**Cause:** When you use `child_process.spawn()` to launch Claude, stdin defaults to `pipe`. Claude detects that open pipe and interprets it as pending input. It waits forever. No error. No output. It just blocks.

**Solution:** The bot already has this resolved. If you modify `claude/runner.ts`, make sure to keep:

```typescript
const child = spawn(binaryPath, args, {
  cwd,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],  // 'ignore' closes stdin
});
```

The `'ignore'` in position 0 (stdin) is critical.

## 2. "Not logged in" — PM2 Doesn't Load .bashrc

**Symptom:** Claude responds with `"Not logged in"` or asks for login.

**Cause:** PM2 doesn't execute `.bashrc` or `.profile` when starting processes. If your `CLAUDE_CODE_OAUTH_TOKEN` is defined there, the child process doesn't see it.

**Solution:** Put all environment variables in `ecosystem.config.cjs` inside the `env` object. Don't rely on `.bashrc`.

```javascript
env: {
  HOME: "/root",
  CLAUDE_CODE_OAUTH_TOKEN: "your_token",
  // ... rest of variables
}
```

## 3. Claude Can't Find settings.json

**Symptom:** Claude asks for permissions interactively (and hangs because there's no terminal).

**Cause:** Without `HOME` in the environment variables, Claude doesn't know where to look for `~/.claude/settings.json`.

**Solution:** Make sure `HOME` is defined in `ecosystem.config.cjs`. The bot already includes it in the env passed to spawn, but it must point to the correct home directory of the user who has `~/.claude/settings.json` configured.

## 4. Error: spawn /usr/bin/claude ENOENT

**Symptom:** `Error: spawn /usr/bin/claude ENOENT` — Node.js can't find the binary.

**Cause:** Claude is not installed or is at a different path. The default is `/usr/bin/claude` but it may be elsewhere.

**Solution:** Find the real path and configure it:

```bash
which claude
# /home/user/.local/bin/claude

# In your .env or ecosystem.config.cjs:
CLAUDE_BINARY_PATH=/home/user/.local/bin/claude
```

## 5. The Bot Receives Events but Doesn't Respond (E2EE: m.room.encrypted)

**Symptom:** In the logs you see `[room.event] type=m.room.encrypted` but a `[room.message]` never arrives. The bot auto-joined the room but ignores messages.

**Cause:** DMs on matrix.org (and many homeservers) have E2EE enabled by default. Without crypto support, the bot receives encrypted events it can't decrypt, so it never emits `room.message`.

**Solution:** Make sure E2EE is enabled (it's the default):

```bash
MATRIX_ENABLE_E2EE=true
MATRIX_CRYPTO_STORAGE_PATH=./data/crypto
```

And that `@matrix-org/matrix-sdk-crypto-nodejs` is installed:

```bash
npm ls @matrix-org/matrix-sdk-crypto-nodejs
```

## 6. E2EE: "One time key already exists" on Startup

**Symptom:** The bot crashes on startup with:

```
MatrixError: M_UNKNOWN: One time key signed_curve25519:AAAAAAAAAA4 already exists
```

**Cause:** This happens when the bot reuses a device ID that already has one-time keys (OTK) uploaded to the server, but the local crypto store is new or was deleted. The SDK generates new keys that conflict with the old ones on the server.

Typical scenario:
1. You create the bot account in Element (this creates a device with OTK)
2. You copy the access token from Element to the bot
3. You enable E2EE — the bot inherits Element's device but with different keys
4. Conflict error

**Solution:** Create a **dedicated device** for the bot via programmatic login:

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

Use the `access_token` from this response in your `.env`. Then clean the crypto store:

```bash
rm -rf ./data/crypto ./data/matrix-storage.json
```

And restart the bot. The `CLAUDE_BOT` device starts clean without OTK conflicts.

**Prevention:** Always create the bot account and then do a programmatic login with a custom `device_id` before enabling E2EE. Don't use tokens from Element.

## 7. E2EE: "Can't find the room key to decrypt the event"

**Symptom:** In the logs you see:

```
[E2EE] Failed to decrypt event in !room:server from @user:server: Can't find the room key to decrypt the event
```

**Cause:** The bot doesn't have the Megolm keys to decrypt messages that were sent **before** the bot had E2EE configured, or before joining the room. This is normal behavior — messages encrypted before the bot has the keys cannot be decrypted retroactively.

**Solution:** This only affects historical messages. **New** messages sent after the bot is online with E2EE will work correctly. The bot exchanges keys automatically during sync.

If you need to clear the error from the first startup, simply ignore the initial decryption failures.

## 8. The Bot Doesn't Respond to My Messages

**Symptom:** The bot is online but ignores your messages.

**Possible causes:**

1. **Incorrect User ID:** `MATRIX_ALLOWED_USER_ID` doesn't match your Matrix user ID exactly. It must include the server: `@user:matrix.org` (not just `user`).

2. **The bot is not in the room:** You need to invite the bot to the room or send it a DM. Thanks to `AutojoinRoomsMixin`, the bot accepts invitations automatically.

3. **The bot is processing an old event:** On startup, matrix-bot-sdk does an initial sync. If there are pending old events, it may seem unresponsive. Wait a few seconds.

4. **E2EE is not configured:** See error #5.

**Diagnosis:** Start with `LOG_LEVEL=debug` and look in the logs for:
- `[room.event]` — Confirms the bot receives events
- `[room.message]` — Confirms it decrypts them correctly
- `sender=@your_user:...` — Confirms it's your user ID

## 9. Timeout on Long Responses

**Symptom:** The bot responds with "Claude timed out" for complex prompts.

**Solution:** Increase the timeout:

```bash
CLAUDE_TIMEOUT=600000  # 10 minutes
```

You can also adjust `CLAUDE_MAX_TURNS` if Claude needs more agentic iterations.

## 10. Transcription Fails with Error 401

**Symptom:** `Groq API error (401): ...`

**Cause:** Invalid or expired Groq API key.

**Solution:** Generate a new key at https://console.groq.com/keys and update `GROQ_API_KEY`.

## 11. Transcription Fails with Error 413

**Symptom:** `Groq API error (413): Request Entity Too Large`

**Cause:** The audio file exceeds the 25 MB limit (free tier) or 100 MB (dev tier).

**Solution:** Send shorter audio clips. Typical mobile voice notes are well below this limit.

## 12. Truncated or Incomplete Messages

**Symptom:** Claude's response appears truncated.

**Cause:** Matrix has a ~65KB limit per event, but the bot splits at 4096 characters by default (for readability). If Claude returns very long responses, they are split into multiple messages.

This is not an error — it's expected behavior. If you want larger chunks:

```bash
MAX_MESSAGE_LENGTH=8192
```

## 13. The Bot Restarts Constantly

**Symptom:** `pm2 status` shows many restarts.

**Possible causes:**

1. **Invalid token:** The bot fails to authenticate and exits. Check `MATRIX_ACCESS_TOKEN`.
2. **No write permissions:** The bot needs to be able to write to `SESSIONS_FILE`, `TMP_DIR`, and `MATRIX_CRYPTO_STORAGE_PATH`.
3. **Memory:** If the server has low RAM and Claude + the bot exceed the limit, PM2 restarts (due to `max_memory_restart`).
4. **Corrupt crypto store:** If `data/crypto/` gets corrupted, the bot may crash on startup. Solution: `rm -rf data/crypto` and restart (you'll lose keys for old rooms but new ones will be re-negotiated).

Check the logs:

```bash
pm2 logs matrix-claude-bot --lines 50 --nostream
```

## 14. Special Characters in Passwords During Login

**Symptom:** `curl` returns `M_NOT_JSON` when trying to do a programmatic login with passwords containing `!`, `$`, `"`, etc.

**Cause:** Bash interprets these characters inside strings with double or single quotes, breaking the JSON.

**Solution:** Use Node.js for the login instead of curl:

```bash
node -e '
const body = JSON.stringify({
  type: "m.login.password",
  identifier: { type: "m.id.user", user: "bot_username" },
  password: "password_with!special$characters",
  device_id: "CLAUDE_BOT",
  initial_device_display_name: "Matrix Claude Bot"
});
fetch("https://homeserver/_matrix/client/v3/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body
}).then(r => r.json()).then(d => console.log(JSON.stringify(d, null, 2)));
'
```

Node.js handles special characters in JavaScript strings correctly without shell escaping issues.

## 15. E2EE: Crypto Store Doesn't Persist Between Restarts

**Symptom:** The bot works but after restarting it loses the ability to decrypt messages from the room.

**Cause:** `MATRIX_CRYPTO_STORAGE_PATH` points to a directory that gets deleted (e.g.: inside `/tmp/`).

**Solution:** Make sure the path points to a persistent directory:

```bash
MATRIX_CRYPTO_STORAGE_PATH=./data/crypto
```

And that directory is **not** in `.gitignore` in a way that causes it to be accidentally deleted. The `data/` directory is in `.gitignore` (correct — you should not commit crypto keys), but it should not be manually deleted.

## 16. "No media URL in message" with E2EE Audio/Images

**Symptom:** You send a voice note or image and the bot responds with "No media URL in message" or "Transcription failed".

**Cause:** With E2EE enabled, Matrix sends encrypted media files using `content.file` (an object with `url`, `key`, `iv`, `hashes`) instead of `content.url`. The bot was only looking in `content.url`.

**Solution:** The bot already handles both formats automatically. The `downloadContentToFile()` function detects whether the media is encrypted (`content.file`) or plaintext (`content.url`) and uses the correct method:

- **E2EE**: downloads via `/_matrix/client/v1/media/download/` (authenticated endpoint) and decrypts with `Attachment.decrypt()` from the Rust crypto SDK
- **Plaintext**: downloads via `client.downloadContent()` with `mxc://` URL

If you see this error, make sure you're using the latest version of the bot.

## 17. "Failed to decrypt media" with Error 404

**Symptom:** `Transcription failed: Failed to decrypt media: {"statusCode":404,...}` when sending audio or images.

**Cause:** matrix.org deprecated the `/_matrix/media/v3/download/` endpoint for encrypted media. The `matrix-bot-sdk` SDK internally uses this legacy endpoint which now returns 404.

**Solution:** The bot uses the authenticated endpoint `/_matrix/client/v1/media/download/` with fallback to the legacy one. If both fail, verify:

1. That `MATRIX_ACCESS_TOKEN` is valid
2. That the media hasn't expired on the homeserver
3. That the homeserver supports at least one of the two endpoints

## 18. "Unverified device" Warning in Element

**Symptom:** Element shows that the bot's messages come from an "unverified device".

**Cause:** `matrix-bot-sdk` doesn't implement device verification or cross-signing. The `m.key.verification.*` events are listed as "not yet implemented" in the SDK.

**Solution:** The warning is **cosmetic** — encryption works correctly. To verify the device:

1. The bot prints its Device ID on startup in the logs:
   ```
   ━━━ Device Verification Info ━━━
     User:      @your-bot:matrix.org
     Device ID: CLAUDE_BOT
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ```
2. In Element, go to the bot's profile -> Sessions -> click on the device
3. Select "Manually verify by text" and confirm the Device ID

**Note:** Don't try using "Start verification" since the bot cannot respond to interactive verification requests.

## 19. Claude Doesn't Respond in IDE Mode

**Symptom:** The bot says "Claude IDE session started" but Claude doesn't respond at all. The MCP server is listening but Claude doesn't connect.

**Possible causes:**

1. **Claude Code doesn't support `--ide`:** Verify with `claude --help` that the `--ide` flag exists. Claude Code v1.0.20+ is required.
2. **Lockfile not created:** Verify that the lockfile exists at `~/.claude/ide/{PORT}.lock`.
3. **Port blocked:** The MCP server uses a random port on `127.0.0.1`. Verify there's no firewall blocking local connections.

**Diagnosis:**

```bash
# View active lockfiles
ls ~/.claude/ide/*.lock

# Lockfile contents
cat ~/.claude/ide/PORT.lock

# Logs with debug
LOG_LEVEL=debug node dist/index.js
```

## 20. Bridge Mode: tmux Not Found

**Symptom:** Error on startup in bridge mode: `tmux: command not found`.

**Solution:** Install tmux:

```bash
# Debian/Ubuntu
sudo apt install tmux

# Arch/Manjaro
sudo pacman -S tmux

# macOS
brew install tmux
```

## 21. Markdown Tables Don't Render Well in Element X (Mobile)

**Symptom:** Tables look perfect in Element Desktop but in Element X (mobile) they appear as unformatted running text, with all cell content on a single line.

**Cause:** Element X doesn't support the HTML `<table>` tag. The bot renders markdown to HTML with `marked`, which generates standard `<table>`, `<th>`, `<td>`. Element Desktop renders them correctly, but Element X simply ignores these tags and shows plain text.

**Solution:** This is a known Element X limitation. There's no workaround that looks good in both clients simultaneously:

- `<pre>` with aligned text looks worse in both
- Lists with bold text lose the tabular structure on desktop

The recommendation is to use **Element Desktop or Element Web** to view responses with tables. Element X is suitable for text messages and lists but not for tabular content.

## Maintenance Operations

```bash
# View logs in real time
pm2 logs matrix-claude-bot

# View last 50 lines
pm2 logs matrix-claude-bot --lines 50 --nostream

# Restart (loads new env vars)
pm2 restart matrix-claude-bot --update-env

# View status
pm2 status

# Clear logs
pm2 flush matrix-claude-bot

# Manually kill hung claude processes
ps aux | grep claude | grep -v grep | awk '{print $2}' | xargs -r kill

# List bot account devices
curl -s -H "Authorization: Bearer YOUR_TOKEN" \
  "https://YOUR_HOMESERVER/_matrix/client/v3/devices" | python3 -m json.tool

# Full E2EE reset (last resort — you'll lose keys for old rooms)
rm -rf ./data/crypto ./data/matrix-storage.json
pm2 restart matrix-claude-bot --update-env
```
