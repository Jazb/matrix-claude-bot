/**
 * Matrix client wrapper.
 *
 * Handles connection to the Matrix homeserver, authentication validation,
 * media download, and optional E2EE (end-to-end encryption) support.
 * Uses matrix-bot-sdk under the hood with RustSdkCryptoStorageProvider
 * for encryption key management.
 *
 * Inspired by Jackpoint's matrix-bridge.js but simplified for a single-user
 * bot scenario (no room management by session key — we use DM or a fixed room).
 */

import {
  MatrixClient,
  SimpleFsStorageProvider,
  RustSdkCryptoStorageProvider,
  AutojoinRoomsMixin,
  LogService,
  LogLevel,
} from "matrix-bot-sdk";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { marked } from "marked";
import type { MatrixConfig, BotConfig } from "../config/schema.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("matrix");

/** Suppress matrix-bot-sdk's verbose internal logging. */
function silenceSdkLogs(level: string): void {
  const sdkLevel = level === "debug" ? LogLevel.DEBUG : LogLevel.WARN;
  LogService.setLevel(sdkLevel);
}

/** Encrypted file metadata from E2EE media messages. */
export interface EncryptedFileInfo {
  url: string;
  key: { kty: "oct"; key_ops: string[]; alg: "A256CTR"; k: string; ext: true };
  iv: string;
  hashes: Record<string, string>;
  v: string;
}

export interface MatrixClientWrapper {
  client: MatrixClient;
  userId: string;
  start: () => Promise<void>;
  stop: () => void;
  sendText: (roomId: string, text: string) => Promise<string>;
  sendNotice: (roomId: string, text: string) => Promise<string>;
  setTyping: (roomId: string, typing: boolean) => Promise<void>;
  downloadMedia: (mxcUrl: string, destPath: string) => Promise<void>;
  downloadEncryptedMedia: (file: EncryptedFileInfo, destPath: string) => Promise<void>;
}

export async function createMatrixClient(
  matrixConfig: MatrixConfig,
  botConfig: BotConfig,
): Promise<MatrixClientWrapper> {
  silenceSdkLogs(botConfig.logLevel);

  // Ensure storage directory exists
  const storageDir = dirname(botConfig.sessionsFile);
  if (!existsSync(storageDir)) {
    mkdirSync(storageDir, { recursive: true });
  }
  const storagePath = `${storageDir}/matrix-storage.json`;
  const storage = new SimpleFsStorageProvider(storagePath);

  // Set up E2EE crypto store if enabled
  let cryptoStore: RustSdkCryptoStorageProvider | undefined;
  if (matrixConfig.enableE2ee) {
    const cryptoDir = matrixConfig.cryptoStoragePath;
    if (!existsSync(cryptoDir)) {
      mkdirSync(cryptoDir, { recursive: true });
    }
    // RustSdkCryptoStorageProvider expects a StoreType enum value.
    // The second argument maps to the Rust SDK store backend.
    // Passing undefined lets the SDK use its default (Sqlite).
    cryptoStore = new RustSdkCryptoStorageProvider(cryptoDir);
    log.info("E2EE crypto store initialized");
  }

  const client = new MatrixClient(
    matrixConfig.homeserverUrl,
    matrixConfig.accessToken,
    storage,
    cryptoStore,
  );

  // Auto-join rooms the bot is invited to (so the allowed user can DM us)
  AutojoinRoomsMixin.setupOnClient(client);

  // Validate token and get our user ID
  let userId: string;
  try {
    userId = await client.getUserId();
    log.info(`Authenticated as ${userId}`);
  } catch (err) {
    log.error("Failed to authenticate with Matrix homeserver. Check MATRIX_ACCESS_TOKEN.");
    throw err;
  }

  if (matrixConfig.enableE2ee) {
    log.info("E2EE enabled — encrypted rooms will be supported");
  }

  return {
    client,
    userId,

    async start() {
      await client.start();
      log.info("Matrix sync started" + (matrixConfig.enableE2ee ? " (E2EE active)" : ""));

      // Log device info for manual verification
      if (matrixConfig.enableE2ee) {
        try {
          const ownDevices = await client.getOwnDevices();
          const cryptoClient = client.crypto;
          if (cryptoClient && ownDevices.length > 0) {
            const deviceId = await cryptoStore!.getDeviceId();
            log.info("━━━ Device Verification Info ━━━");
            log.info(`  User:      ${userId}`);
            log.info(`  Device ID: ${deviceId}`);
            log.info("  To verify: In Element, go to the bot's profile → Sessions → click the device → 'Manually verify by text'");
            log.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          }
        } catch (err) {
          log.debug(`Could not retrieve device info: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },

    stop() {
      client.stop();
      log.info("Matrix sync stopped");
    },

    async sendText(roomId: string, text: string): Promise<string> {
      const html = await marked.parse(text);
      return client.sendMessage(roomId, {
        msgtype: "m.text",
        body: text,
        format: "org.matrix.custom.html",
        formatted_body: html,
      });
    },

    async sendNotice(roomId: string, text: string): Promise<string> {
      return client.sendNotice(roomId, text);
    },

    async setTyping(roomId: string, typing: boolean): Promise<void> {
      try {
        await client.setTyping(roomId, typing, typing ? 30_000 : 0);
      } catch {
        // Typing indicator is best-effort
      }
    },

    async downloadMedia(mxcUrl: string, destPath: string): Promise<void> {
      const data = await client.downloadContent(mxcUrl);
      const dir = dirname(destPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(destPath, Buffer.from(data.data));
      log.debug(`Downloaded media to ${destPath}`);
    },

    async downloadEncryptedMedia(file: EncryptedFileInfo, destPath: string): Promise<void> {
      log.debug(`Downloading encrypted media: ${file.url}`);

      // matrix.org deprecated /_matrix/media/v3/download in favor of
      // /_matrix/client/v1/media/download (authenticated). We download
      // manually and then decrypt using the Rust crypto SDK.
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

      // Decrypt using the Rust crypto SDK directly
      const { Attachment, EncryptedAttachment } = await import("@matrix-org/matrix-sdk-crypto-nodejs");
      const encrypted = new EncryptedAttachment(encryptedData, JSON.stringify(file));
      const decrypted = Attachment.decrypt(encrypted);

      const dir = dirname(destPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(destPath, Buffer.from(decrypted));
      log.debug(`Decrypted media saved to ${destPath}`);
    },
  };
}
