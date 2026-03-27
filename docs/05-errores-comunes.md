# Errores comunes y soluciones

Esta seccion documenta los problemas reales encontrados al montar y operar el bot, con sus causas y soluciones. Incluye errores descubiertos durante el desarrollo del bot de Telegram original y problemas especificos de E2EE encontrados durante las pruebas en produccion.

## 1. Claude se cuelga infinitamente

**Sintoma:** Envias un mensaje, el bot muestra el indicador de escritura pero nunca responde. En los logs ves `Running prompt in project "..."` y luego silencio.

**Causa:** Cuando usas `child_process.spawn()` para lanzar Claude, stdin queda como `pipe` por defecto. Claude detecta ese pipe abierto e interpreta que hay input pendiente. Se queda esperando para siempre. No da error. No produce output. Solo se bloquea.

**Solucion:** El bot ya tiene esto resuelto. Si modificas `claude/runner.ts`, asegurate de mantener:

```typescript
const child = spawn(binaryPath, args, {
  cwd,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],  // 'ignore' cierra stdin
});
```

El `'ignore'` en la posicion 0 (stdin) es critico.

## 2. "Not logged in" — PM2 no carga .bashrc

**Sintoma:** Claude responde con `"Not logged in"` o pide login.

**Causa:** PM2 no ejecuta `.bashrc` ni `.profile` al arrancar procesos. Si tu `CLAUDE_CODE_OAUTH_TOKEN` esta definido ahi, el proceso hijo no lo ve.

**Solucion:** Pon todas las variables de entorno en `ecosystem.config.cjs` dentro del objeto `env`. No dependas de `.bashrc`.

```javascript
env: {
  HOME: "/root",
  CLAUDE_CODE_OAUTH_TOKEN: "tu_token",
  // ... resto de variables
}
```

## 3. Claude no encuentra settings.json

**Sintoma:** Claude pide permisos interactivamente (y se cuelga porque no hay terminal).

**Causa:** Sin `HOME` en las variables de entorno, Claude no sabe donde buscar `~/.claude/settings.json`.

**Solucion:** Asegurate de que `HOME` esta definido en `ecosystem.config.cjs`. El bot ya lo incluye en el env que pasa a spawn, pero debe apuntar al home correcto del usuario que tiene `~/.claude/settings.json` configurado.

## 4. Error: spawn /usr/bin/claude ENOENT

**Sintoma:** `Error: spawn /usr/bin/claude ENOENT` — Node.js no encuentra el binario.

**Causa:** Claude no esta instalado o esta en otra ruta. El default es `/usr/bin/claude` pero puede estar en otro sitio.

**Solucion:** Busca la ruta real y configurala:

```bash
which claude
# /home/user/.local/bin/claude

# En tu .env o ecosystem.config.cjs:
CLAUDE_BINARY_PATH=/home/user/.local/bin/claude
```

## 5. El bot recibe eventos pero no responde (E2EE: m.room.encrypted)

**Sintoma:** En los logs ves `[room.event] type=m.room.encrypted` pero nunca llega un `[room.message]`. El bot hizo auto-join a la sala pero ignora los mensajes.

**Causa:** Los DMs en matrix.org (y muchos homeservers) tienen E2EE activado por defecto. Sin soporte de crypto, el bot recibe eventos cifrados que no puede descifrar, por lo que nunca emite `room.message`.

**Solucion:** Asegurate de que E2EE esta habilitado (es el default):

```bash
MATRIX_ENABLE_E2EE=true
MATRIX_CRYPTO_STORAGE_PATH=./data/crypto
```

Y que `@matrix-org/matrix-sdk-crypto-nodejs` esta instalado:

```bash
npm ls @matrix-org/matrix-sdk-crypto-nodejs
```

## 6. E2EE: "One time key already exists" al arrancar

**Sintoma:** El bot crashea al arrancar con:

```
MatrixError: M_UNKNOWN: One time key signed_curve25519:AAAAAAAAAA4 already exists
```

**Causa:** Esto ocurre cuando el bot reutiliza un device ID que ya tiene one-time keys (OTK) subidas al servidor, pero el crypto store local es nuevo o fue borrado. El SDK genera nuevas claves que entran en conflicto con las antiguas del servidor.

