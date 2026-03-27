import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { readLastAssistantMessage } from "../src/bridge/transcript-reader.js";

const TEST_DIR = join(import.meta.dirname, ".tmp-transcript");

function writeLine(obj: unknown): string {
  return JSON.stringify(obj);
}

beforeEach(() => {
  if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  try {
    const files = ["basic.jsonl", "multi.jsonl", "no-assistant.jsonl", "array-content.jsonl", "empty.jsonl"];
    for (const f of files) {
      try { unlinkSync(join(TEST_DIR, f)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
});

describe("readLastAssistantMessage", () => {
  it("returns text from a simple assistant message", () => {
    const path = join(TEST_DIR, "basic.jsonl");
    const lines = [
      writeLine({ message: { role: "user", content: "Hello" } }),
      writeLine({ message: { role: "assistant", content: "Hi there!" } }),
    ];
    writeFileSync(path, lines.join("\n"));

    expect(readLastAssistantMessage(path)).toBe("Hi there!");
  });

  it("returns the last assistant message when there are multiple", () => {
    const path = join(TEST_DIR, "multi.jsonl");
    const lines = [
      writeLine({ message: { role: "assistant", content: "First response" } }),
      writeLine({ message: { role: "user", content: "Follow up" } }),
      writeLine({ message: { role: "assistant", content: "Second response" } }),
    ];
    writeFileSync(path, lines.join("\n"));

    expect(readLastAssistantMessage(path)).toBe("Second response");
  });

  it("returns null when there are no assistant messages", () => {
    const path = join(TEST_DIR, "no-assistant.jsonl");
    const lines = [
      writeLine({ message: { role: "user", content: "Hello" } }),
    ];
    writeFileSync(path, lines.join("\n"));

    expect(readLastAssistantMessage(path)).toBeNull();
  });

  it("handles array content with text blocks", () => {
    const path = join(TEST_DIR, "array-content.jsonl");
    const lines = [
      writeLine({
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Bash" },
            { type: "text", text: "Here is the result:" },
            { type: "text", text: "All done." },
          ],
        },
      }),
    ];
    writeFileSync(path, lines.join("\n"));

    expect(readLastAssistantMessage(path)).toBe("Here is the result:\nAll done.");
  });

  it("returns null for non-existent file", () => {
    expect(readLastAssistantMessage("/tmp/does-not-exist-12345.jsonl")).toBeNull();
  });

  it("handles empty file", () => {
    const path = join(TEST_DIR, "empty.jsonl");
    writeFileSync(path, "");

    expect(readLastAssistantMessage(path)).toBeNull();
  });
});
