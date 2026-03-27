# Guia de inicio rapido

Un bot de Matrix que actua como terminal remota de Claude Code. Le envias texto, audio o imagenes desde el movil (Element, FluffyChat, cualquier cliente Matrix) y Claude Code responde como si estuvieras en la terminal. Soporta encriptacion end-to-end (E2EE) y tres modos de operacion.

## Que vas a montar

```
Cualquier cliente Matrix (movil/web/desktop)
    |
    v  long-poll sync (E2EE)
[Bot Node.js + matrix-bot-sdk]  --- PM2/systemd --- tu servidor
    |
    |-- Texto (encriptado) ---> descifrar --> claude -p "..." --output-format json [--ide]
    |-- Audio (OGG/MP3/...) --> descifrar+desencriptar --> Groq API (whisper) --> texto --> claude -p
    '-- Imagen --> descifrar+desencriptar --> /tmp/ --> claude -p "Lee imagen en /tmp/x.jpg y ..."
                                  |
                           cwd: tu proyecto
                           --resume <session_id> (continuidad entre mensajes)
```

- **Tres modos**: bot (one-shot), bridge (tmux+hooks), IDE (MCP WebSocket, recomendado).
- **E2EE completo**: encriptacion end-to-end con Megolm/Olm via Rust crypto SDK, incluyendo descarga y desencriptacion de media (audio, imagenes).
- **Markdown renderizado**: respuestas con formato HTML en Matrix.
- **Long-poll sync** (no webhooks): no necesitas abrir puertos ni configurar reverse proxy.
- **Cola serial**: solo 1 tarea Claude a la vez (ideal para servidores pequenos).
- **Sesion persistente**: cada mensaje continua la conversacion anterior con `--resume`.
- **Transcripcion cloud**: Groq API con Whisper, sin compilar nada local.

## Requisitos previos

