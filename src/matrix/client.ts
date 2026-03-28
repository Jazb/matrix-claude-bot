/**
 * Matrix client wrapper using matrix-js-sdk.
 *
 * Handles connection to the Matrix homeserver, authentication validation,
 * media download, E2EE with cross-signing and device verification,
 * and provides a clean interface for the rest of the application.
 */

import {
  createClient,
  ClientEvent,
  RoomEvent,
  RoomMemberEvent,
  EventType,
  MsgType,
  MemoryStore,
  type MatrixClient,
  type IStartClientOpts,
} from "matrix-js-sdk";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { marked } from "marked";
import { createDecipheriv } from "crypto";
import type { MatrixConfig, BotConfig } from "../config/schema.js";
import { createLogger } from "../utils/logger.js";

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

  // Load or use device ID
  let deviceId = loadDeviceId(storageDir) ?? whoami.device_id;
  if (!deviceId) {
    // Will be assigned by server on first sync; we save it after start
    deviceId = undefined as unknown as string;
  }

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
      // Initialize E2EE before starting sync
      if (matrixConfig.enableE2ee) {
        await client.initRustCrypto({ useIndexedDB: false });
      }

      await client.startClient({ initialSyncLimit: 0 } as IStartClientOpts);

      // Wait for first sync to complete
      await new Promise<void>((resolve) => {
        const onSync = (state: string): void => {
          if (state === "PREPARED") {
            client.removeListener(ClientEvent.Sync, onSync);
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
        await setupCrossSigning(client, userId);
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, handler: (...args: any[]) => void): void {
      switch (event) {
        case "room.message":
          client.on(RoomEvent.Timeline, (matrixEvent, room, toStartOfTimeline) => {
            if (toStartOfTimeline) return;
            if (matrixEvent.getType() !== EventType.RoomMessage) return;
            const roomId = room?.roomId ?? matrixEvent.getRoomId();
            if (!roomId) return;
            handler(roomId, {
              sender: matrixEvent.getSender(),
              type: matrixEvent.getType(),
              content: matrixEvent.getContent(),
            });
          });
          break;

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
async function setupCrossSigning(client: MatrixClient, userId: string): Promise<void> {
  const crypto = client.getCrypto();
  if (!crypto) {
    log.warn("Crypto not available, skipping cross-signing setup");
    return;
  }

  const deviceId = client.getDeviceId()!;

  // Bootstrap cross-signing keys
  try {
    await crypto.bootstrapCrossSigning({});
    log.info("Cross-signing keys bootstrapped");
  } catch (err) {
    log.warn(`Cross-signing bootstrap: ${err instanceof Error ? err.message : String(err)}`);
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
