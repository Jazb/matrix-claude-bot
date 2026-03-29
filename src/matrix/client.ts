/**
 * Matrix client wrapper using matrix-js-sdk.
 *
 * Handles connection to the Matrix homeserver, authentication validation,
 * media download, E2EE with cross-signing and device verification,
 * and provides a clean interface for the rest of the application.
 */

// Register IndexedDB polyfill for Node.js with LevelDB persistence.
// Must run before matrix-js-sdk import so the WASM crypto store can persist keys to disk.
import { mkdirSync as _mkdirSync } from "fs";
import { join as _join, resolve as _resolve } from "path";

const _idbDir = _resolve(_join("data", "crypto-indexeddb"));
_mkdirSync(_idbDir, { recursive: true, mode: 0o700 });
const _origCwd = process.cwd();
process.chdir(_idbDir);
const { default: _dbManager } = await import("node-indexeddb/dbManager");
await _dbManager.loadCache().catch(() => {});
await import("node-indexeddb/auto");
process.chdir(_origCwd);

import {
  createClient,
  ClientEvent,
  RoomEvent,
  RoomMemberEvent,
  MatrixEventEvent,
  EventType,
  MsgType,
  MemoryStore,
  type MatrixClient,
  type MatrixEvent as MatrixEventType,
  type IStartClientOpts,
} from "matrix-js-sdk";
import { CryptoEvent, VerifierEvent } from "matrix-js-sdk/lib/crypto-api/index.js";
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { marked } from "marked";
import { createDecipheriv } from "crypto";
import type { MatrixConfig, BotConfig } from "../config/schema.js";
import { createLogger } from "../utils/logger.js";

// Redirect matrix-js-sdk console output to stderr to keep stdout/app logs clean.
// SDK logs are visible via `pm2 logs --err` or stderr redirection.
// Set LOG_LEVEL=debug to keep SDK logs on stdout instead.
if (process.env["LOG_LEVEL"] !== "debug") {
  const _stderr = (prefix: string) => (...args: unknown[]) =>
    process.stderr.write(`${prefix} ${args.join(" ")}\n`);
  console.log = _stderr("[sdk]");
  console.debug = _stderr("[sdk:debug]");
  console.info = _stderr("[sdk:info]");
  console.warn = _stderr("[sdk:warn]");
}

const log = createLogger("matrix");

/** Encrypted file metadata from E2EE media messages. */
export interface EncryptedFileInfo {
  url: string;
  key: { kty: "oct"; key_ops: string[]; alg: "A256CTR"; k: string; ext: true };
  iv: string;
  hashes: Record<string, string>;
  v: string;
}

export interface MatrixClientWrapper {
  userId: string;
  start: () => Promise<void>;
  stop: () => void;
  sendText: (roomId: string, text: string) => Promise<string>;
  sendHtmlMessage: (roomId: string, text: string, html: string) => Promise<string>;
  sendNotice: (roomId: string, text: string) => Promise<string>;
  setTyping: (roomId: string, typing: boolean) => Promise<void>;
  downloadMedia: (mxcUrl: string, destPath: string) => Promise<void>;
  downloadEncryptedMedia: (file: EncryptedFileInfo, destPath: string) => Promise<void>;
  getJoinedRooms: () => Promise<string[]>;
  leaveRoom: (roomId: string) => Promise<void>;
  hasPendingSasConfirm: () => boolean;
  confirmSas: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on: (event: string, handler: (...args: any[]) => void) => void;
}

/** Persist device ID across restarts for E2EE key continuity. */
function loadDeviceId(storageDir: string): string | undefined {
  const path = join(storageDir, "device_id");
  if (existsSync(path)) {
    return readFileSync(path, "utf-8").trim();
  }
  return undefined;
}

function saveDeviceId(storageDir: string, deviceId: string): void {
  const path = join(storageDir, "device_id");
  writeFileSync(path, deviceId);
}

