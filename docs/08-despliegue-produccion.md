# Despliegue en produccion

## Requisitos del servidor

| Componente | RAM | Cuando |
|-----------|-----|--------|
| Bot Node.js + E2EE | ~70-100 MB | Siempre |
| Claude CLI | ~200 MB | Solo durante ejecucion (10-30s) |
| **Pico** | **~300 MB** | Mientras Claude procesa |

A diferencia del bot de Telegram (que usaba whisper.cpp con ~388 MB), esta version no consume RAM para transcripcion porque usa Groq en la nube. El E2EE agrega ~20-30 MB por el SDK de crypto nativo.

Con un servidor de 2 GB de RAM vas sobrado. Incluso 1 GB deberia funcionar.

## Datos persistentes

El bot almacena datos en el directorio `data/`:

```
data/
 |-- sessions.json         Sesiones de Claude (session_id por room)
 |-- matrix-storage.json   Sync token de Matrix (para no re-procesar eventos)
 '-- crypto/               Claves E2EE (Olm/Megolm en SQLite)
```

**Importante:** El directorio `data/crypto/` contiene claves criptograficas. Si lo borras, el bot:
- No podra descifrar mensajes antiguos de rooms E2EE
- Re-negociara claves nuevas para mensajes futuros (funciona, pero pierde historial)
- Puede necesitar que los usuarios le re-envien un mensaje para trigger el intercambio de claves

Haz backup de `data/` periodicamente.

## Con PM2

### Instalacion

```bash
npm install -g pm2
pm2 startup systemd  # Auto-arranque tras reboot
```

### Configuracion

```bash
cd /opt/matrix-claude-bot

# Copiar ejemplo
cp ecosystem.config.example.cjs ecosystem.config.cjs
chmod 600 ecosystem.config.cjs  # Proteger tokens

# Editar con tus valores (incluir MATRIX_ENABLE_E2EE=true)
nano ecosystem.config.cjs
```

### Arrancar

```bash
npm run build                      # Compilar TypeScript
pm2 start ecosystem.config.cjs    # Arrancar
pm2 save                           # Persistir la config de PM2
```

### Operaciones comunes

```bash
# Ver estado
pm2 status

# Logs en tiempo real
pm2 logs matrix-claude-bot

# Ultimas N lineas
pm2 logs matrix-claude-bot --lines 50 --nostream

# Reiniciar (recarga env vars)
pm2 restart matrix-claude-bot --update-env

# Parar
pm2 stop matrix-claude-bot

# Eliminar del gestor
pm2 delete matrix-claude-bot

# Limpiar logs
pm2 flush matrix-claude-bot
```

## Con systemd (alternativa a PM2)

Si prefieres systemd sobre PM2:

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

# Ver logs
journalctl -u matrix-claude-bot -f
```

## Watchdog

El bot puede colgarse o Claude puede quedarse atascado. Este script lo vigila:

```bash
#!/bin/bash
# /opt/matrix-claude-bot/watchdog.sh
BOT_NAME="matrix-claude-bot"
LOG="/var/log/matrix-claude-bot-watchdog.log"
MAX_CLAUDE_MINUTES=10

# Comprobar si el bot esta corriendo en PM2
STATUS=$(pm2 jlist 2>/dev/null | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const p = d.find(x => x.name === '$BOT_NAME');
  if (!p) { console.log('missing'); process.exit(); }
  console.log(p.pm2_env.status);
")

if [ "$STATUS" = "missing" ]; then
  echo "$(date): Bot no encontrado, arrancando..." >> "$LOG"
  cd /opt/matrix-claude-bot && pm2 start ecosystem.config.cjs --update-env >> "$LOG" 2>&1
  exit 0
fi

if [ "$STATUS" != "online" ]; then
  echo "$(date): Bot en estado '$STATUS', reiniciando..." >> "$LOG"
  pm2 restart "$BOT_NAME" --update-env >> "$LOG" 2>&1
  exit 0
fi

# Matar procesos claude colgados (mas de N minutos)
ps aux | grep '/usr/bin/claude\|/.local/bin/claude' | grep -v grep | while read -r line; do
  PID=$(echo "$line" | awk '{print $2}')
  ETIME=$(echo "$line" | awk '{print $11}')
  MINS=$(echo "$ETIME" | awk -F: '{if(NF==3) print $1*60+$2; else print $1}')
  if [ "$MINS" -ge "$MAX_CLAUDE_MINUTES" ] 2>/dev/null; then
    echo "$(date): Matando claude colgado PID=$PID (${MINS}min)" >> "$LOG"
    kill "$PID" 2>/dev/null
  fi
done
```

```bash
chmod +x /opt/matrix-claude-bot/watchdog.sh

# Anadir al cron (cada 5 minutos)
crontab -e
# Anadir:
*/5 * * * * /opt/matrix-claude-bot/watchdog.sh
```

## Seguridad

- **Solo tu user ID** puede usar el bot. Los mensajes de otros usuarios se ignoran silenciosamente.
- **E2EE** por defecto — los mensajes viajan cifrados end-to-end entre tu cliente y el bot.
- **Tokens en `ecosystem.config.cjs`** con `chmod 600` — solo root puede leerlos.
- **Claves crypto en `data/crypto/`** — protegidas por permisos del sistema de ficheros.
- **Long-poll sync** — no necesitas abrir puertos. Tu firewall sigue intacto.
- **Sin datos de audio en disco permanente** — los ficheros temporales estan en `/tmp/` y se eliminan con el ciclo normal del sistema.
- **Transcripcion cloud** — el audio se envia a Groq. Si necesitas privacidad total de audio, considera usar whisper.cpp local.
- **Device dedicado** — el bot usa un device ID propio (`CLAUDE_BOT`) separado de cualquier sesion de Element, evitando conflictos y filtracion de claves.

## Actualizaciones

```bash
cd /opt/matrix-claude-bot

# Obtener cambios
git pull  # o copiar ficheros

# Rebuild
npm install
npm run build

# Reiniciar (NO borrar data/crypto — se pierden claves E2EE)
pm2 restart matrix-claude-bot --update-env
```

## Monitoring

Metricas clave a vigilar:

- `pm2 monit` — CPU y memoria en tiempo real
- `pm2 logs` — errores y warnings
- Watchdog log: `cat /var/log/matrix-claude-bot-watchdog.log`
- Procesos claude colgados: `ps aux | grep claude`
- Tamano del crypto store: `du -sh data/crypto/` (crece lentamente con cada room/key exchange)

## Backups

```bash
# Backup completo del estado
tar czf matrix-claude-bot-backup-$(date +%Y%m%d).tar.gz data/

# Restaurar
tar xzf matrix-claude-bot-backup-YYYYMMDD.tar.gz

# Backup periodico via cron (cada hora)
0 * * * * cd /opt/matrix-claude-bot && tar czf /opt/backups/matrix-bot-$(date +\%H).tar.gz data/
```
