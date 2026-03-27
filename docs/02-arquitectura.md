# Arquitectura

## Vision general

El bot sigue una arquitectura modular con separacion clara de responsabilidades y soporta tres modos de operacion:

```
src/
 |-- config/         Carga y validacion de configuracion
 |-- matrix/         Conexion con el homeserver Matrix + E2EE
 |-- claude/         Ejecucion de Claude Code y sesiones (modo bot)
 |-- bridge/         Modo bridge: tmux + hooks + IPC socket
 |-- ide/            Modo IDE: MCP WebSocket + JSON-RPC 2.0
 |-- transcriber/    Transcripcion de audio via Groq
 |-- queue/          Cola serial de tareas
 |-- utils/          Logger, split de mensajes
 '-- index.ts        Punto de entrada, wiring y event handlers
```

## Modos de operacion

El bot soporta tres modos, seleccionados con `BOT_MODE`:

| Modo | Variable | Descripcion |
|------|----------|-------------|
| **Bot** | `BOT_MODE=bot` | Subprocess one-shot: `claude -p` por mensaje. Simple y robusto. Default. |
| **Bridge** | `BOT_MODE=bridge` | Claude interactivo en tmux. Hooks (PreToolUse, Notification, Stop) se forwrdean via IPC a Matrix. Permite aprobar/rechazar herramientas dinamicamente. |
| **IDE** | `BOT_MODE=ide` | Protocolo MCP nativo de Claude Code via WebSocket (el mismo que usan VS Code, JetBrains y Emacs). Combina la fiabilidad del subprocess one-shot con la interactividad del protocolo IDE. **Recomendado.** |

### Modo Bot — Subprocess one-shot

```
Usuario -> Matrix (E2EE) -> Bot -> claude -p "prompt" --output-format json -> respuesta -> Matrix
```

- Lanza `claude -p` como subproceso por cada mensaje
- `stdin: 'ignore'` para evitar que Claude se cuelgue
- `--resume <session_id>` para mantener continuidad
- Cola serial: solo 1 proceso a la vez

### Modo Bridge — tmux + hooks

```
Usuario -> Matrix (E2EE) -> Bot -> tmux send-keys "prompt" -> Claude interactivo
                                       |
                                   Hooks (PreToolUse, Notification, Stop)
                                       |
                                   IPC Unix Socket -> Bot -> Matrix
```

- Claude corre interactivamente dentro de tmux
- Hooks de Claude Code notifican al bot via IPC socket
- Permisos de herramientas se aprueban/rechazan desde Matrix
- Lectura de transcripts JSONL para obtener respuestas

### Modo IDE — MCP WebSocket (recomendado)

```
Usuario -> Matrix (E2EE) -> Bot -> claude -p "prompt" --output-format json --ide
                                       |                                    |
                                       |                          Claude conecta al MCP server
                                       |                                    |
                                   WebSocket MCP Server <------- JSON-RPC 2.0
                                       |
                                   Tools: openDiff, getDiagnostics, openFile...
                                       |
                                   Diff review -> Matrix -> Usuario aprueba/rechaza
```

- Combina subprocess one-shot (fiabilidad) con protocolo IDE (interactividad)
- MCP server WebSocket en puerto aleatorio con lockfile en `~/.claude/ide/{PORT}.lock`
- Claude Code descubre el server via lockfile y conecta automaticamente con `--ide`
- Tools del protocolo IDE (openDiff, openFile, getDiagnostics) se forwardean a Matrix
- Diffs se presentan al usuario para aprobacion/rechazo
- Keepalive ping cada 30s

## Flujo de un mensaje de texto (con E2EE)

```
1. Matrix sync recibe evento m.room.encrypted
2. El SDK (RustSdkCryptoStorageProvider) descifra con Megolm
3. Se emite room.decrypted_event y luego room.message con el evento descifrado
4. Auth guard: se ignora si sender != MATRIX_ALLOWED_USER_ID
5. Se extrae el msgtype y body del evento
6. Si empieza por "!" -> se ejecuta el comando correspondiente
7. Si no -> se envia a handlePrompt()
8. handlePrompt() encola la tarea en SerialQueue
9. Se activa el typing indicator
10. Segun el modo:
    - Bot: ClaudeRunner.run() lanza claude -p "prompt" --output-format json --resume <session_id>
    - Bridge: tmux send-keys inyecta el prompt en la sesion interactiva
    - IDE: IdeRunner.handleMessage() lanza claude -p "prompt" --output-format json --ide --resume <session_id>
11. Se parsea la respuesta (JSON en bot/ide, transcript JSONL en bridge)
12. Se guarda el session_id para la proxima vez
13. Se renderiza markdown a HTML con marked
14. Se divide la respuesta en chunks de 4096 chars
15. Se envian los chunks cifrados automaticamente al room
```

