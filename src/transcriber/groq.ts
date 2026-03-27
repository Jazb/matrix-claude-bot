/**
 * Speech-to-text transcription using the Groq API.
 *
 * Sends audio files to Groq's Whisper endpoint and returns the transcribed text.
 * Supports all formats accepted by Groq: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm.
 *
 * Uses the native `fetch` API (Node 18+) and FormData to POST multipart data,
 * avoiding extra dependencies.
 */

import { readFileSync } from "fs";
import { basename } from "path";
import type { GroqConfig } from "../config/schema.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("groq");

/** Supported audio MIME types mapped from file extensions. */
const MIME_TYPES: Record<string, string> = {
  ".flac": "audio/flac",
  ".mp3": "audio/mpeg",
  ".mp4": "audio/mp4",
  ".mpeg": "audio/mpeg",
  ".mpga": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};

export class GroqTranscriber {
  constructor(private readonly config: GroqConfig) {}

  /**
   * Transcribe an audio file to text.
   * @param filePath Absolute path to the audio file on disk.
   * @returns The transcribed text.
   * @throws If the API returns an error or produces empty output.
   */
  async transcribe(filePath: string): Promise<string> {
    const fileName = basename(filePath);
    const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
    const mimeType = MIME_TYPES[ext] ?? "audio/ogg";

    log.info(`Transcribing ${fileName} (${mimeType}) with model ${this.config.model}`);

    const fileBuffer = readFileSync(filePath);
    const blob = new Blob([fileBuffer], { type: mimeType });

    const formData = new FormData();
    formData.append("file", blob, fileName);
    formData.append("model", this.config.model);
    formData.append("response_format", "json");
    formData.append("temperature", "0");

    if (this.config.language !== "auto") {
      formData.append("language", this.config.language);
    }

    const response = await fetch(this.config.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      log.error(`Groq API error ${response.status}: ${errorBody}`);
      throw new Error(`Groq API error (${response.status}): ${errorBody.slice(0, 300)}`);
    }

    const data = (await response.json()) as { text?: string };
    const text = data.text?.trim();

    if (!text) {
      throw new Error("Groq returned an empty transcription");
    }

    log.info(`Transcription complete: ${text.length} chars`);
    log.debug(`Transcription: ${text.slice(0, 200)}`);
    return text;
  }

  /** Check if the transcriber is properly configured (has an API key). */
  get available(): boolean {
    return Boolean(this.config.apiKey);
  }
}
