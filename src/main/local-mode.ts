import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { type LocalPairingConfig, readMarketplaceBaseUrl } from "@openbot/local-pairing/config";
import { app } from "electron";

const HOST_PATTERN = /^[A-Za-z0-9.:-]{1,255}$/u;
const USER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const STUN_URL_PATTERN = /^stuns?:[A-Za-z0-9.:-]+:[0-9]{1,5}$/u;
const PACKAGED_LOCAL_HOST = "10.222.0.11";
const PACKAGED_LOCAL_API_PORT = 3200;
const PACKAGED_LOCAL_SIGNAL_PORT = 3111;
const PACKAGED_LOCAL_SIGNAL_HEALTH_PORT = 3112;
const PACKAGED_LOCAL_ROOT = "D:\\OpenBot";
const WINDOWS_ROOT_PATTERN = /^[A-Za-z]:\\/u;

export interface LocalModeConfig {
  host: string;
  apiPort: number;
  signalPort: number;
  signalHealthPort: number;
  statePath: string;
  authWebhookSecret: string;
  sessionSecret: string;
  userId: string;
  email: string;
  name: string;
  stunUrl: string;
  bunPath: string | null;
  openbotRoot: string | null;
}

let cached: LocalModeConfig | null | undefined;

export function localModeConfig(): LocalModeConfig | null {
  if (cached !== undefined) return cached;
  cached = readLocalModeConfig();
  return cached;
}

export function packagedLocalModeRoot(): string | null {
  if (!app.isPackaged || process.platform !== "win32") return null;
  const requestedMode = process.env.OPENBOT_LOCAL_MODE?.trim().toLowerCase();
  if (requestedMode === "false") return null;
  const value = process.env.OPENBOT_LOCAL_ROOT?.trim() || PACKAGED_LOCAL_ROOT;
  if (!WINDOWS_ROOT_PATTERN.test(value)) throw new Error("OPENBOT_LOCAL_ROOT must be an absolute Windows path.");
  return value.replace(/\\+$/u, "");
}

export function applyLocalModeEnvironment(config: LocalModeConfig): void {
  process.env.OPENBOT_AUTH_API_URL = `http://127.0.0.1:${config.apiPort}`;
  process.env.OPENBOT_MOBILE_AUTH_API_URL = `http://${config.host}:${config.apiPort}`;
  process.env.REMOTE_SIGNAL_URL = `ws://${config.host}:${config.signalPort}/v1/signal`;
}

export function localPairingConfig(config: LocalModeConfig): LocalPairingConfig {
  return {
    dataDir: dirname(config.statePath),
    statePath: config.statePath,
    bindAddress: "127.0.0.1",
    apiPort: config.apiPort,
    signalPort: config.signalPort,
    publicApiUrl: `http://${config.host}:${config.apiPort}`,
    publicSignalUrl: `ws://${config.host}:${config.signalPort}/v1/signal`,
    marketplaceBaseUrl: readMarketplaceBaseUrl(
      process.env.OPENBOT_LOCAL_MARKETPLACE_URL?.trim() || "https://api.openbot.run",
    ),
    authWebhookSecret: config.authWebhookSecret,
    userId: config.userId,
    email: config.email,
    name: config.name,
    logLevel: "info",
  };
}

function readLocalModeConfig(): LocalModeConfig | null {
  const requestedMode = process.env.OPENBOT_LOCAL_MODE?.trim().toLowerCase();
  const enabled = requestedMode === "true" || (app.isPackaged && requestedMode !== "false");
  if (!enabled) return null;
  const userData = app.getPath("userData");
  const file = readConfigFile(join(userData, "local-mode.json"));
  const host = readHost(
    process.env.OPENBOT_LOCAL_HOST ?? readText(file.host) ?? (app.isPackaged ? PACKAGED_LOCAL_HOST : "127.0.0.1"),
  );
  const apiPort = readPort(
    process.env.OPENBOT_LOCAL_API_PORT ?? file.apiPort,
    app.isPackaged ? PACKAGED_LOCAL_API_PORT : 3100,
  );
  const signalPort = readPort(
    process.env.OPENBOT_LOCAL_SIGNAL_PORT ?? file.signalPort,
    app.isPackaged ? PACKAGED_LOCAL_SIGNAL_PORT : 3101,
  );
  const signalHealthPort = readPort(
    process.env.OPENBOT_LOCAL_SIGNAL_HEALTH_PORT ?? file.signalHealthPort,
    app.isPackaged ? PACKAGED_LOCAL_SIGNAL_HEALTH_PORT : 3102,
  );
  const statePath = join(userData, "local-pairing.json");
  const secrets = readSecrets(join(userData, "local-mode-secrets.json"));
  return {
    host,
    apiPort,
    signalPort,
    signalHealthPort,
    statePath,
    authWebhookSecret: secrets.authWebhookSecret,
    sessionSecret: secrets.sessionSecret,
    userId: readUserId(process.env.OPENBOT_LOCAL_USER_ID ?? readText(file.userId) ?? "local-owner"),
    email: readEmail(process.env.OPENBOT_LOCAL_USER_EMAIL ?? readText(file.email) ?? "local@openbot.local"),
    name: readName(process.env.OPENBOT_LOCAL_USER_NAME ?? readText(file.name) ?? "Local Owner"),
    stunUrl: readStunUrl(process.env.OPENBOT_LOCAL_STUN_URL ?? readText(file.stunUrl) ?? `stun:${host}:3478`),
    bunPath: process.env.OPENBOT_LOCAL_BUN?.trim() || null,
    openbotRoot: packagedLocalModeRoot(),
  };
}

function readConfigFile(path: string): DynamicRecord {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isDynamicRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readSecrets(path: string): { authWebhookSecret: string; sessionSecret: string } {
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (
        isDynamicRecord(parsed) &&
        isString(parsed.authWebhookSecret) &&
        parsed.authWebhookSecret.length >= 32 &&
        isString(parsed.sessionSecret) &&
        parsed.sessionSecret.length >= 32
      ) {
        return { authWebhookSecret: parsed.authWebhookSecret, sessionSecret: parsed.sessionSecret };
      }
    } catch {}
  }
  const secrets = {
    authWebhookSecret: randomBytes(32).toString("hex"),
    sessionSecret: randomBytes(32).toString("hex"),
  };
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return secrets;
}

function readText(value: unknown): string | null {
  return isString(value) && value.trim() ? value.trim() : null;
}

function readHost(value: string): string {
  if (!HOST_PATTERN.test(value)) throw new Error("OPENBOT_LOCAL_HOST is invalid.");
  return value;
}

function readPort(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : isString(value) ? Number(value.trim()) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("A local mode port is invalid.");
  }
  return parsed;
}

function readUserId(value: string): string {
  if (!USER_ID_PATTERN.test(value)) throw new Error("OPENBOT_LOCAL_USER_ID is invalid.");
  return value;
}

function readEmail(value: string): string {
  const email = value.normalize("NFC").trim().toLowerCase();
  if (email.length > 254 || !email.includes("@") || /\s/u.test(email)) {
    throw new Error("OPENBOT_LOCAL_USER_EMAIL is invalid.");
  }
  return email;
}

function readName(value: string): string {
  const name = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!name || name.length > 120 || /[\p{Cc}\p{Cf}]/u.test(name)) {
    throw new Error("OPENBOT_LOCAL_USER_NAME is invalid.");
  }
  return name;
}

function readStunUrl(value: string): string {
  if (!STUN_URL_PATTERN.test(value)) throw new Error("OPENBOT_LOCAL_STUN_URL is invalid.");
  return value;
}
