/**
 * Matrix Claude Bot — main entry point.
 *
 * Supports three operating modes:
 *
 * **Bot mode** (BOT_MODE=bot, default):
 *   One-shot subprocess per message. Claude runs as `claude -p "..." --output-format json`,
 *   returns a response, and exits. Simple, robust, low resource usage.
 *
 * **Bridge mode** (BOT_MODE=bridge):
 *   Claude runs interactively inside tmux. Hook events (permission prompts, questions,
 *   responses) are forwarded to Matrix via IPC. User messages are injected into tmux.
 *   Enables dynamic permission approval via hooks.
 *
 * **IDE mode** (BOT_MODE=ide):
 *   Implements Claude Code's native MCP IDE protocol via WebSocket. Same protocol
 *   that VS Code, JetBrains, and Emacs use. Most robust: bidirectional JSON-RPC,
 *   diff review forwarded to Matrix, no tmux dependency.
 *
 * All modes share: Matrix client, E2EE, Groq transcription, config, and commands.
 */

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { loadConfig } from "./config/index.js";
import { createMatrixClient, type EncryptedFileInfo } from "./matrix/index.js";
import { ClaudeRunner, SessionStore } from "./claude/index.js";
import { GroqTranscriber } from "./transcriber/index.js";
import { SerialQueue } from "./queue/index.js";
import { BridgeRunner } from "./bridge/index.js";
import { IdeRunner } from "./ide/index.js";
import { splitMessage, createLogger, setLogLevel } from "./utils/index.js";

const log = createLogger("bot");

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const config = loadConfig();
setLogLevel(config.bot.logLevel);

const mode = config.bridge.mode;
const MODE_LABELS: Record<string, string> = {
  bot: "bot (one-shot subprocess)",
  bridge: "bridge (tmux + hooks)",
  ide: "ide (MCP WebSocket protocol)",
};
log.info(`Operating mode: ${MODE_LABELS[mode] ?? mode}`);

// Ensure temp directory exists
if (!existsSync(config.bot.tmpDir)) {
  mkdirSync(config.bot.tmpDir, { recursive: true });
}

const sessions = new SessionStore(config.bot.sessionsFile);
const transcriber = new GroqTranscriber(config.groq);

// ─── Mode-specific setup ─────────────────────────────────────────────────────

let queue: SerialQueue | undefined;
let claude: ClaudeRunner | undefined;
let bridge: BridgeRunner | undefined;
let ide: IdeRunner | undefined;

const matrix = await createMatrixClient(config.matrix, config.bot);

switch (mode) {
  case "bridge":
    bridge = new BridgeRunner(config, matrix, sessions);
    break;
  case "ide":
    ide = new IdeRunner(config, matrix, sessions);
    break;
  default: // bot
    queue = new SerialQueue();
    claude = new ClaudeRunner(config.claude, config.projects, sessions, queue);
}

// ─── Auth guard ──────────────────────────────────────────────────────────────

function isAllowed(sender: string): boolean {
  return sender === config.matrix.allowedUserId;
}

// ─── Command handlers ────────────────────────────────────────────────────────