- Un servidor con Claude Code instalado y autenticado (`claude login` o `claude setup-token`)
- Node.js 18+ y npm
- Una cuenta Matrix para el bot (separada de la tuya)
- Una API key de Groq (gratuita en https://console.groq.com/keys)

## Paso 1: Crear la cuenta del bot en Matrix

1. Ve a https://app.element.io o tu cliente Matrix preferido
2. Registra una cuenta nueva para el bot (ej: `your-bot`, `claude-bot`, etc.)
3. Apunta el **username** y **password** — los necesitaras para el login programatico

**Importante:** NO uses el access token de Element directamente. Necesitas crear un **device dedicado** para el bot via login programatico. Si usas el token de Element, el bot hereda ese device ID y luego al activar E2EE las claves crypto entran en conflicto (ver seccion de errores comunes).

## Paso 2: Obtener access token con device dedicado

Usa Node.js para hacer un login que cree un device propio del bot:

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

La respuesta contiene:

```json
{
  "access_token": "mct_xxxxx",
  "device_id": "CLAUDE_BOT",
  "user_id": "@tu_bot:matrix.org"
}
```

Copia el `access_token`. Este token esta asociado al device `CLAUDE_BOT`, que es exclusivo para el bot y no entrara en conflicto con sesiones de Element.

**Por que no usar curl:** Si el password contiene caracteres especiales (`!`, `$`, etc.), bash los interpreta mal. Node.js con `fetch` evita estos problemas de escaping.

## Paso 3: Obtener tu user ID de Matrix

Tu user ID es tu `@usuario:servidor.com`. Lo puedes ver en Element en Ajustes > General.

## Paso 4: Obtener API key de Groq

1. Ve a https://console.groq.com/keys
2. Crea una nueva API key
3. Copia el valor (`gsk_...`)

Groq ofrece un tier gratuito con limites generosos. El modelo `whisper-large-v3-turbo` cuesta $0.04/hora de audio.

## Paso 5: Instalar el bot

```bash
# Clonar o copiar el proyecto
cd /opt
cp -r /ruta/al/matrix-claude-bot .
cd matrix-claude-bot

# Instalar dependencias (incluye el SDK de crypto nativo)
npm install

# Compilar TypeScript
npm run build
```

## Paso 6: Configurar

Copia el archivo de ejemplo y rellena tus valores:

```bash
cp .env.example .env
chmod 600 .env  # proteger tokens
```

Edita `.env` con tus datos:

```bash
# Matrix
MATRIX_HOMESERVER_URL=https://matrix.org
MATRIX_ACCESS_TOKEN=mct_tu_token_del_paso_2
MATRIX_ALLOWED_USER_ID=@tu_usuario:matrix.org

# E2EE (activado por defecto)
MATRIX_ENABLE_E2EE=true
MATRIX_CRYPTO_STORAGE_PATH=./data/crypto

# Proyectos
PROJECTS=miproyecto=/home/user/mi-proyecto

# Groq
GROQ_API_KEY=gsk_tu_api_key

# Claude
CLAUDE_BINARY_PATH=/usr/local/bin/claude  # ajustar con: which claude

# Claude auth (una de estas)
CLAUDE_CODE_OAUTH_TOKEN=tu_oauth_token
# ANTHROPIC_API_KEY=sk-ant-tu-key

# Modo de operacion (bot | bridge | ide)
BOT_MODE=ide  # recomendado para interactividad
```

## Paso 7: Configurar permisos de Claude Code

Claude Code necesita permisos pre-autorizados porque no hay terminal interactivo para aprobarlos.

**Opcion A: Permisos globales** — Edita `~/.claude/settings.json` (afecta a todas las sesiones de Claude del usuario):

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

**Opcion B: Permisos por proyecto** — Crea `.claude/settings.json` dentro de cada proyecto configurado en `PROJECTS`. Esto es mas seguro porque limita los permisos al ambito del proyecto.

Ajusta los permisos segun tus necesidades.

## Paso 8: Ejecutar

### Desarrollo (con hot-reload)

```bash
# Cargar variables y ejecutar
bash -c 'set -a && source .env && set +a && npx tsx src/index.ts'
```

O en background con logs a fichero:

```bash
bash -c 'set -a && source .env && set +a && npx tsx src/index.ts &>/tmp/matrix-bot.log &'

# Ver logs
tail -f /tmp/matrix-bot.log
```

### Produccion (compilado)

```bash
npm run build
bash -c 'set -a && source .env && set +a && node dist/index.js'
```

### Con PM2 (recomendado para produccion)

```bash
npm install -g pm2
pm2 startup systemd

cp ecosystem.config.example.cjs ecosystem.config.cjs
chmod 600 ecosystem.config.cjs
# Editar ecosystem.config.cjs con tus valores

npm run build
pm2 start ecosystem.config.cjs
pm2 save
```

## Paso 9: Probar

1. Abre tu cliente Matrix con tu cuenta personal
2. Inicia un **DM** con la cuenta del bot (ej: `@your-bot:matrix.org`)
3. El bot acepta la invitacion automaticamente (AutojoinMixin)
4. **Primer mensaje:** Escribe "Hola" — el primer mensaje puede tardar unos segundos mientras se intercambian claves E2EE
5. Deberias ver el indicador de escritura y luego la respuesta de Claude
6. **Continuidad:** Envia un segundo mensaje — mantiene contexto de la conversacion
7. **Nueva sesion:** Escribe `!new` — limpia la sesion
8. **Audio:** Envia una nota de voz — la transcribe con Groq y responde
9. **Imagen:** Envia una foto con caption — Claude la analiza
10. **Cambiar proyecto:** `!project otronombre`

## Comandos disponibles

| Comando | Descripcion | Modos |
|---------|------------|-------|
| `!help` | Muestra la ayuda | todos |
| `!new` | Nueva sesion (limpia contexto) | todos |
| `!project NOMBRE` | Cambiar de proyecto | todos |
| `!status` | Info de sesion, cola y configuracion | todos |
| `!cancel` | Cancelar la tarea en ejecucion | todos |
| `!lines [N]` | Ver ultimas N lineas del terminal | solo bridge |

En modo IDE, responder **y** o **n** a un diff presentado por Claude aplica o rechaza el cambio.

## Verificar que E2EE funciona

En Element, al abrir el DM con el bot, deberias ver el icono de escudo en los mensajes. Si el bot responde y ves el escudo, E2EE esta funcionando correctamente.

### Verificar el dispositivo del bot

Al arrancar, el bot imprime su Device ID en los logs:

```
━━━ Device Verification Info ━━━
  User:      @your-bot:matrix.org
  Device ID: CLAUDE_BOT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Para eliminar la advertencia de "dispositivo no verificado" en Element:

1. En Element, click en el perfil del bot → Sessions
2. Click en el dispositivo `CLAUDE_BOT`
3. Selecciona "Manually verify by text" y confirma el Device ID

**Nota:** No uses "Start verification" — `matrix-bot-sdk` no implementa verificacion interactiva. La advertencia es cosmetica; la encriptacion funciona correctamente sin verificar.

Si ves `!status` y dice `Processing: No`, el bot esta idle y listo para recibir mensajes.
