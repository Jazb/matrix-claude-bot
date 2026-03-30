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
 */

import { createServer, type Server } from "http";
import type { MatrixClientWrapper } from "../matrix/index.js";
import { createLogger } from "../utils/index.js";

const log = createLogger("health");

const WATCHDOG_INTERVAL = 60_000;   // check every 60s
const GRACE_PERIOD = 120_000;       // don't watchdog-kill within first 2 min

export function startHealthServer(
  port: number,
  matrix: MatrixClientWrapper,
): Server {
  const startedAt = Date.now();

  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      const syncing = matrix.isSyncing();
      const uptime = Math.round((Date.now() - startedAt) / 1000);
      const body = JSON.stringify({ status: syncing ? "ok" : "unhealthy", syncing, uptime });

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
