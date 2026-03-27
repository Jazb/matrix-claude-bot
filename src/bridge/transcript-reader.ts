/**
 * Transcript Reader — Extracts the last assistant message from Claude's JSONL transcript.
 *
 * Claude Code writes a transcript file in JSONL format. Each line is a JSON object
 * with a `message` field containing `role` and `content`. We read from the end
 * to find the last assistant message with text content.
 *
 * Ported from Jackpoint's Stop hook handler logic.
 */

import { readFileSync } from "fs";
import { createLogger } from "../utils/logger.js";

const log = createLogger("transcript");

interface TranscriptEntry {
  message?: {
    role: string;
    content: Array<{ type: string; text?: string }> | string;
  };
}

/**
 * Read the last assistant message from a Claude transcript JSONL file.
 * Returns null if the transcript can't be read or no assistant message is found.
 */
export function readLastAssistantMessage(transcriptPath: string): string | null {
  try {
    const lines = readFileSync(transcriptPath, "utf-8").trim().split("\n");

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]) as TranscriptEntry;
        const msg = entry.message;

        if (!msg || msg.role !== "assistant" || !msg.content) continue;

        if (typeof msg.content === "string") {
          return msg.content;
        }

        if (Array.isArray(msg.content)) {
          const textParts = msg.content
            .filter((c) => c.type === "text" && c.text)
            .map((c) => c.text!);

          if (textParts.length > 0) {
            return textParts.join("\n");
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    return null;
  } catch (err) {
    log.debug(`Error reading transcript: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