const COMMANDS: Record<string, (roomId: string, args: string) => Promise<void>> = {
  "!help": async (roomId) => {
    await matrix.sendNotice(roomId, HELP_TEXT);
  },

  "!new": async (roomId) => {
    if (mode === "bridge") {
      await bridge!.newSession(roomId);
    } else if (mode === "ide") {
      await ide!.newSession(roomId);
    } else {
      sessions.clear(roomId);
    }
    await matrix.sendNotice(roomId, "New session. Context cleared.");
  },

  "!project": async (roomId, args) => {
    const name = args.trim().toLowerCase();
    if (!name || !config.projects.projects[name]) {
      const available = Object.keys(config.projects.projects).join(", ");
      await matrix.sendNotice(roomId, `Unknown project. Available: ${available}`);
      return;
    }

    if (mode === "bridge") {
      await bridge!.newSession(roomId);
    } else if (mode === "ide") {
      await ide!.newSession(roomId);
    }
    sessions.set(roomId, { project: name, sessionId: null });
    await matrix.sendNotice(
      roomId,
      `Project: ${name}\nDirectory: ${config.projects.projects[name]}\nSession reset.`,
    );
  },

  "!status": async (roomId) => {
    const session = sessions.get(roomId);
    const project = session?.project ?? config.projects.defaultProject;

    if (mode === "bridge") {
      const status = bridge!.getStatus(roomId);
      const lines = [
        `Mode: bridge (tmux + hooks)`,
        `Project: ${project}`,
        `Directory: ${config.projects.projects[project]}`,
        `Session alive: ${status.alive ? "Yes" : "No"}`,
        `Transcriber: ${transcriber.available ? "Groq OK" : "Not configured"}`,
      ];
      if (status.lines) {
        lines.push("", "Last terminal output:", "```", status.lines, "```");
      }
      await matrix.sendNotice(roomId, lines.join("\n"));
    } else if (mode === "ide") {
      const status = ide!.getStatus(roomId);
      const lines = [
        `Mode: ide (MCP WebSocket)`,
        `Project: ${project}`,
        `Directory: ${config.projects.projects[project]}`,
        `Claude process: ${status.alive ? "Running" : "Stopped"}`,
        `MCP connected: ${status.connected ? "Yes" : "No"}`,
        `Transcriber: ${transcriber.available ? "Groq OK" : "Not configured"}`,
      ];
      await matrix.sendNotice(roomId, lines.join("\n"));
    } else {
      const lines = [
        `Mode: bot (one-shot subprocess)`,
        `Project: ${project}`,
        `Directory: ${config.projects.projects[project]}`,
        `Active session: ${session?.sessionId ? "Yes" : "No"}`,
        `Processing: ${queue!.busy ? "Yes" : "No"}`,
        `Queue: ${queue!.length} pending`,
        `Transcriber: ${transcriber.available ? "Groq OK" : "Not configured"}`,
      ];
      await matrix.sendNotice(roomId, lines.join("\n"));
    }
  },

  "!cancel": async (roomId) => {
    if (mode === "bridge") {
      if (bridge!.cancel(roomId)) {
        await matrix.sendNotice(roomId, "Sent Ctrl-C to Claude session.");
      } else {
        await matrix.sendNotice(roomId, "No active session.");
      }
    } else if (mode === "ide") {
      if (ide!.cancel(roomId)) {
        await matrix.sendNotice(roomId, "Sent SIGINT to Claude.");
      } else {
        await matrix.sendNotice(roomId, "No active session.");
      }
    } else {
      if (queue!.cancelCurrent()) {
        await matrix.sendNotice(roomId, "Task cancelled.");
      } else {
        await matrix.sendNotice(roomId, "No task running.");
      }
    }
  },

  "!lines": async (roomId, args) => {
    if (mode !== "bridge") {
      await matrix.sendNotice(roomId, "!lines is only available in bridge mode.");
      return;
    }
    const lineCount = parseInt(args.trim(), 10) || 30;
    const output = bridge!.getStatus(roomId, lineCount).lines;
    if (output) {
      await matrix.sendNotice(roomId, `\`\`\`\n${output}\n\`\`\``);
    } else {
      await matrix.sendNotice(roomId, "No active session.");
    }
  },
};

const HELP_TEXTS: Record<string, string> = {
  bot: [
    "Matrix Claude Bot",
    "",
    "Send text, audio, or images and Claude will respond.",
    "",
    "Commands:",
    "  !new           — Start a new session (clear context)",
    "  !project NAME  — Switch project working directory",
    "  !status        — Show session and queue info",
    "  !cancel        — Cancel the running task",
    "  !help          — Show this help",
  ].join("\n"),

  bridge: [
    "Matrix Claude Bot (Bridge Mode)",
    "",
    "Send text, audio, or images. Claude runs interactively with full",
    "permission prompts forwarded to this chat.",
    "",
    "Commands:",
    "  !new           — Start a new session (clear context)",
    "  !project NAME  — Switch project working directory",
    "  !status        — Show session info and terminal output",
    "  !cancel        — Send Ctrl-C to Claude",
    "  !lines [N]     — Show last N lines of terminal (default: 30)",
    "  !help          — Show this help",
    "",
    "Reply 'y' or 'n' to permission prompts.",
  ].join("\n"),

  ide: [
    "Matrix Claude Bot (IDE Mode)",
    "",
    "Claude Code runs with native IDE integration. Diffs and interactive",
    "prompts are forwarded to this chat for review.",
    "",
    "Commands:",
    "  !new           — Start a new session (clear context)",
    "  !project NAME  — Switch project working directory",
    "  !status        — Show session and MCP connection info",
    "  !cancel        — Send SIGINT to Claude",
    "  !help          — Show this help",
    "",
    "Reply 'y' to approve diffs or 'n' to reject.",
  ].join("\n"),
};