Escenario tipico:
1. Creas la cuenta del bot en Element (esto crea un device con OTK)
2. Copias el access token de Element al bot
3. Activas E2EE — el bot hereda el device de Element pero con claves distintas
4. Error de conflicto

**Solucion:** Crear un **device dedicado** para el bot via login programatico:

```bash
node -e '
const body = JSON.stringify({
  type: "m.login.password",
  identifier: { type: "m.id.user", user: "TU_BOT_USERNAME" },
  password: "TU_BOT_PASSWORD",
  device_id: "CLAUDE_BOT",
  initial_device_display_name: "Matrix Claude Bot"
});
fetch("https://TU_HOMESERVER/_matrix/client/v3/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body
}).then(r => r.json()).then(d => console.log(JSON.stringify(d, null, 2)));
'
```

Usa el `access_token` de esta respuesta en tu `.env`. Luego limpia el crypto store:

```bash
rm -rf ./data/crypto ./data/matrix-storage.json
```

Y reinicia el bot. El device `CLAUDE_BOT` empieza limpio sin conflictos de OTK.

**Prevencion:** Siempre crea la cuenta del bot y luego haz login programatico con un `device_id` personalizado antes de activar E2EE. No uses tokens de Element.

## 7. E2EE: "Can't find the room key to decrypt the event"

**Sintoma:** En los logs ves:

```
[E2EE] Failed to decrypt event in !room:server from @user:server: Can't find the room key to decrypt the event
```

**Causa:** El bot no tiene las claves Megolm para descifrar mensajes que fueron enviados **antes** de que el bot tuviera E2EE configurado, o antes de unirse al room. Esto es comportamiento normal — los mensajes cifrados antes de que el bot tenga las claves no se pueden descifrar retroactivamente.

**Solucion:** Esto solo afecta a mensajes historicos. Los mensajes **nuevos** enviados despues de que el bot este online con E2EE funcionaran correctamente. El bot intercambia claves automaticamente al hacer sync.

Si necesitas limpiar el error del primer arranque, simplemente ignora los fallos de descifrado iniciales.

## 8. El bot no responde a mis mensajes

**Sintoma:** El bot esta online pero ignora tus mensajes.

**Causas posibles:**

1. **User ID incorrecto:** `MATRIX_ALLOWED_USER_ID` no coincide exactamente con tu user ID de Matrix. Debe incluir el servidor: `@usuario:matrix.org` (no solo `usuario`).

2. **El bot no esta en el room:** Necesitas invitar al bot al room o enviarle un DM. Gracias a `AutojoinRoomsMixin`, el bot acepta invitaciones automaticamente.

3. **El bot procesa un evento antiguo:** Al arrancar, matrix-bot-sdk hace un sync inicial. Si hay eventos antiguos pendientes, puede parecer que no responde. Espera unos segundos.

4. **E2EE no esta configurado:** Ver error #5.

**Diagnostico:** Arranca con `LOG_LEVEL=debug` y busca en los logs:
- `[room.event]` — Confirma que el bot recibe eventos
- `[room.message]` — Confirma que los descifra correctamente
- `sender=@tu_usuario:...` — Confirma que es tu user ID

## 9. Timeout en respuestas largas

**Sintoma:** El bot responde con "Claude timed out" para prompts complejos.

**Solucion:** Aumenta el timeout:

```bash
CLAUDE_TIMEOUT=600000  # 10 minutos
```

Tambien puedes ajustar `CLAUDE_MAX_TURNS` si Claude necesita mas iteraciones agenticas.

## 10. Transcripcion falla con error 401

**Sintoma:** `Groq API error (401): ...`

**Causa:** API key de Groq invalida o expirada.

**Solucion:** Genera una nueva key en https://console.groq.com/keys y actualiza `GROQ_API_KEY`.

## 11. Transcripcion falla con error 413

**Sintoma:** `Groq API error (413): Request Entity Too Large`

**Causa:** El archivo de audio supera el limite de 25 MB (tier gratis) o 100 MB (tier dev).

**Solucion:** Envia audios mas cortos. Las notas de voz tipicas de movil estan muy por debajo de este limite.

## 12. Mensajes cortados o incompletos

**Sintoma:** La respuesta de Claude aparece truncada.

