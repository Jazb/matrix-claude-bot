import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { checkCredentials } from "../src/health/server.js";

describe("checkCredentials", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "creds-test-"));
    file = join(dir, ".credentials.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(oauth: Record<string, unknown>) {
    writeFileSync(file, JSON.stringify({ claudeAiOauth: oauth }));
  }

  it("reports ok for a token valid well into the future", () => {
    write({ expiresAt: Date.now() + 86_400_000, refreshToken: "rt" });

    const result = checkCredentials(file);

    expect(result.status).toBe("ok");
    expect(result.canRefresh).toBe(true);
  });

  it("reports expired for a token past its expiry", () => {
    const expiredAt = Date.now() - 86_400_000;
    write({ expiresAt: expiredAt });

    const result = checkCredentials(file);

    expect(result.status).toBe("expired");
    expect(result.canRefresh).toBe(false);
    expect(result.expiresAt).toBe(new Date(expiredAt).toISOString());
  });

  // The nexusd outage: expired months earlier with no refresh token, so no
  // restart could ever recover it.
  it("flags an expired token with no refresh token as unrecoverable", () => {
    write({ expiresAt: Date.parse("2026-06-20T05:27:36.351Z") });

    const result = checkCredentials(file);

    expect(result.status).toBe("expired");
    expect(result.canRefresh).toBe(false);
  });

  it("reports expiring when the token lapses soon and cannot self-refresh", () => {
    write({ expiresAt: Date.now() + 60_000 });

    expect(checkCredentials(file).status).toBe("expiring");
  });

  it("stays ok when expiry is imminent but a refresh token exists", () => {
    write({ expiresAt: Date.now() + 60_000, refreshToken: "rt" });

    expect(checkCredentials(file).status).toBe("ok");
  });

  it("reports unreadable when the file is missing", () => {
    const result = checkCredentials(join(dir, "does-not-exist.json"));

    expect(result.status).toBe("unreadable");
    expect(result.detail).toBeTruthy();
  });

  it("reports unreadable on malformed JSON instead of throwing", () => {
    writeFileSync(file, "{not json");

    expect(checkCredentials(file).status).toBe("unreadable");
  });

  it("reports unreadable when expiresAt is absent", () => {
    write({ refreshToken: "rt" });

    const result = checkCredentials(file);

    expect(result.status).toBe("unreadable");
    expect(result.detail).toContain("expiresAt");
  });
});