const HELP_TEXT = HELP_TEXTS[mode] ?? HELP_TEXTS["bot"];

// ─── Message processing ─────────────────────────────────────────────────────

async function handlePrompt(roomId: string, prompt: string): Promise<void> {
  if (mode === "ide") {
    // IDE mode: check for diff approval first, then send to Claude
    if (ide!.handleDiffResponse(roomId, prompt)) return;

    try {
      await ide!.handleMessage(roomId, prompt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`IDE error: ${msg}`);
      await matrix.sendNotice(roomId, `Error: ${msg.slice(0, 500)}`);
    }
    return;
  }

  if (mode === "bridge") {
    try {
      await bridge!.handleMessage(roomId, prompt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Bridge error: ${msg}`);
      await matrix.sendNotice(roomId, `Error: ${msg.slice(0, 500)}`);
    }
    return;
  }

  // Bot mode: one-shot subprocess, await response
  if (queue!.busy) {
    const pos = queue!.length + 1;
    await matrix.sendNotice(roomId, `Queued (position ${pos}). Waiting...`);
  }

  try {
    const result = await queue!.enqueue(async () => {
      await matrix.setTyping(roomId, true);
      try {
        return await claude!.run(roomId, prompt);
      } finally {
        await matrix.setTyping(roomId, false);
      }
    });

    const chunks = splitMessage(result, config.bot.maxMessageLength);
    for (const chunk of chunks) {
      await matrix.sendText(roomId, chunk);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Claude error: ${msg}`);
    await matrix.sendNotice(roomId, `Error: ${msg.slice(0, 500)}`);
  }
}

// ─── Event handlers ──────────────────────────────────────────────────────────

matrix.on("room.event", (roomId: string, event: Record<string, unknown>) => {
  log.debug(`[room.event] room=${roomId} type=${event.type} sender=${event.sender}`);
});

matrix.on("room.join", (roomId: string) => {
  log.info(`[room.join] Joined room ${roomId}`);
});

matrix.on("room.failed_decryption", (roomId: string, event: Record<string, unknown>, error: Error) => {
  log.error(`[E2EE] Failed to decrypt event in ${roomId} from ${event.sender}: ${error.message}`);
});

matrix.on("room.decrypted_event", (roomId: string, event: Record<string, unknown>) => {
  log.debug(`[E2EE] Decrypted event in ${roomId} type=${event.type} from ${event.sender}`);
});

matrix.on("room.message", async (roomId: string, event: Record<string, unknown>) => {
  log.debug(`[room.message] room=${roomId} sender=${event.sender} type=${(event.content as Record<string, unknown>)?.msgtype}`);

  if (event.sender === matrix.userId) return;
  if (!isAllowed(event.sender as string)) return;

  const content = event.content as Record<string, unknown>;
  const msgtype = content?.msgtype as string | undefined;

  if (!msgtype) return;

  // ── Text messages ──
  if (msgtype === "m.text") {
    const body = (content.body as string) ?? "";

    const spaceIdx = body.indexOf(" ");
    const cmd = spaceIdx === -1 ? body : body.slice(0, spaceIdx);
    const args = spaceIdx === -1 ? "" : body.slice(spaceIdx + 1);

    if (cmd in COMMANDS) {
      await COMMANDS[cmd](roomId, args);
      return;
    }

    await handlePrompt(roomId, body);
    return;
  }

  // ── Audio messages ──
  if (msgtype === "m.audio" || msgtype === "m.video") {
    if (!transcriber.available) {
      await matrix.sendNotice(roomId, "Transcription not available (GROQ_API_KEY not set).");
      return;
    }

    const info = content.info as Record<string, unknown> | undefined;
    const mimetype = (info?.mimetype as string) ?? "audio/ogg";
    const ext = mimeToExtension(mimetype);
    const audioPath = join(config.bot.tmpDir, `audio_${Date.now()}${ext}`);

    await matrix.sendNotice(roomId, "Transcribing audio...");

    try {
      await downloadContentToFile(content, audioPath);
      const transcription = await transcriber.transcribe(audioPath);
      await matrix.sendNotice(roomId, `Transcription: ${transcription}\n\nProcessing...`);
      await handlePrompt(roomId, transcription);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Transcription error: ${msg}`);
      await matrix.sendNotice(roomId, `Transcription failed: ${msg}`);
    }
    return;
  }

  // ── Image messages ──
  if (msgtype === "m.image") {
    const info = content.info as Record<string, unknown> | undefined;
    const mimetype = (info?.mimetype as string) ?? "image/jpeg";
    const ext = mimeToExtension(mimetype);
    const imgPath = join(config.bot.tmpDir, `img_${Date.now()}${ext}`);
    const caption = (content.body as string) ?? "Describe this image";

    await matrix.sendNotice(roomId, "Processing image...");

    try {
      await downloadContentToFile(content, imgPath);
      const prompt = `Read the image at ${imgPath} and respond: ${caption}`;
      await handlePrompt(roomId, prompt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Image error: ${msg}`);
      await matrix.sendNotice(roomId, `Image processing failed: ${msg}`);
    }
    return;
  }

  // ── File messages (treat audio files as voice) ──
  if (msgtype === "m.file") {
    const info = content.info as Record<string, unknown> | undefined;
    const mimetype = (info?.mimetype as string) ?? "";

    if (mimetype.startsWith("audio/") && transcriber.available) {
      const ext = mimeToExtension(mimetype);
      const audioPath = join(config.bot.tmpDir, `file_${Date.now()}${ext}`);

      await matrix.sendNotice(roomId, "Transcribing audio file...");

      try {
        await downloadContentToFile(content, audioPath);
        const transcription = await transcriber.transcribe(audioPath);
        await matrix.sendNotice(roomId, `Transcription: ${transcription}\n\nProcessing...`);
        await handlePrompt(roomId, transcription);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await matrix.sendNotice(roomId, `Transcription failed: ${msg}`);
      }
    }
  }
});

