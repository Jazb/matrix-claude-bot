# Referencia de la API interna

Documentacion de las clases, interfaces y funciones exportadas por cada modulo.

## config/

### `loadConfig(): AppConfig`

Carga toda la configuracion desde variables de entorno. Sale con `process.exit(1)` si falta una variable requerida o el formato es invalido.

### `AppConfig`

```typescript
interface AppConfig {
  matrix: MatrixConfig;
  projects: ProjectsConfig;
  claude: ClaudeConfig;
  groq: GroqConfig;
  bot: BotConfig;
}
```

### `MatrixConfig`

```typescript
interface MatrixConfig {
  homeserverUrl: string;      // URL del homeserver
  accessToken: string;        // Token de acceso del bot
  allowedUserId: string;      // User ID autorizado (@user:server)
  enableE2ee: boolean;        // Activar encriptacion end-to-end
  cryptoStoragePath: string;  // Directorio para claves E2EE (SQLite)
}
```

### `ProjectsConfig`

```typescript
interface ProjectsConfig {
  projects: Record<string, string>;  // nombre -> ruta absoluta
  defaultProject: string;            // proyecto por defecto
}
```

### `ClaudeConfig`

```typescript
interface ClaudeConfig {
  binaryPath: string;  // Ruta al binario de claude
  timeout: number;     // Timeout en ms
  maxTurns: number;    // Turnos agenticos maximos
}
```

### `GroqConfig`

```typescript
interface GroqConfig {
  apiKey: string;    // API key de Groq
  model: string;     // Modelo Whisper
  endpoint: string;  // URL del endpoint
  language: string;  // Idioma o "auto"
}
```

### `BotConfig`

```typescript
interface BotConfig {
  maxMessageLength: number;  // Chars maximos por mensaje
  tmpDir: string;            // Directorio temporal
  sessionsFile: string;      // Ruta del fichero de sesiones
  logLevel: string;          // debug|info|warn|error
}
```

### `BridgeConfig`

```typescript
interface BridgeConfig {
  mode: "bot" | "bridge" | "ide";  // Modo de operacion
  claudeArgs: string[];            // Args extra para Claude (ej: ["--model", "sonnet"])
  socketDir: string;               // Directorio para Unix sockets IPC (bridge)
  hookTimeout: number;             // Timeout de hooks en ms (bridge)
}
```

---

## claude/

### `class SessionStore`

Persiste sesiones de Claude Code por room de Matrix.

**Constructor:**

```typescript
new SessionStore(filePath: string)
```

Carga el fichero JSON si existe. Si esta corrupto, empieza con un mapa vacio.

**Metodos:**

| Metodo | Descripcion |
|--------|------------|
| `get(roomId: string): SessionData \| null` | Obtiene la sesion de un room |
| `set(roomId: string, data: Partial<SessionData>): void` | Actualiza (merge) la sesion de un room |
| `clear(roomId: string): void` | Elimina la sesion de un room |

### `SessionData`

```typescript
interface SessionData {
  sessionId: string | null;  // ID de sesion de Claude para --resume
  project: string;           // Nombre del proyecto activo
}
```

### `class ClaudeRunner`

Ejecuta prompts en Claude Code como subproceso.

**Constructor:**

```typescript
new ClaudeRunner(
  config: ClaudeConfig,
  projectsConfig: ProjectsConfig,
  sessions: SessionStore,
  queue: SerialQueue,
)
```

**Metodos:**

| Metodo | Descripcion |
|--------|------------|
| `run(roomId: string, prompt: string): Promise<string>` | Ejecuta un prompt y devuelve la respuesta |

El metodo `run`:
1. Busca la sesion del room para obtener proyecto y session_id
2. Construye los argumentos: `-p`, `--output-format json`, `--max-turns`, `--resume`
3. Spawna el proceso con env explicito y stdin cerrado
4. Parsea el JSON de salida
5. Guarda el session_id para futuros mensajes
6. Devuelve el texto de la respuesta

---

## transcriber/

### `class GroqTranscriber`

Transcribe audio a texto via la API de Groq.

**Constructor:**

```typescript
new GroqTranscriber(config: GroqConfig)
```

**Metodos y propiedades:**

| Miembro | Descripcion |
|---------|------------|
| `transcribe(filePath: string): Promise<string>` | Transcribe un fichero de audio |
| `available: boolean` (getter) | `true` si hay API key configurada |

El metodo `transcribe`:
1. Lee el fichero de disco
2. Determina el MIME type por extension
3. Construye un FormData con file, model, response_format, temperature, language
4. POST al endpoint de Groq con Authorization bearer
5. Parsea la respuesta y devuelve el texto

---

## queue/

### `class SerialQueue`

Cola FIFO que ejecuta una tarea a la vez.

**Metodos y propiedades:**

| Miembro | Descripcion |
|---------|------------|
| `enqueue<T>(task: () => Promise<T>): Promise<T>` | Encola una tarea. Resuelve cuando completa |
| `setChildProcess(cp: ChildProcess): void` | Asocia un proceso hijo a la tarea actual |
| `cancelCurrent(): boolean` | Envia SIGTERM al proceso actual |
| `length: number` (getter) | Numero de tareas pendientes |
| `busy: boolean` (getter) | `true` si hay una tarea ejecutandose |

---

## matrix/

### `createMatrixClient(matrixConfig, botConfig): Promise<MatrixClientWrapper>`