**Causa:** Matrix tiene un limite de ~65KB por evento, pero el bot divide a 4096 caracteres por defecto (para legibilidad). Si Claude devuelve respuestas muy largas, se dividen en multiples mensajes.

Esto no es un error — es comportamiento esperado. Si quieres chunks mas grandes:

```bash
MAX_MESSAGE_LENGTH=8192
```

## 13. El bot se reinicia constantemente

**Sintoma:** `pm2 status` muestra muchos reinicios.

**Causas posibles:**

1. **Token invalido:** El bot falla al autenticarse y sale. Revisa `MATRIX_ACCESS_TOKEN`.
2. **Sin permisos de escritura:** El bot necesita poder escribir en `SESSIONS_FILE`, `TMP_DIR` y `MATRIX_CRYPTO_STORAGE_PATH`.
3. **Memoria:** Si el servidor tiene poca RAM y Claude + el bot superan el limite, PM2 reinicia (por `max_memory_restart`).
4. **Crypto store corrupto:** Si `data/crypto/` se corrompe, el bot puede crashear al arrancar. Solucion: `rm -rf data/crypto` y reiniciar (perderas claves de salas antiguas pero las nuevas se re-negocian).

Revisa los logs:

```bash
pm2 logs matrix-claude-bot --lines 50 --nostream
```

## 14. Caracteres especiales en passwords al hacer login

**Sintoma:** `curl` devuelve `M_NOT_JSON` al intentar hacer login programatico con passwords que contienen `!`, `$`, `"`, etc.

**Causa:** Bash interpreta estos caracteres dentro de strings con comillas dobles o simples, rompiendo el JSON.

**Solucion:** Usa Node.js para el login en vez de curl:

```bash
node -e '
const body = JSON.stringify({
  type: "m.login.password",
  identifier: { type: "m.id.user", user: "bot_username" },
  password: "password_con!caracteres$especiales",
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

Node.js maneja correctamente los caracteres especiales en strings de JavaScript sin problemas de escaping de shell.

## 15. E2EE: Crypto store no persiste entre reinicios

**Sintoma:** El bot funciona pero despues de reiniciar pierde la capacidad de descifrar mensajes del room.

**Causa:** `MATRIX_CRYPTO_STORAGE_PATH` apunta a un directorio que se borra (ej: dentro de `/tmp/`).

**Solucion:** Asegurate de que el path apunta a un directorio persistente:

```bash
MATRIX_CRYPTO_STORAGE_PATH=./data/crypto
```

Y que ese directorio **no** esta en `.gitignore` de forma que se borre accidentalmente. El directorio `data/` si esta en `.gitignore` (correcto — no debes commitear claves crypto), pero no debe borrarse manualmente.

## 16. "No media URL in message" con audio/imagenes E2EE

**Sintoma:** Envias una nota de voz o imagen y el bot responde "No media URL in message" o "Transcription failed".

**Causa:** Con E2EE activado, Matrix envia los archivos multimedia encriptados usando `content.file` (un objeto con `url`, `key`, `iv`, `hashes`) en lugar de `content.url`. El bot buscaba solo en `content.url`.

**Solucion:** El bot ya maneja ambos formatos automaticamente. La funcion `downloadContentToFile()` detecta si el media viene encriptado (`content.file`) o en texto plano (`content.url`) y usa el metodo correcto:

- **E2EE**: descarga via `/_matrix/client/v1/media/download/` (endpoint autenticado) y desencripta con `Attachment.decrypt()` del Rust crypto SDK
- **Plano**: descarga via `client.downloadContent()` con URL `mxc://`

Si ves este error, asegurate de estar usando la ultima version del bot.

## 17. "Failed to decrypt media" con error 404

**Sintoma:** `Transcription failed: Failed to decrypt media: {"statusCode":404,...}` al enviar audio o imagenes.

**Causa:** matrix.org depreco el endpoint `/_matrix/media/v3/download/` para media encriptados. El SDK `matrix-bot-sdk` usa internamente este endpoint legacy que ya devuelve 404.

**Solucion:** El bot usa el endpoint autenticado `/_matrix/client/v1/media/download/` con fallback al legacy. Si ambos fallan, verifica:

