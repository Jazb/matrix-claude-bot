import { describe, it, expect } from "vitest";
import { splitMessage } from "../src/utils/split-message.js";

describe("splitMessage", () => {
  it("returns a single chunk when text fits within limit", () => {
    const result = splitMessage("hello world", 100);
    expect(result).toEqual(["hello world"]);
  });

  it("returns empty array content for empty string", () => {
    const result = splitMessage("", 100);
    expect(result).toEqual([""]);
  });

  it("splits at newlines when possible", () => {
    const text = "line one\nline two\nline three";
    const result = splitMessage(text, 18);
    // "line one\nline two" = 17 chars, fits
    // "line three" = 10 chars
    expect(result).toEqual(["line one\nline two", "line three"]);
  });

  it("splits at spaces when no newline available", () => {
    const text = "word1 word2 word3 word4";
    const result = splitMessage(text, 12);
    // "word1 word2" = 11, fits
    // "word3 word4" = 11, fits
    expect(result).toEqual(["word1 word2", "word3 word4"]);
  });

  it("hard-splits when no good break point", () => {
    const text = "a".repeat(20);
    const result = splitMessage(text, 10);
    expect(result).toEqual(["a".repeat(10), "a".repeat(10)]);
  });

  it("handles exact length text", () => {
    const text = "12345";
    const result = splitMessage(text, 5);
    expect(result).toEqual(["12345"]);
  });

  it("produces chunks that respect max length", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(20);
    const maxLen = 100;
    const chunks = splitMessage(text, maxLen);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(maxLen);
    }
    // Verify all content is preserved (after trimming whitespace from splits)
    expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toEqual(
      text.replace(/\s+/g, " ").trim(),
    );
  });
});
