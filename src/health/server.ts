/**
 * Lightweight HTTP health check server with self-healing watchdog.
 *
 * - GET /health returns 200 when Matrix sync is active, 503 otherwise.
 * - A watchdog timer checks sync health every 60s. If sync has been lost
 *   for more than 5 minutes, the process exits so PM2 can restart it.
 *
 * This solves the boot-without-network problem: the Matrix client retries
 * connection with backoff during startup, and the watchdog catches any
 * post-startup connectivity loss that the SDK doesn't recover from.
 *
 * The report also surfaces Claude Code's OAuth credential state. An expired
 * token leaves the bot "healthy" from Matrix's point of view while every
 * prompt comes back as `API Error: 401` — a silent failure that is otherwise
 * only visible inside the tmux pane. Credentials are reported, never
 * watchdog-killed: restarting cannot refresh a token.
 */

import { createServer, type Server } from "http";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { MatrixClientWrapper } from "../matrix/index.js";
import { createLogger } from "../utils/index.js";

const log = createLogger("health");

const WATCHDOG_INTERVAL = 60_000;   // check every 60s
const GRACE_PERIOD = 120_000;       // don't watchdog-kill within first 2 min
const EXPIRY_WARN_WINDOW = 3_600_000; // flag tokens expiring within the hour

type CredentialsStatus = {
  status: "ok" | "expiring" | "expired" | "unreadable";
  expiresAt?: string;
  canRefresh?: boolean;
  detail?: string;
};

/**
 * Inspect Claude Code's stored OAuth credentials.
 *
 * Returns a descriptive status rather than throwing: this is diagnostic
 * reporting, and a missing file is itself the useful signal.
 */
export function checkCredentials(path?: string): CredentialsStatus {
  const file = path ?? join(homedir(), ".claude", ".credentials.json");

  let oauth: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    oauth = (parsed.claudeAiOauth as Record<string, unknown>) ?? {};
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "unreadable", detail: msg };
  }

  const expiresAt = oauth.expiresAt;
  if (typeof expiresAt !== "number") {
    return { status: "unreadable", detail: "no expiresAt field in claudeAiOauth" };
  }

  const canRefresh = Boolean(oauth.refreshToken);
  const iso = new Date(expiresAt).toISOString();
  const remaining = expiresAt - Date.now();

  // A refresh token makes imminent expiry a non-event: the CLI renews itself.
  if (remaining <= 0) return { status: "expired", expiresAt: iso, canRefresh };
  if (remaining < EXPIRY_WARN_WINDOW && !canRefresh) {
    return { status: "expiring", expiresAt: iso, canRefresh };
  }

  return { status: "ok", expiresAt: iso, canRefresh };
}

export function startHealthServer(
  port: number,
  matrix: MatrixClientWrapper,
  credentialsPath?: string,
): Server {
  const startedAt = Date.now();

  // Surface credential problems at boot: an expired token is otherwise only
  // visible as a 401 inside the tmux pane, long after startup looked clean.
  const boot = checkCredentials(credentialsPath);
  if (boot.status === "expired") {
    log.error(
      `Claude credentials EXPIRED at ${boot.expiresAt} — every prompt will fail with 401. ` +
        `Run: claude /login${boot.canRefresh ? "" : " (no refresh token stored)"}`,
    );
  } else if (boot.status === "expiring") {
    log.warn(`Claude credentials expire at ${boot.expiresAt} and cannot self-refresh — run: claude /login`);
  } else if (boot.status === "unreadable") {
    log.warn(`Could not read Claude credentials: ${boot.detail}`);
  }

  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      const syncing = matrix.isSyncing();
      const uptime = Math.round((Date.now() - startedAt) / 1000);
      const credentials = checkCredentials(credentialsPath);

      // Sync drives the HTTP status because that is what a restart can fix.
      // Bad credentials are reported as "degraded": the bot is running and
      // reachable, but every prompt will fail until someone runs /login.
      const degraded = credentials.status !== "ok";
      const status = syncing ? (degraded ? "degraded" : "ok") : "unhealthy";
      const body = JSON.stringify({ status, syncing, uptime, credentials });

      res.writeHead(syncing ? 200 : 503, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, "127.0.0.1", () => {
    log.info(`Health check listening on http://127.0.0.1:${port}/health`);
  });

  // Watchdog: exit if sync is lost for too long (PM2 will restart)
  const watchdog = setInterval(() => {
    if (Date.now() - startedAt < GRACE_PERIOD) return;

    if (!matrix.isSyncing()) {
      log.error("Watchdog: Matrix sync lost for too long — exiting for PM2 restart");
      server.close();
      process.exit(1);
    }
  }, WATCHDOG_INTERVAL);
  watchdog.unref(); // don't prevent graceful shutdown

  return server;
}
