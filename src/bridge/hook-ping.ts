#!/usr/bin/env node
/**
 * Hook Ping — Lightweight script called by Claude Code hooks.
 *
 * Reads JSON from stdin (the hook payload), connects to the bridge's
 * Unix socket, writes the payload, and exits. Fails silently if the
 * socket is not available (bridge not running).
 *
 * Zero external dependencies — only Node.js built-ins.
 * This file is compiled to dist/bridge/hook-ping.js and invoked
 * as a subprocess by Claude Code's hook system.
 *
 * Ported from Jackpoint's lib/hook-ping.js to TypeScript.
 */

import { connect } from "net";

const socketPath = process.env["CLAUDE_MATRIX_SOCKET"];

if (!socketPath) {
  process.exit(0);
}

let input = "";

process.stdin.setEncoding("utf8");

process.stdin.on("readable", () => {
  let chunk: string | null;
  while ((chunk = process.stdin.read() as string | null) !== null) {
    input += chunk;
  }
});

process.stdin.on("end", () => {
  if (!input.trim()) {
    process.exit(0);
  }

  const client = connect(socketPath, () => {
    client.write(input);
    client.end();
  });

  client.on("error", () => {
    process.exit(0);
  });

  client.on("close", () => {
    process.exit(0);
  });
});

process.stdin.on("error", () => {
  process.exit(0);
});