Crea y valida un cliente Matrix. Configura auto-join y silencia los logs del SDK.

### `MatrixClientWrapper`

```typescript
interface MatrixClientWrapper {
  client: MatrixClient;   // Instancia raw de matrix-bot-sdk
  userId: string;         // User ID del bot
  start(): Promise<void>; // Inicia sync loop + imprime device info para verificacion
  stop(): void;           // Para el sync loop
  sendText(roomId: string, text: string): Promise<string>;    // Renderiza markdown a HTML
  sendNotice(roomId: string, text: string): Promise<string>;  // Notice sin formato
  setTyping(roomId: string, typing: boolean): Promise<void>;
  downloadMedia(mxcUrl: string, destPath: string): Promise<void>;                // Media sin encriptar
  downloadEncryptedMedia(file: EncryptedFileInfo, destPath: string): Promise<void>; // Media E2EE
}
```

### `EncryptedFileInfo`

Metadata de un archivo encriptado en un mensaje E2EE. Corresponde al campo `content.file` del evento Matrix.

```typescript
interface EncryptedFileInfo {
  url: string;        // URL mxc:// del archivo encriptado
  key: { kty: "oct"; key_ops: string[]; alg: "A256CTR"; k: string; ext: true };
  iv: string;         // Initialization vector
  hashes: Record<string, string>;  // SHA-256 hash del contenido encriptado
  v: string;          // Version del esquema de encriptacion
}
```

La descarga de media encriptados usa el endpoint autenticado `/_matrix/client/v1/media/download/` (ya que matrix.org depreco el endpoint legacy `/_matrix/media/v3/download/`) y desencripta con `Attachment.decrypt()` del Rust crypto SDK.

---

## bridge/

### `class BridgeRunner`

Orquestador del modo bridge (tmux + hooks).

**Constructor:**

```typescript
new BridgeRunner(config: AppConfig, matrix: MatrixClientWrapper, sessionStore: SessionStore)
```

**Metodos:**

| Metodo | Descripcion |
|--------|------------|
| `handleMessage(roomId: string, prompt: string): Promise<string \| null>` | Inyecta prompt en tmux y espera respuesta |
| `newSession(roomId: string): Promise<void>` | Destruye sesion tmux y limpia estado |
| `cancel(roomId: string): boolean` | Cancela la tarea actual |
| `getStatus(roomId: string, lines?: number): { alive: boolean; output?: string }` | Estado de la sesion tmux |
| `stop(): void` | Limpia todas las sesiones y el IPC server |

---

## ide/

### `class IdeRunner`

Orquestador del modo IDE (MCP WebSocket + subprocess one-shot).

**Constructor:**

```typescript
new IdeRunner(config: AppConfig, matrix: MatrixClientWrapper, sessionStore: SessionStore)
```

**Metodos:**

| Metodo | Descripcion |
|--------|------------|
| `handleMessage(roomId: string, prompt: string): Promise<string \| null>` | Lanza `claude -p --ide` y devuelve respuesta |
| `newSession(roomId: string): Promise<void>` | Para el MCP server del room y limpia sesion |
| `cancel(roomId: string): boolean` | Cancela el subprocess actual |
| `getStatus(roomId: string): { alive: boolean; connected: boolean }` | Estado del MCP server |
| `handleDiffResponse(roomId: string, text: string): boolean` | Procesa respuesta a un diff (y/n). Retorna true si lo manejo |
| `stop(): void` | Limpia todos los MCP servers y cancela tareas |

### `class McpServer`

Servidor WebSocket que implementa el protocolo MCP (Model Context Protocol) version `2024-11-05`.

**Constructor:**

```typescript
new McpServer(workspaceFolders: string[], sessionName: string)
```

**Metodos:**

| Metodo | Descripcion |
|--------|------------|
| `start(): void` | Inicia el WebSocket server y crea lockfile |
| `stop(): void` | Para el server y elimina lockfile |
| `connected: boolean` (getter) | True si Claude Code esta conectado |
| `sendToolResponse(requestId, content): void` | Envia respuesta de tool a Claude |
| `sendToolError(requestId, message): void` | Envia error de tool a Claude |
| `storeDeferredResponse(uniqueKey, requestId): void` | Almacena respuesta diferida |
| `completeDeferredResponse(uniqueKey, content): void` | Completa una respuesta diferida |
| `sendNotification(method, params?): void` | Envia notificacion JSON-RPC |

**Eventos emitidos:**

| Evento | Parametros | Descripcion |
|--------|-----------|-------------|
| `connected` | — | Claude Code conecto al WebSocket |
| `disconnected` | — | Claude Code desconecto |
| `tool_call` | `(requestId, toolName, args)` | Claude invoca una tool |

---

## utils/

### `createLogger(component: string)`

Devuelve un objeto logger con metodos `debug`, `info`, `warn`, `error`. Los logs se escriben en stderr con formato:

```
2024-01-15T10:30:00.000Z [INFO] [component] mensaje
```

### `setLogLevel(level: string): void`

Establece el nivel minimo de log. Los niveles son: `debug` < `info` < `warn` < `error`.

### `splitMessage(text: string, maxLength: number): string[]`

Divide un texto largo en chunks que no excedan `maxLength`. Intenta cortar por saltos de linea, luego por espacios, y como ultimo recurso hace un corte duro.
