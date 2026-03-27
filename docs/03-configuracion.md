# Configuracion

Toda la configuracion se carga desde variables de entorno. El bot valida las variables requeridas al arrancar y sale con un error claro si falta alguna.

## Variables de entorno

### Requeridas

| Variable | Descripcion | Ejemplo |
|----------|------------|---------|
| `MATRIX_HOMESERVER_URL` | URL del homeserver Matrix | `https://matrix.org` |
| `MATRIX_ACCESS_TOKEN` | Access token del bot (del login programatico) | `mct_abc123...` |
| `MATRIX_ALLOWED_USER_ID` | User ID de Matrix autorizado | `@usuario:matrix.org` |
| `PROJECTS` | Proyectos como pares `nombre=ruta` separados por coma | `web=/home/user/web,api=/home/user/api` |
| `GROQ_API_KEY` | API key de Groq para transcripcion | `gsk_abc123...` |

Ademas, necesitas **una** de estas para autenticar Claude Code:

| Variable | Descripcion |
|----------|------------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Token OAuth de Claude Code (obtenido con `claude setup-token`) |
| `ANTHROPIC_API_KEY` | API key directa de Anthropic |

### Opcionales (con defaults)

| Variable | Default | Descripcion |
|----------|---------|------------|
| `DEFAULT_PROJECT` | Primer proyecto de `PROJECTS` | Proyecto activo al iniciar |
| `CLAUDE_BINARY_PATH` | `/usr/bin/claude` | Ruta absoluta al binario de Claude |
| `CLAUDE_TIMEOUT` | `300000` (5 min) | Timeout maximo en ms por invocacion |
| `CLAUDE_MAX_TURNS` | `25` | Turnos agenticos maximos por invocacion |
| `MATRIX_ENABLE_E2EE` | `true` | Activar encriptacion end-to-end |
| `MATRIX_CRYPTO_STORAGE_PATH` | `./data/crypto` | Directorio para claves E2EE (SQLite) |
| `GROQ_MODEL` | `whisper-large-v3-turbo` | Modelo Whisper a usar |
| `GROQ_ENDPOINT` | `https://api.groq.com/openai/v1/audio/transcriptions` | Endpoint de la API |
| `GROQ_LANGUAGE` | `auto` | Idioma del audio (ISO-639-1 o `auto`) |
| `MAX_MESSAGE_LENGTH` | `4096` | Caracteres maximos por mensaje Matrix |
| `TMP_DIR` | `/tmp/matrix-claude-bot` | Directorio para archivos temporales |
| `SESSIONS_FILE` | `./data/sessions.json` | Ruta al fichero de sesiones |
| `LOG_LEVEL` | `info` | Nivel de log: `debug`, `info`, `warn`, `error` |

### Modo de operacion

| Variable | Default | Descripcion |
|----------|---------|------------|
| `BOT_MODE` | `bot` | Modo de operacion: `bot`, `bridge` o `ide` |
| `CLAUDE_EXTRA_ARGS` | (vacio) | Args extra para Claude en bridge/ide (ej: `--model,sonnet`) |
| `BRIDGE_SOCKET_DIR` | `/tmp` | Directorio para Unix sockets IPC (solo bridge) |
| `BRIDGE_HOOK_TIMEOUT` | `10000` | Timeout de hooks en ms (solo bridge) |

**Modos disponibles:**

- **`bot`** (default): subprocess one-shot `claude -p` por mensaje. Simple, robusto, bajo consumo.
- **`bridge`**: Claude interactivo en tmux con hooks. Permite aprobar herramientas dinamicamente desde Matrix. Requiere tmux instalado.
- **`ide`** (recomendado): protocolo MCP nativo via WebSocket. Misma fiabilidad que bot + interactividad del protocolo IDE. Soporta diff review desde Matrix.

## Formato de PROJECTS

La variable `PROJECTS` usa un formato de pares separados por coma:

```
PROJECTS=nombre1=/ruta/absoluta/1,nombre2=/ruta/absoluta/2
```

Reglas:
- Los nombres se normalizan a minusculas
- Las rutas deben ser absolutas
- Al menos un proyecto es obligatorio
- Los espacios alrededor de las comas y el `=` se ignoran

Ejemplos validos:

```bash
# Un solo proyecto
PROJECTS=web=/home/user/webapp

# Varios proyectos
PROJECTS=frontend=/home/user/frontend, backend=/home/user/backend, infra=/home/user/terraform

# Con espacios (se ignoran)
PROJECTS= web = /home/user/web , api = /home/user/api
```

## Fichero .env

Para desarrollo local, crea un fichero `.env` en la raiz del proyecto:

```bash
cp .env.example .env
chmod 600 .env  # proteger tokens
```

El fichero `.env` NO se carga automaticamente. Para cargar las variables:

```bash
# Opcion 1: bash source
bash -c 'set -a && source .env && set +a && npx tsx src/index.ts'

# Opcion 2: PM2 ecosystem (recomendado para produccion)
```

## Configuracion PM2

Para produccion con PM2, copia y edita el fichero de ejemplo:

```bash
cp ecosystem.config.example.cjs ecosystem.config.cjs
chmod 600 ecosystem.config.cjs
```

```javascript
module.exports = {
  apps: [{
    name: "matrix-claude-bot",
    script: "dist/index.js",
    cwd: "/opt/matrix-claude-bot",
    env: {
      HOME: "/root",
      MATRIX_HOMESERVER_URL: "https://matrix.org",
      MATRIX_ACCESS_TOKEN: "mct_tu_token",
      MATRIX_ALLOWED_USER_ID: "@tu_usuario:matrix.org",
      MATRIX_ENABLE_E2EE: "true",
      MATRIX_CRYPTO_STORAGE_PATH: "./data/crypto",
      PROJECTS: "miproyecto=/home/user/miproyecto",
      GROQ_API_KEY: "gsk_tu_key",
      CLAUDE_CODE_OAUTH_TOKEN: "tu_oauth_token",
      LOG_LEVEL: "info",
    },
    max_memory_restart: "200M",
    restart_delay: 5000,
    max_restarts: 10,
    autorestart: true,
  }],
};
```

Notas:
- `HOME` es necesario para que Claude encuentre `~/.claude/settings.json`
- `max_memory_restart` reinicia el bot si consume mas de 200MB
- `restart_delay` espera 5 segundos entre reinicios para evitar bucles
- `MATRIX_CRYPTO_STORAGE_PATH` debe ser persistente — si se borra, se pierden las claves E2EE

## Esquema de tipos

La configuracion esta completamente tipada en `src/config/schema.ts`:

```typescript
interface AppConfig {
  matrix: MatrixConfig;    // homeserverUrl, accessToken, allowedUserId, enableE2ee, cryptoStoragePath
  projects: ProjectsConfig; // projects (map), defaultProject
  claude: ClaudeConfig;     // binaryPath, timeout, maxTurns
  groq: GroqConfig;         // apiKey, model, endpoint, language
  bot: BotConfig;           // maxMessageLength, tmpDir, sessionsFile, logLevel
  bridge: BridgeConfig;     // mode, claudeArgs, socketDir, hookTimeout
}
```

Cada interfaz esta documentada con JSDoc inline. Consulta `src/config/schema.ts` para la referencia completa.
