import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("loadConfig", () => {
  const originalEnv = { ...process.env };

  function setRequiredEnv() {
    process.env["MATRIX_HOMESERVER_URL"] = "https://matrix.test";
    process.env["MATRIX_ACCESS_TOKEN"] = "syt_test_token";
    process.env["MATRIX_ALLOWED_USER_ID"] = "@user:matrix.test";
    process.env["PROJECTS"] = "myproject=/tmp/test-project";
    process.env["GROQ_API_KEY"] = "gsk_test_key";
  }

  beforeEach(() => {
    // Clean env before each test
    for (const key of Object.keys(process.env)) {
      if (
        key.startsWith("MATRIX_") ||
        key.startsWith("CLAUDE_") ||
        key.startsWith("GROQ_") ||
        key === "PROJECTS" ||
        key === "DEFAULT_PROJECT" ||
        key === "MAX_MESSAGE_LENGTH" ||
        key === "TMP_DIR" ||
        key === "SESSIONS_FILE" ||
        key === "LOG_LEVEL"
      ) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("loads all required config from env vars", async () => {
    setRequiredEnv();
    const { loadConfig } = await import("../src/config/loader.js");
    const config = loadConfig();

    expect(config.matrix.homeserverUrl).toBe("https://matrix.test");
    expect(config.matrix.accessToken).toBe("syt_test_token");
    expect(config.matrix.allowedUserId).toBe("@user:matrix.test");
    expect(config.projects.projects).toEqual({ myproject: "/tmp/test-project" });
    expect(config.projects.defaultProject).toBe("myproject");
    expect(config.groq.apiKey).toBe("gsk_test_key");
  });

  it("uses sensible defaults for optional values", async () => {
    setRequiredEnv();
    const { loadConfig } = await import("../src/config/loader.js");
    const config = loadConfig();

    expect(config.claude.binaryPath).toBe("/usr/bin/claude");
    expect(config.claude.timeout).toBe(300000);
    expect(config.claude.maxTurns).toBe(25);
    expect(config.groq.model).toBe("whisper-large-v3-turbo");
    expect(config.bot.maxMessageLength).toBe(4096);
  });

  it("parses multiple projects", async () => {
    setRequiredEnv();
    process.env["PROJECTS"] = "proj1=/tmp/p1, proj2=/tmp/p2, proj3=/tmp/p3";
    const { loadConfig } = await import("../src/config/loader.js");
    const config = loadConfig();

    expect(Object.keys(config.projects.projects)).toEqual(["proj1", "proj2", "proj3"]);
    expect(config.projects.projects["proj2"]).toBe("/tmp/p2");
  });

  it("defaults to first project when DEFAULT_PROJECT not set", async () => {
    setRequiredEnv();
    process.env["PROJECTS"] = "alpha=/tmp/a, beta=/tmp/b";
    const { loadConfig } = await import("../src/config/loader.js");
    const config = loadConfig();

    expect(config.projects.defaultProject).toBe("alpha");
  });

  it("respects DEFAULT_PROJECT override", async () => {
    setRequiredEnv();
    process.env["PROJECTS"] = "alpha=/tmp/a, beta=/tmp/b";
    process.env["DEFAULT_PROJECT"] = "beta";
    const { loadConfig } = await import("../src/config/loader.js");
    const config = loadConfig();

    expect(config.projects.defaultProject).toBe("beta");
  });
});
