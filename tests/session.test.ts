import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionStore } from "../src/claude/session.js";
import { existsSync, unlinkSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("SessionStore", () => {
  const testDir = join(tmpdir(), "matrix-claude-bot-test-sessions");
  const testFile = join(testDir, "sessions.json");

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  it("returns null for unknown rooms", () => {
    const store = new SessionStore(testFile);
    expect(store.get("!unknown:room")).toBeNull();
  });

  it("stores and retrieves session data", () => {
    const store = new SessionStore(testFile);
    store.set("!room:test", { sessionId: "abc-123", project: "myproject" });

    const session = store.get("!room:test");
    expect(session).toEqual({ sessionId: "abc-123", project: "myproject" });
  });

  it("persists sessions across instances", () => {
    const store1 = new SessionStore(testFile);
    store1.set("!room:test", { sessionId: "abc-123", project: "myproject" });

    const store2 = new SessionStore(testFile);
    expect(store2.get("!room:test")).toEqual({ sessionId: "abc-123", project: "myproject" });
  });

  it("clears a session", () => {
    const store = new SessionStore(testFile);
    store.set("!room:test", { sessionId: "abc-123", project: "myproject" });
    store.clear("!room:test");
    expect(store.get("!room:test")).toBeNull();
  });

  it("merges partial updates", () => {
    const store = new SessionStore(testFile);
    store.set("!room:test", { sessionId: "abc-123", project: "proj1" });
    store.set("!room:test", { sessionId: "def-456" });

    const session = store.get("!room:test");
    expect(session?.sessionId).toBe("def-456");
    expect(session?.project).toBe("proj1");
  });

  it("handles corrupt file gracefully", async () => {
    const { writeFileSync } = await import("fs");
    writeFileSync(testFile, "not json{{{");

    const store = new SessionStore(testFile);
    expect(store.get("!any:room")).toBeNull();
  });
});
