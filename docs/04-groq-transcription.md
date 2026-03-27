# Audio Transcription with Groq

## Why Groq and Not Local Whisper

The original Telegram bot uses locally compiled `whisper.cpp`. This version uses the Groq API as a cloud alternative:

| Aspect | whisper.cpp (local) | Groq API (cloud) |
|---------|--------------------|--------------------|
| Installation | Compile C++ with cmake | Just an API key |
| RAM | ~388 MB during transcription | 0 MB (everything on Groq) |
| Dependencies | ffmpeg + cmake + build-essential | None (uses native `fetch`) |
| Latency | 2-5s (depends on CPU) | 1-3s (network + processing) |
| Cost | Free (own CPU) | $0.04/hour of audio (free tier available) |
| Formats | Requires conversion to WAV 16kHz | Accepts OGG, MP3, WAV, FLAC... directly |
| Privacy | Everything local | Audio is sent to Groq |

The decision depends on your priorities. If you prefer total privacy and have available CPU, whisper.cpp is better. If you prefer simplicity and a low memory footprint, Groq is the option.

## Configuration

Environment variables:

```bash
# Required
GROQ_API_KEY=gsk_your_api_key

# Optional
GROQ_MODEL=whisper-large-v3-turbo     # or whisper-large-v3
GROQ_ENDPOINT=https://api.groq.com/openai/v1/audio/transcriptions
GROQ_LANGUAGE=auto                     # or es, en, fr, de, etc.
```

### Available Models

| Model | Cost/hour | Error rate | Speed |
|--------|-----------|-----------|-----------|
| `whisper-large-v3-turbo` | $0.04 | 12% WER | Fast |
| `whisper-large-v3` | $0.111 | Lower WER | Slower |

The turbo model is the default due to its good quality/speed ratio.

### Language

- `auto` (default): Groq detects the language automatically. Works well with most languages.
- ISO-639-1 code (e.g.: `es`, `en`, `fr`): Forces a specific language. Can improve accuracy if you know all audio will be in the same language.

## Supported Audio Formats

Groq accepts these formats directly without prior conversion:

| Format | Extension | MIME type |
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

Most Matrix clients (Element, FluffyChat) send voice notes in OGG/Opus format, which Groq accepts directly.

## Limits

- Maximum file size: 25 MB (free tier) or 100 MB (dev tier)
- Rate limits: depend on your Groq plan
- Audio is first downloaded from the Matrix homeserver to `/tmp/` and then sent to Groq

## How It Works Internally

```
1. The bot receives a Matrix event with msgtype "m.audio"
2. Extracts the mxc:// URL and the content mimetype
3. Downloads the file to TMP_DIR (e.g.: /tmp/matrix-claude-bot/audio_1710288000000.ogg)
4. Reads the file and creates a Blob with the correct mimetype
5. Builds a FormData with: file, model, response_format, temperature, language
6. POST to the Groq API with Authorization: Bearer <api_key>
7. Parses the JSON response and extracts the "text" field
8. Returns the transcribed text to the main flow
```

## Implementation

The `GroqTranscriber` class (`src/transcriber/groq.ts`) is independent from the rest of the bot. It receives configuration via its constructor and exposes two members:

- `transcribe(filePath)` — Transcribes an audio file and returns the text.
- `available` (getter) — Returns `true` if an API key is configured.

It has no external dependencies: it uses native `fetch` and `FormData` from Node 18+.