## Flujo de un mensaje de audio (con E2EE)

```
1. Matrix sync recibe evento m.room.encrypted con msgtype m.audio
2. SDK descifra el evento
3. Se detecta si el media es encriptado (content.file) o plano (content.url):
   - E2EE: se descarga via /_matrix/client/v1/media/download/ (endpoint autenticado)
           y se desencripta con Attachment.decrypt() del Rust crypto SDK
   - Plano: se descarga via client.downloadContent() con URL mxc://
4. Se envia el fichero a Groq API (whisper-large-v3-turbo)
5. Groq devuelve el texto transcrito
6. Se muestra la transcripcion al usuario
7. El texto transcrito se procesa como prompt (flujo de texto, paso 7+)
```

## Flujo de una imagen (con E2EE)

```
1. Matrix sync recibe evento m.room.encrypted con msgtype m.image
2. SDK descifra el evento
3. Se descarga y desencripta la imagen (mismo proceso que audio)
4. Se guarda en /tmp/matrix-claude-bot/img_<timestamp>.<ext>
5. Se construye el prompt: "Lee la imagen en /tmp/img_xxx.jpg y responde: <caption>"
6. Claude Code lee la imagen desde disco y responde
```

## Componentes clave

### SerialQueue (`src/queue/serial-queue.ts`)

Solo un proceso Claude puede ejecutarse a la vez. Si llegan mensajes mientras otro se procesa, se encolan en orden FIFO.

```
Mensaje 1 -> [ejecutando] --------> respuesta 1
Mensaje 2 -> [cola pos 1] -> [ejecutando] -> respuesta 2
Mensaje 3 -> [cola pos 2] -> [cola pos 1] -> [ejecutando] -> respuesta 3
```

La cola tambien permite cancelar la tarea actual via `!cancel`, que envia SIGTERM al proceso hijo.

### SessionStore (`src/claude/session.ts`)

Persiste el `session_id` de Claude Code por room de Matrix. Esto permite que mensajes consecutivos mantengan el contexto de la conversacion usando `--resume`.

Los datos se guardan en un fichero JSON (`data/sessions.json`):

```json
{
  "!abc123:matrix.org": {
    "sessionId": "550e8400-e29b-41d4-a716-446655440000",
    "project": "miproyecto"
  }
}
```

### ClaudeRunner (`src/claude/runner.ts`)

Lanza Claude Code como subproceso con `child_process.spawn()`. Decisiones de diseno criticas:

1. **stdin: 'ignore'** — Sin esto, Claude se cuelga indefinidamente esperando input de un pipe que nunca llega.
2. **Env explicito** — PM2/systemd no cargan `.bashrc`, asi que se pasan manualmente HOME, PATH, y los tokens de autenticacion.
3. **Ruta absoluta al binario** — Evita errores `ENOENT` cuando PATH no incluye el directorio de Claude.
4. **Timeout configurable** — Mata el proceso si tarda demasiado (default: 5 minutos).

### GroqTranscriber (`src/transcriber/groq.ts`)

Envia audio a la API de Groq para transcripcion. Usa `fetch` nativo de Node 18+ y `FormData` para el multipart, sin dependencias externas.

Formatos soportados: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm.

### MatrixClientWrapper (`src/matrix/client.ts`)

Wrapper sobre `matrix-bot-sdk` que expone una interfaz simplificada:

- `start()` / `stop()` — Inicia/para el sync loop (con E2EE si esta habilitado)
- `sendText()` / `sendNotice()` — Envia mensajes con markdown renderizado a HTML (cifrados automaticamente en rooms E2EE)
- `setTyping()` — Indicador de escritura (best-effort)
- `downloadMedia()` — Descarga ficheros sin encriptar desde URLs `mxc://`
- `downloadEncryptedMedia()` — Descarga y desencripta ficheros E2EE (audio, imagenes, archivos)

Incluye `AutojoinRoomsMixin` para que el bot acepte invitaciones automaticamente.

Al arrancar, imprime en logs el Device ID del bot para facilitar la verificacion manual desde Element.

Cuando E2EE esta activado:
- Se crea un `RustSdkCryptoStorageProvider` que almacena claves Olm/Megolm en SQLite
- El SDK descifra automaticamente eventos `m.room.encrypted` antes de emitir `room.message`
- El SDK cifra automaticamente al enviar mensajes a rooms encriptados
- El intercambio de claves (key claim, key upload) es transparente
- Media encriptados (audio, imagenes) se descargan via el endpoint autenticado `/_matrix/client/v1/media/download/` y se desencriptan con `Attachment.decrypt()` del Rust crypto SDK