// ─── Utilities ───────────────────────────────────────────────────────────────

function mimeToExtension(mimetype: string): string {
  const map: Record<string, string> = {
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/wav": ".wav",
    "audio/webm": ".webm",
    "audio/flac": ".flac",
    "audio/x-flac": ".flac",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
  };
  return map[mimetype] ?? ".bin";
}

/**
 * Download media from a Matrix message, handling both encrypted (E2EE) and
 * unencrypted content. With E2EE, media uses `content.file` (EncryptedFile)
 * instead of `content.url`.
 */
async function downloadContentToFile(
  content: Record<string, unknown>,
  destPath: string,
): Promise<void> {
  const encFile = content.file as EncryptedFileInfo | undefined;
  const plainUrl = content.url as string | undefined;

  if (encFile?.url) {
    await matrix.downloadEncryptedMedia(encFile, destPath);
  } else if (plainUrl) {
    await matrix.downloadMedia(plainUrl, destPath);
  } else {
    throw new Error("No media URL in message (neither content.url nor content.file found)");
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────

await matrix.start();
log.info(`Matrix Claude Bot started (${mode} mode)`);

// Pre-start Claude sessions in bridge mode so the first message is instant
if (mode === "bridge" && bridge) {
  const joinedRooms = await matrix.getJoinedRooms();
  for (const roomId of joinedRooms) {
    bridge.warmup(roomId).catch(async (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("M_FORBIDDEN")) {
        log.warn(`No permission in ${roomId}, leaving room`);
        await matrix.leaveRoom(roomId).catch(() => {});
      } else {
        log.warn(`Warmup failed for ${roomId}: ${msg}`);
      }
    });
  }
}

// Graceful shutdown
function shutdown(signal: string) {
  log.info(`${signal} received, shutting down`);
  matrix.stop();

  switch (mode) {
    case "bridge":
      bridge!.stop();
      break;
    case "ide":
      ide!.stop();
      break;
    default:
      queue!.cancelCurrent();
  }

  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
