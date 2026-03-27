# Ideas for future improvements

Features that could be added if needed. The current bot is functional and covers the main use cases, but there is room for expansion.

## Implemented

The following improvements from the original list are already implemented:

- **Markdown rendering**: responses rendered with `marked` and sent as HTML to Matrix.
- **E2EE support**: full end-to-end encryption with Megolm/Olm via Rust crypto SDK, including download and decryption of encrypted media (audio, images).
- **Bridge mode (tmux + hooks)**: interactive Claude with dynamic tool approval via Matrix.
- **IDE mode (MCP WebSocket)**: native Claude Code protocol with diff review from Matrix.

## Response streaming

Instead of waiting for Claude to finish, send chunks as they arrive:

- Use `--output-format stream-json` in Claude Code
- Parse JSON events from the stdout stream
- Progressively edit the Matrix message or send partial messages

This would greatly improve the experience for long responses.

## Multiple users

Change from a single `MATRIX_ALLOWED_USER_ID` to a list or roles:

```bash
MATRIX_ALLOWED_USERS=@admin:server,@dev1:server,@dev2:server
```

Or implement roles:

- **admin**: can use all commands and projects
- **user**: can only send prompts, cannot change project
- **readonly**: can only view responses (observer)

## Programmatic device verification

`matrix-bot-sdk` does not implement cross-signing or interactive verification (`m.key.verification.*` is listed as "not yet implemented"). When the SDK supports it, the bot could auto-verify on startup without manual intervention.

## Configurable Claude model

Command to switch models without restarting:

```
!model sonnet
!model opus
```

This would pass `--model` to the Claude command.

## File attachments in responses

If Claude generates files (patches, scripts, etc.), upload them to Matrix as attachments:

```typescript
const mxcUri = await client.uploadContent(buffer, "text/plain", "patch.diff");
await client.sendMessage(roomId, {
  msgtype: "m.file",
  url: mxcUri,
  body: "patch.diff",
  info: { mimetype: "text/plain", size: buffer.length },
});
```

## Session backups

Copy `sessions.json` periodically in case the server goes down:

```bash
# In cron
0 * * * * cp /opt/matrix-claude-bot/data/sessions.json /opt/matrix-claude-bot/data/sessions.backup.json
```

Or use a database storage provider instead of JSON.

## Proactive notifications

Inspired by Jackpoint: send notifications when Claude needs input, when a long task finishes, or when there is an error. IDE mode already partially supports this via MCP tools (openDiff), but it could be expanded.

## Rate limiting

If opened to multiple users, add per-user limits:

- Maximum N requests per minute
- Maximum N concurrent requests in queue
- Notify the user if they exceed the limit

## Automatic /tmp cleanup

Audio and image files accumulate in `TMP_DIR`. A cron job or periodic cleanup within the bot could delete old files:

```bash
# Delete files older than 1 hour
find /tmp/matrix-claude-bot -type f -mmin +60 -delete
```