### BridgeRunner (`src/bridge/bridge-runner.ts`)

Orquestador del modo bridge. Gestiona:

- **TmuxManager**: crea/destruye sesiones tmux por room de Matrix
- **IpcServer**: Unix socket que recibe payloads de los hooks de Claude Code
- **HookInjector**: genera la configuracion `--settings` con hooks que reenvian eventos al IPC socket
- **TranscriptReader**: lee la ultima respuesta del transcript JSONL de Claude

### IdeRunner (`src/ide/ide-runner.ts`)

Orquestador del modo IDE. Gestiona:

- **McpServer**: servidor WebSocket MCP por room, implementa el protocolo JSON-RPC 2.0
- **Subprocess one-shot**: `claude -p "prompt" --output-format json --ide` por mensaje
- **Diff review**: forwarda diffs a Matrix y espera aprobacion/rechazo del usuario
- **Deferred responses**: almacena request IDs para completar cuando el usuario responde

### McpServer (`src/ide/mcp-server.ts`)

Servidor WebSocket que implementa el protocolo MCP (Model Context Protocol) version `2024-11-05`. Mismo protocolo que usan VS Code, JetBrains y Emacs (monet.el).

- Escucha en un puerto aleatorio en `127.0.0.1`
- Crea lockfile en `~/.claude/ide/{PORT}.lock` para que Claude Code lo descubra
- Maneja JSON-RPC 2.0: `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`
- Tools expuestas: `openFile`, `saveDocument`, `getDiagnostics`, `openDiff`, `getWorkspaceFolders`, `getCurrentSelection`, `getLatestSelection`, `checkDocumentDirty`, `getOpenEditors`, `closeAllDiffTabs`, `close_tab`
- Tools simples se resuelven localmente; tools complejas (`openDiff`) se forwardean a Matrix
- Keepalive: `notifications/tools/list_changed` cada 30s

### E2EE: Flujo de claves

```
1. Bot arranca -> crypto.prepare() inicializa OlmMachine
2. Se suben device keys y one-time keys al homeserver
3. Al entrar a un room E2EE, se intercambian claves Megolm via to-device messages
4. Cada sync procesa primero to-device messages (para tener claves antes de eventos)
5. Luego procesa room events, descifrando los m.room.encrypted
6. Al enviar, se cifra con las claves Megolm del room
```

## Patrones de diseno

### Inspirado por el bot de Telegram

| Patron | Origen | Adaptacion |
|--------|--------|-----------|
| Cola serial | Tutorial Telegram | Misma logica, tipada con generics |
| Sesiones con `--resume` | Tutorial Telegram | Por room de Matrix en vez de chat de Telegram |
| stdin `'ignore'` | Tutorial Telegram | Critico — sin esto Claude se cuelga |
| Env explicito | Tutorial Telegram | Misma tecnica para PM2 |
| Split de mensajes | Tutorial Telegram | Mismo limite de 4096 chars |
| Timeout configurable | Tutorial Telegram | Via env var en vez de constante |

### Inspirado por Jackpoint

| Patron | Origen | Adaptacion |
|--------|--------|-----------|
| matrix-bot-sdk | Jackpoint | Misma SDK, version publicada en npm |
| AutojoinRoomsMixin | Jackpoint | Para que el bot acepte DMs |
| Typing indicators | Jackpoint | Mientras Claude trabaja |
| Silenciar logs del SDK | Jackpoint | LogService.setLevel(WARN) |

### Mejoras propias

| Mejora | Descripcion |
|--------|------------|
| TypeScript strict | Tipos en toda la base de codigo |
| Config via env vars | Todo configurable, defaults sensatos |
| Groq API | Sin whisper.cpp local (sin compilar C++, sin 388MB RAM) |
| E2EE nativo | Soporte completo de encriptacion end-to-end |
| E2EE media | Descarga y desencriptacion de audio/imagenes encriptados |
| Markdown HTML | Renderizado de markdown a HTML con `marked` en mensajes Matrix |
| Tres modos | Bot (one-shot), Bridge (tmux+hooks), IDE (MCP WebSocket) |
| Protocolo MCP | Mismo protocolo IDE que VS Code/JetBrains/Emacs |
| Tests unitarios | 23 tests con vitest |
| Modular | Cada componente en su directorio con barrel exports |