/** Base64url decode (used by Matrix encrypted attachments). */
function base64urlDecode(str: string): Buffer {
  // Add padding if needed
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export async function createMatrixClient(
  matrixConfig: MatrixConfig,
  botConfig: BotConfig,
): Promise<MatrixClientWrapper> {
  // Ensure storage directory exists
  const storageDir = dirname(botConfig.sessionsFile);
  if (!existsSync(storageDir)) {
    mkdirSync(storageDir, { recursive: true });
  }

  // Resolve userId via whoami before creating the full client
  const whoamiResp = await fetch(`${matrixConfig.homeserverUrl}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${matrixConfig.accessToken}` },
  });
  if (!whoamiResp.ok) {
    throw new Error("Failed to authenticate with Matrix homeserver. Check MATRIX_ACCESS_TOKEN.");
  }
  const whoami = (await whoamiResp.json()) as { user_id: string; device_id?: string };
  const userId = whoami.user_id;
  log.info(`Authenticated as ${userId}`);

  // Load persisted device ID, fall back to server's whoami response
  const deviceId = loadDeviceId(storageDir) ?? whoami.device_id;
  if (!deviceId) {
    throw new Error("No device_id available. Ensure your access token is associated with a device.");
  }
  log.info(`Using device ID: ${deviceId}`);

  // Track sync state to filter old events on startup
  let initialSyncDone = false;
  let syncTimestamp = 0;

  // SAS verification state
  let verificationInProgress = false;
  let pendingSasConfirm: (() => Promise<void>) | null = null;

  const client: MatrixClient = createClient({
    baseUrl: matrixConfig.homeserverUrl,
    accessToken: matrixConfig.accessToken,
    userId,
    deviceId,
    store: new MemoryStore(),
    useAuthorizationHeader: true,
  });

  // Auto-join rooms on invite
  client.on(RoomMemberEvent.Membership, (_event, member) => {
    if (member.membership === "invite" && member.userId === userId) {
      client.joinRoom(member.roomId).catch((err: Error) => {
        log.error(`Failed to auto-join ${member.roomId}: ${err.message}`);
      });
    }
  });

  if (matrixConfig.enableE2ee) {
    log.info("E2EE enabled — initializing Rust crypto");
  }

  return {
    userId,

    async start() {
      // Initialize E2EE with persistent IndexedDB-backed crypto store
      if (matrixConfig.enableE2ee) {
        await client.initRustCrypto({
          useIndexedDB: true,
          cryptoDatabasePrefix: "matrix-claude-bot-crypto",
        });
      }

      await client.startClient({ initialSyncLimit: 0 } as IStartClientOpts);

      // Wait for first sync to complete and record timestamp to filter old events
      await new Promise<void>((resolve) => {
        const onSync = (state: string): void => {
          if (state === "PREPARED") {
            client.removeListener(ClientEvent.Sync, onSync);
            syncTimestamp = Date.now();
            initialSyncDone = true;
            resolve();
          }
        };
        client.on(ClientEvent.Sync, onSync);
      });

      log.info("Matrix sync started" + (matrixConfig.enableE2ee ? " (E2EE active)" : ""));

      // Save device ID for future restarts
      const currentDeviceId = client.getDeviceId();
      if (currentDeviceId) {
        saveDeviceId(storageDir, currentDeviceId);
      }

      // Bootstrap cross-signing and verify own device
      if (matrixConfig.enableE2ee) {
        await setupCrossSigning(client, userId, matrixConfig.password);

        // Wait for old verification events from sync to settle before accepting new ones
        const verificationReadyAfter = Date.now() + 10000;

        // Register SAS verification handler AFTER startClient (like matrix-channel)
        client.on(CryptoEvent.VerificationRequestReceived, async (request) => {
          if (request.initiatedByMe) return;
          if (Date.now() < verificationReadyAfter) {
            log.info(`Ignoring verification from ${request.otherUserId} — still settling after startup`);
            return;
          }
          if (verificationInProgress) {
            log.info("Ignoring verification request — one already in progress");
            return;
          }

          verificationInProgress = true;
          log.info(`Incoming verification request from ${request.otherUserId} phase=${request.phase}`);

          try {
            await request.accept();
            log.info("Verification accepted");

            await new Promise((r) => setTimeout(r, 1000));

            // Start SAS — same pattern as matrix-channel
            let verifier;
            try {
              verifier = await request.startVerification("m.sas.v1");
            } catch (err) {
              log.info(`startVerification failed: ${err}, checking for existing verifier...`);
              verifier = request.verifier;
              if (!verifier) throw err;
            }
            log.info("Verifier obtained, calling verify()...");

            verifier.on(VerifierEvent.ShowSas, (sasCallbacks: {
              sas: { emoji?: Array<[string, string]>; decimal?: [number, number, number] };
              confirm: () => Promise<void>;
            }) => {
              const emojis = sasCallbacks.sas?.emoji;
              let emojiDisplay = "";
              if (emojis) {
                emojiDisplay = emojis.map(([emoji, name]) => `${emoji} ${name}`).join("  ");
              }
              log.info(`SAS emojis: ${emojiDisplay || "(none)"}`);

              // Send emojis to all joined rooms
              client.getJoinedRooms().then((resp) => {
                for (const roomId of resp.joined_rooms) {
                  client.sendMessage(roomId, {
                    msgtype: MsgType.Notice,
                    body: `Verification emojis:\n\n${emojiDisplay || "(no emojis)"}\n\nClick "They match" in Element, then send "confirm" here.`,
                  }).catch(() => {});
                }
              }).catch(() => {});

              // Store confirm callback — user triggers via `npm run confirm-sas`
              // which creates a trigger file that the bot watches
              pendingSasConfirm = sasCallbacks.confirm;
              const triggerFile = join("data", "sas-confirm-trigger");
              log.info(`Waiting for SAS confirm — run: npm run confirm-sas (or touch ${triggerFile})`);

              // Poll for the trigger file
              const pollInterval = setInterval(() => {
                if (existsSync(triggerFile)) {
                  clearInterval(pollInterval);
                  try { unlinkSync(triggerFile); } catch {}
                  if (pendingSasConfirm) {
                    log.info("SAS confirm triggered via file");
                    const confirm = pendingSasConfirm;
                    pendingSasConfirm = null;
                    confirm().catch((e) => log.error(`SAS confirm error: ${e}`));
                  }
                }
              }, 500);
            });

            verifier.on(VerifierEvent.Cancel, (e: unknown) => {
              log.info(`Verification cancelled: ${e}`);
            });

            await verifier.verify();
            log.info("Verification complete!");
          } catch (err) {
            log.warn(`Verification failed: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            verificationInProgress = false;
          }
        });
      }
    },

    stop() {
      client.stopClient();
      log.info("Matrix sync stopped");
    },

    async sendText(roomId: string, text: string): Promise<string> {
      const html = await marked.parse(text);
      const resp = await client.sendMessage(roomId, {
        msgtype: MsgType.Text,
        body: text,
        format: "org.matrix.custom.html",
        formatted_body: html,
      });
      return resp.event_id;
    },

    async sendHtmlMessage(roomId: string, text: string, html: string): Promise<string> {
      const resp = await client.sendMessage(roomId, {
        msgtype: MsgType.Text,
        body: text,
        format: "org.matrix.custom.html",
        formatted_body: html,
      });
      return resp.event_id;
    },

    async sendNotice(roomId: string, text: string): Promise<string> {
      const resp = await client.sendNotice(roomId, text);
      return resp.event_id;
    },

    async setTyping(roomId: string, typing: boolean): Promise<void> {
      try {
        await client.sendTyping(roomId, typing, typing ? 30_000 : 0);
      } catch {
        // Typing indicator is best-effort
      }
    },

    async downloadMedia(mxcUrl: string, destPath: string): Promise<void> {
      const httpUrl = client.mxcUrlToHttp(mxcUrl);
      if (!httpUrl) throw new Error(`Cannot resolve mxc URL: ${mxcUrl}`);

      const resp = await fetch(httpUrl, {
        headers: { Authorization: `Bearer ${matrixConfig.accessToken}` },
      });
      if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);

      const buf = Buffer.from(await resp.arrayBuffer());
      const dir = dirname(destPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(destPath, buf);
      log.debug(`Downloaded media to ${destPath}`);
    },

    async downloadEncryptedMedia(file: EncryptedFileInfo, destPath: string): Promise<void> {
      log.debug(`Downloading encrypted media: ${file.url}`);

      const mxcUrl = file.url;
      if (!mxcUrl?.startsWith("mxc://")) {
        throw new Error(`Invalid mxc URL: ${mxcUrl}`);
      }

      const parts = mxcUrl.slice("mxc://".length).split("/");
      const domain = encodeURIComponent(parts[0]);
      const mediaId = encodeURIComponent(parts[1]);

      // Try authenticated endpoint first, fall back to legacy
      const endpoints = [
        `${matrixConfig.homeserverUrl}/_matrix/client/v1/media/download/${domain}/${mediaId}`,
        `${matrixConfig.homeserverUrl}/_matrix/media/v3/download/${domain}/${mediaId}?allow_remote=true`,
      ];

      let encryptedData: Buffer | null = null;
      for (const url of endpoints) {
        try {
          const resp = await fetch(url, {
            headers: { Authorization: `Bearer ${matrixConfig.accessToken}` },
          });
          if (resp.ok) {
            encryptedData = Buffer.from(await resp.arrayBuffer());
            log.debug(`Downloaded from ${url.includes("v1") ? "authenticated" : "legacy"} endpoint`);
            break;
          }
          log.debug(`Endpoint returned ${resp.status}: ${url}`);
        } catch (err) {
          log.debug(`Endpoint failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (!encryptedData) {
        throw new Error(`Failed to download media from ${mxcUrl}`);
      }

      // Decrypt using AES-256-CTR (Matrix encrypted attachment spec)
      const key = base64urlDecode(file.key.k);
      const iv = base64urlDecode(file.iv);
      // Matrix spec: only first 8 bytes of IV are used, rest are counter (zeroed)
      const ivBytes = Buffer.alloc(16);
      iv.copy(ivBytes, 0, 0, 8);

      const decipher = createDecipheriv("aes-256-ctr", key, ivBytes);
      const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);

      const dir = dirname(destPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(destPath, decrypted);
      log.debug(`Decrypted media saved to ${destPath}`);
    },

    async getJoinedRooms(): Promise<string[]> {
      const resp = await client.getJoinedRooms();
      return resp.joined_rooms;
    },

    async leaveRoom(roomId: string): Promise<void> {
      await client.leave(roomId);
      log.info(`Left room ${roomId}`);
    },

    hasPendingSasConfirm(): boolean {
      return pendingSasConfirm !== null;
    },

    confirmSas(): void {
      if (pendingSasConfirm) {
        const confirm = pendingSasConfirm;
        pendingSasConfirm = null;
        confirm().catch((e) => log.error(`SAS confirm error: ${e}`));
      }
    },


    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, handler: (...args: any[]) => void): void {
      switch (event) {
        case "room.message": {
          const processMessage = (matrixEvent: MatrixEventType): void => {
            // Skip events from before initial sync (old history / late decryptions)
            if (!initialSyncDone) return;
            if (matrixEvent.getTs() < syncTimestamp) return;
            if (matrixEvent.getType() !== EventType.RoomMessage) return;
            if (matrixEvent.isDecryptionFailure?.()) return;
            const roomId = matrixEvent.getRoomId();
            if (!roomId) return;
            handler(roomId, {
              sender: matrixEvent.getSender(),
              type: matrixEvent.getType(),
              content: matrixEvent.getContent(),
            });
          };

          // Listener 1: unencrypted messages — process immediately
          client.on(RoomEvent.Timeline, (matrixEvent, _room, toStartOfTimeline) => {
            if (toStartOfTimeline) return;
            if (matrixEvent.isEncrypted()) return;
            processMessage(matrixEvent);
          });

          // Listener 2: encrypted messages — wait for decryption
          client.on(RoomEvent.Timeline, (matrixEvent, _room, toStartOfTimeline) => {
            if (toStartOfTimeline) return;
            if (!matrixEvent.isEncrypted()) return;
            if (matrixEvent.isDecryptionFailure?.()) return;

            // If already decrypted (keys were available), process immediately
            if (matrixEvent.getType() === EventType.RoomMessage) {
              processMessage(matrixEvent);
              return;
            }

            // Otherwise wait for the decryption event
            matrixEvent.once(MatrixEventEvent.Decrypted, () => {
              processMessage(matrixEvent);
            });
          });
          break;
        }

        case "room.join":
          client.on(RoomMemberEvent.Membership, (_ev, member) => {
            if (member.userId === userId && member.membership === "join") {
              handler(member.roomId);
            }
          });
          break;

        case "room.failed_decryption":
          client.on(RoomEvent.Timeline, (matrixEvent, room) => {
            if (matrixEvent.isDecryptionFailure?.()) {
              const roomId = room?.roomId ?? matrixEvent.getRoomId();
              handler(
                roomId,
                { sender: matrixEvent.getSender(), type: matrixEvent.getType() },
                new Error("Decryption failed"),
              );
            }
          });
          break;

        case "room.decrypted_event":
          client.on(RoomEvent.Timeline, (matrixEvent, room, toStartOfTimeline) => {
            if (toStartOfTimeline) return;
            if (matrixEvent.isDecryptionFailure?.()) return;
            const roomId = room?.roomId ?? matrixEvent.getRoomId();
            handler(roomId, {
              sender: matrixEvent.getSender(),
              type: matrixEvent.getType(),
            });
          });
          break;

        case "room.event":
          client.on(RoomEvent.Timeline, (matrixEvent, room) => {
            const roomId = room?.roomId ?? matrixEvent.getRoomId();
            handler(roomId, {
              sender: matrixEvent.getSender(),
              type: matrixEvent.getType(),
              content: matrixEvent.getContent(),
            });
          });
          break;

        default:
          log.warn(`Unknown event type for on(): ${event}`);
      }
    },
  };
}

/** Bootstrap cross-signing and verify own device for E2EE trust. */
async function setupCrossSigning(client: MatrixClient, userId: string, password: string): Promise<void> {
  const crypto = client.getCrypto();
  if (!crypto) {
    log.warn("Crypto not available, skipping cross-signing setup");
    return;
  }

  // Allow sharing room keys with unverified devices
  crypto.globalBlacklistUnverifiedDevices = false;

  const deviceId = client.getDeviceId()!;

  // Bootstrap cross-signing keys (requires password for auth)
  if (password) {
    try {
      await crypto.bootstrapCrossSigning({
        setupNewCrossSigning: false,
        authUploadDeviceSigningKeys: async (makeRequest) => {
          await makeRequest({
            type: "m.login.password",
            identifier: { type: "m.id.user", user: userId },
            password,
          });
        },
      });
      log.info("Cross-signing bootstrapped");
    } catch (err) {
      log.warn(`Cross-signing bootstrap: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    log.warn("MATRIX_PASSWORD not set — cross-signing bootstrap skipped. Set it for full E2EE verification.");
  }

  // Mark own device as verified
  try {
    await crypto.setDeviceVerified(userId, deviceId);
    log.info(`Device ${deviceId} marked as verified`);
  } catch (err) {
    log.warn(`Device self-verification: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Cross-sign our device
  try {
    await crypto.crossSignDevice(deviceId);
    log.info(`Device ${deviceId} cross-signed`);
  } catch (err) {
    log.warn(`Cross-signing device: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Log verification status
  try {
    const status = await crypto.getDeviceVerificationStatus(userId, deviceId);
    log.info("━━━ Device Verification Info ━━━");
    log.info(`  User:      ${userId}`);
    log.info(`  Device ID: ${deviceId}`);
    log.info(`  Verified:  ${status?.isVerified() ?? false}`);
    log.info(`  Cross-signed: ${status?.crossSigningVerified ?? false}`);
    log.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  } catch (err) {
    log.debug(`Could not retrieve verification status: ${err instanceof Error ? err.message : String(err)}`);
  }
}