1. Que `MATRIX_ACCESS_TOKEN` es valido
2. Que el media no ha expirado en el homeserver
3. Que el homeserver soporta al menos uno de los dos endpoints

## 18. Advertencia "unverified device" en Element

**Sintoma:** Element muestra que los mensajes del bot vienen de un "dispositivo no verificado".

**Causa:** `matrix-bot-sdk` no implementa verificacion de dispositivos ni cross-signing. Los eventos `m.key.verification.*` estan listados como "not yet implemented" en el SDK.

**Solucion:** La advertencia es **cosmetica** — la encriptacion funciona correctamente. Para verificar el dispositivo:

1. El bot imprime su Device ID al arrancar en los logs:
   ```
   ━━━ Device Verification Info ━━━
     User:      @your-bot:matrix.org
     Device ID: CLAUDE_BOT
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ```
2. En Element, ve al perfil del bot → Sessions → click en el dispositivo
3. Selecciona "Manually verify by text" y confirma el Device ID

**Nota:** No intentes usar "Start verification" ya que el bot no puede responder a solicitudes de verificacion interactiva.

## 19. Claude no responde en modo IDE

**Sintoma:** El bot dice "Claude IDE session started" pero Claude no responde nada. El MCP server esta escuchando pero Claude no conecta.

**Causas posibles:**

1. **Claude Code no soporta `--ide`:** Verifica con `claude --help` que el flag `--ide` existe. Se necesita Claude Code v1.0.20+.
2. **Lockfile no creado:** Verifica que existe el lockfile en `~/.claude/ide/{PORT}.lock`.
3. **Puerto bloqueado:** El MCP server usa un puerto aleatorio en `127.0.0.1`. Verifica que no hay firewall bloqueando conexiones locales.

**Diagnostico:**

```bash
# Ver lockfiles activos
ls ~/.claude/ide/*.lock

# Contenido del lockfile
cat ~/.claude/ide/PORT.lock

# Logs con debug
LOG_LEVEL=debug node dist/index.js
```

## 20. Modo bridge: tmux no encontrado

**Sintoma:** Error al arrancar en modo bridge: `tmux: command not found`.

**Solucion:** Instala tmux:

```bash
# Debian/Ubuntu
sudo apt install tmux

# Arch/Manjaro
sudo pacman -S tmux

# macOS
brew install tmux
```

## 21. Tablas markdown no se ven bien en Element X (movil)

**Sintoma:** Las tablas se ven perfectas en Element Desktop pero en Element X (movil) aparecen como texto corrido sin formato, con todo el contenido de las celdas en una sola linea.

**Causa:** Element X no soporta el tag HTML `<table>`. El bot renderiza markdown a HTML con `marked`, que genera `<table>`, `<th>`, `<td>` estandar. Element Desktop los renderiza correctamente, pero Element X simplemente ignora estos tags y muestra el texto plano.

**Solucion:** Es una limitacion conocida de Element X. No hay workaround que se vea bien en ambos clientes simultaneamente:

- `<pre>` con texto alineado se ve peor en ambos
- Listas con negrita pierden la estructura tabular en desktop

La recomendacion es usar **Element Desktop o Element Web** para ver respuestas con tablas. Element X es adecuado para mensajes de texto y listas pero no para contenido tabular.

## Operaciones de mantenimiento

```bash
# Ver logs en tiempo real
pm2 logs matrix-claude-bot

# Ver ultimas 50 lineas
pm2 logs matrix-claude-bot --lines 50 --nostream

# Reiniciar (carga nuevas env vars)
pm2 restart matrix-claude-bot --update-env

# Ver estado
pm2 status

# Limpiar logs
pm2 flush matrix-claude-bot

# Matar procesos claude colgados manualmente
ps aux | grep claude | grep -v grep | awk '{print $2}' | xargs -r kill

# Listar devices de la cuenta del bot
curl -s -H "Authorization: Bearer TU_TOKEN" \
  "https://TU_HOMESERVER/_matrix/client/v3/devices" | python3 -m json.tool

# Reset completo de E2EE (ultima opcion — pierdes claves de salas antiguas)
rm -rf ./data/crypto ./data/matrix-storage.json
pm2 restart matrix-claude-bot --update-env
```
