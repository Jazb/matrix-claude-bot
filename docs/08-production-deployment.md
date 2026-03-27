# Production deployment

## Server requirements

| Component | RAM | When |
|-----------|-----|------|
| Node.js bot + E2EE | ~70-100 MB | Always |
| Claude CLI | ~200 MB | Only during execution (10-30s) |
| **Peak** | **~300 MB** | While Claude is processing |

Unlike the Telegram bot (which used whisper.cpp at ~388 MB), this version does not consume RAM for transcription because it uses Groq in the cloud. E2EE adds ~20-30 MB due to the native crypto SDK.

A server with 2 GB of RAM is more than enough. Even 1 GB should work.

## Persistent data

The bot stores data in the `data/` directory:

```
data/
 |-- sessions.json         Claude sessions (session_id per room)
 |-- matrix-storage.json   Matrix sync token (to avoid re-processing events)
 '-- crypto/               E2EE keys (Olm/Megolm in SQLite)
```

**Important:** The `data/crypto/` directory contains cryptographic keys. If you delete it, the bot will:
- Be unable to decrypt old messages from E2EE rooms
- Re-negotiate new keys for future messages (works, but loses history)
- May need users to re-send a message to trigger key exchange

Back up `data/` periodically.

## With PM2

### Installation

```bash
npm install -g pm2
pm2 startup systemd  # Auto-start after reboot
```

### Configuration

```bash
cd /opt/matrix-claude-bot

# Copy example
cp ecosystem.config.example.cjs ecosystem.config.cjs
chmod 600 ecosystem.config.cjs  # Protect tokens

# Edit with your values (include MATRIX_ENABLE_E2EE=true)
nano ecosystem.config.cjs
```

### Start

```bash
npm run build                      # Compile TypeScript
pm2 start ecosystem.config.cjs    # Start
pm2 save                           # Persist PM2 config
```

### Common operations

```bash
# Check status
pm2 status

# Real-time logs
pm2 logs matrix-claude-bot

# Last N lines
pm2 logs matrix-claude-bot --lines 50 --nostream

# Restart (reloads env vars)
pm2 restart matrix-claude-bot --update-env

# Stop
pm2 stop matrix-claude-bot

# Remove from manager
pm2 delete matrix-claude-bot

# Clear logs
pm2 flush matrix-claude-bot
```

## With systemd (alternative to PM2)

If you prefer systemd over PM2:

```ini
# /etc/systemd/system/matrix-claude-bot.service
[Unit]
Description=Matrix Claude Bot
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/matrix-claude-bot
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
Environment=HOME=/root
EnvironmentFile=/opt/matrix-claude-bot/.env

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable matrix-claude-bot
systemctl start matrix-claude-bot
systemctl status matrix-claude-bot

# View logs
journalctl -u matrix-claude-bot -f
```

## Watchdog

The bot can hang or Claude can get stuck. This script monitors it:

```bash
#!/bin/bash
# /opt/matrix-claude-bot/watchdog.sh
BOT_NAME="matrix-claude-bot"
LOG="/var/log/matrix-claude-bot-watchdog.log"
MAX_CLAUDE_MINUTES=10

# Check if the bot is running in PM2
STATUS=$(pm2 jlist 2>/dev/null | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const p = d.find(x => x.name === '$BOT_NAME');
  if (!p) { console.log('missing'); process.exit(); }
  console.log(p.pm2_env.status);
")

if [ "$STATUS" = "missing" ]; then
  echo "$(date): Bot not found, starting..." >> "$LOG"
  cd /opt/matrix-claude-bot && pm2 start ecosystem.config.cjs --update-env >> "$LOG" 2>&1
  exit 0
fi

if [ "$STATUS" != "online" ]; then
  echo "$(date): Bot in state '$STATUS', restarting..." >> "$LOG"
  pm2 restart "$BOT_NAME" --update-env >> "$LOG" 2>&1
  exit 0
fi

# Kill stuck claude processes (older than N minutes)
ps aux | grep '/usr/bin/claude\|/.local/bin/claude' | grep -v grep | while read -r line; do
  PID=$(echo "$line" | awk '{print $2}')
  ETIME=$(echo "$line" | awk '{print $11}')
  MINS=$(echo "$ETIME" | awk -F: '{if(NF==3) print $1*60+$2; else print $1}')
  if [ "$MINS" -ge "$MAX_CLAUDE_MINUTES" ] 2>/dev/null; then
    echo "$(date): Killing stuck claude PID=$PID (${MINS}min)" >> "$LOG"
    kill "$PID" 2>/dev/null
  fi
done
```

```bash
chmod +x /opt/matrix-claude-bot/watchdog.sh

# Add to cron (every 5 minutes)
crontab -e
# Add:
*/5 * * * * /opt/matrix-claude-bot/watchdog.sh
```

## Security

- **Only your user ID** can use the bot. Messages from other users are silently ignored.
- **E2EE** by default — messages travel end-to-end encrypted between your client and the bot.
- **Tokens in `ecosystem.config.cjs`** with `chmod 600` — only root can read them.
- **Crypto keys in `data/crypto/`** — protected by file system permissions.
- **Long-poll sync** — no need to open ports. Your firewall stays intact.
- **No permanent audio data on disk** — temporary files are in `/tmp/` and are removed by the normal system cycle.
- **Cloud transcription** — audio is sent to Groq. If you need total audio privacy, consider using local whisper.cpp.
- **Dedicated device** — the bot uses its own device ID (`CLAUDE_BOT`) separate from any Element session, avoiding conflicts and key leakage.

## Updates

```bash
cd /opt/matrix-claude-bot

# Get changes
git pull  # or copy files

# Rebuild
npm install
npm run build

# Restart (DO NOT delete data/crypto — you will lose E2EE keys)
pm2 restart matrix-claude-bot --update-env
```

## Monitoring

Key metrics to watch:

- `pm2 monit` — real-time CPU and memory
- `pm2 logs` — errors and warnings
- Watchdog log: `cat /var/log/matrix-claude-bot-watchdog.log`
- Stuck claude processes: `ps aux | grep claude`
- Crypto store size: `du -sh data/crypto/` (grows slowly with each room/key exchange)

## Backups

```bash
# Full state backup
tar czf matrix-claude-bot-backup-$(date +%Y%m%d).tar.gz data/

# Restore
tar xzf matrix-claude-bot-backup-YYYYMMDD.tar.gz

# Periodic backup via cron (every hour)
0 * * * * cd /opt/matrix-claude-bot && tar czf /opt/backups/matrix-bot-$(date +\%H).tar.gz data/
```
