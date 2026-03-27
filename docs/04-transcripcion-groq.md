# Transcripcion de audio con Groq

## Por que Groq y no Whisper local

El bot de Telegram original usa `whisper.cpp` compilado localmente. Esta version usa la API de Groq como alternativa cloud:

| Aspecto | whisper.cpp (local) | Groq API (cloud) |
|---------|--------------------|--------------------|
| Instalacion | Compilar C++ con cmake | Solo una API key |
| RAM | ~388 MB durante transcripcion | 0 MB (todo en Groq) |
| Dependencias | ffmpeg + cmake + build-essential | Ninguna (usa `fetch` nativo) |
| Latencia | 2-5s (depende de CPU) | 1-3s (red + procesamiento) |
| Coste | Gratis (CPU propia) | $0.04/hora de audio (tier gratis disponible) |
| Formatos | Necesita conversion a WAV 16kHz | Acepta OGG, MP3, WAV, FLAC... directamente |
| Privacidad | Todo local | El audio se envia a Groq |

La decision depende de tus prioridades. Si prefieres privacidad total y tienes CPU disponible, whisper.cpp es mejor. Si prefieres simplicidad y baja huella de memoria, Groq es la opcion.

## Configuracion

Variables de entorno:

```bash
# Requerida
GROQ_API_KEY=gsk_tu_api_key

# Opcionales
GROQ_MODEL=whisper-large-v3-turbo     # o whisper-large-v3
GROQ_ENDPOINT=https://api.groq.com/openai/v1/audio/transcriptions
GROQ_LANGUAGE=auto                     # o es, en, fr, de, etc.
```

### Modelos disponibles

| Modelo | Coste/hora | Error rate | Velocidad |
|--------|-----------|-----------|-----------|
| `whisper-large-v3-turbo` | $0.04 | 12% WER | Rapido |
| `whisper-large-v3` | $0.111 | Menor WER | Mas lento |

El modelo turbo es el default por su buena relacion calidad/velocidad.

### Idioma

- `auto` (default): Groq detecta el idioma automaticamente. Funciona bien con la mayoria de idiomas.
- Codigo ISO-639-1 (ej: `es`, `en`, `fr`): Fuerza un idioma especifico. Puede mejorar la precision si sabes que todos los audios seran en el mismo idioma.

## Formatos de audio soportados

Groq acepta directamente estos formatos sin conversion previa:

| Formato | Extension | MIME type |
|---------|----------|-----------|
| FLAC | `.flac` | `audio/flac` |
| MP3 | `.mp3` | `audio/mpeg` |
| MP4 | `.mp4` | `audio/mp4` |
| MPEG | `.mpeg` | `audio/mpeg` |
| MPGA | `.mpga` | `audio/mpeg` |
| M4A | `.m4a` | `audio/mp4` |
| OGG | `.ogg` | `audio/ogg` |
| WAV | `.wav` | `audio/wav` |
| WebM | `.webm` | `audio/webm` |

La mayoria de clientes Matrix (Element, FluffyChat) envian notas de voz en formato OGG/Opus, que Groq acepta directamente.

## Limites

- Tamano maximo de archivo: 25 MB (tier gratis) o 100 MB (tier dev)
- Rate limits: dependen de tu plan en Groq
- El audio se descarga primero del homeserver Matrix a `/tmp/` y luego se envia a Groq

## Como funciona internamente

```
1. El bot recibe un evento Matrix con msgtype "m.audio"
2. Extrae la URL mxc:// y el mimetype del contenido
3. Descarga el fichero a TMP_DIR (ej: /tmp/matrix-claude-bot/audio_1710288000000.ogg)
4. Lee el fichero y crea un Blob con el mimetype correcto
5. Construye un FormData con: file, model, response_format, temperature, language
6. POST a la API de Groq con Authorization: Bearer <api_key>
7. Parsea la respuesta JSON y extrae el campo "text"
8. Devuelve el texto transcrito al flujo principal
```

## Implementacion

La clase `GroqTranscriber` (`src/transcriber/groq.ts`) es independiente del resto del bot. Recibe la configuracion por constructor y expone dos miembros:

- `transcribe(filePath)` — Transcribe un fichero de audio y devuelve el texto.
- `available` (getter) — Devuelve `true` si hay API key configurada.

No tiene dependencias externas: usa `fetch` y `FormData` nativos de Node 18+.
