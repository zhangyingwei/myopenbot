import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import type { LogLevel } from "@openbot/logging";
import { LocalPairingError } from "./errors";

export interface LocalPairingConfig {
  dataDir: string;
  statePath: string;
  bindAddress: string;
  apiPort: number;
  signalPort: number;
  publicApiUrl: string;
  publicSignalUrl: string;
  webRoot: string | null;
  marketplaceBaseUrl: string | null;
  authWebhookSecret: string | null;
  userId: string;
  email: string;
  name: string;
  logLevel: LogLevel;
}

type Environment = Record<string, string | undefined>;

const LOG_LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error", "silent"];
const USER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

export function readLocalPairingConfig(environment: Environment = process.env): LocalPairingConfig {
  const dataDir = environment.LOCAL_PAIRING_DATA_DIR?.trim() || defaultDataDir(environment);
  const configPath = environment.LOCAL_PAIRING_CONFIG_PATH?.trim() || join(dataDir, "local-pairing-config.json");
  const file = readConfigFile(configPath);
  const apiPort = readPort(environment.LOCAL_PAIRING_API_PORT ?? file.apiPort, 3100, "LOCAL_PAIRING_API_PORT");
  const signalPort = readPort(
    environment.LOCAL_PAIRING_SIGNAL_PORT ?? file.signalPort,
    3101,
    "LOCAL_PAIRING_SIGNAL_PORT",
  );
  const bindAddress = environment.LOCAL_PAIRING_BIND_ADDRESS?.trim() || readText(file.bindAddress) || "0.0.0.0";
  const publicApiUrl = normalizeHttpOrigin(
    environment.LOCAL_PAIRING_PUBLIC_API_URL ?? readText(file.publicApiUrl) ?? `http://127.0.0.1:${apiPort}`,
  );
  const publicSignalUrl = normalizeSignalUrl(
    environment.LOCAL_PAIRING_PUBLIC_SIGNAL_URL ??
      readText(file.publicSignalUrl) ??
      `ws://127.0.0.1:${signalPort}/v1/signal`,
  );
  const authWebhookSecret =
    environment.LOCAL_PAIRING_AUTH_WEBHOOK_SECRET?.trim() ||
    environment.REMOTE_AUTH_WEBHOOK_SECRET?.trim() ||
    readText(file.authWebhookSecret) ||
    null;
  const userId = readUserId(environment.LOCAL_PAIRING_USER_ID ?? readText(file.userId) ?? "local-owner");
  const email = readEmail(environment.LOCAL_PAIRING_USER_EMAIL ?? readText(file.email) ?? "local@openbot.local");
  const name = readName(environment.LOCAL_PAIRING_USER_NAME ?? readText(file.name) ?? "Local Owner");
  const statePath =
    environment.LOCAL_PAIRING_STATE_PATH?.trim() || readText(file.statePath) || join(dataDir, "local-pairing.json");
  const logLevel = readLogLevel(environment.LOCAL_PAIRING_LOG_LEVEL ?? readText(file.logLevel));
  const marketplaceBaseUrl = readMarketplaceBaseUrl(
    environment.LOCAL_PAIRING_MARKETPLACE_URL ?? readText(file.marketplaceBaseUrl) ?? "https://api.openbot.run",
  );
  const webRoot = environment.LOCAL_PAIRING_WEB_ROOT?.trim() || readText(file.webRoot) || null;
  return {
    dataDir,
    statePath,
    bindAddress,
    apiPort,
    signalPort,
    publicApiUrl,
    publicSignalUrl,
    webRoot,
    marketplaceBaseUrl,
    authWebhookSecret,
    userId,
    email,
    name,
    logLevel,
  };
}

export function readMarketplaceBaseUrl(value: string): string | null {
  if (value.trim() === "off") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("not an https origin");
    }
    return url.origin;
  } catch {
    throw new LocalPairingError(500, "invalid_config", "marketplaceBaseUrl must be an HTTPS origin or off.");
  }
}

function defaultDataDir(environment: Environment): string {
  if (process.platform === "win32") {
    return join(environment.APPDATA?.trim() || homedir(), "OpenBot");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "OpenBot");
  }
  const dataHome = environment.XDG_DATA_HOME?.trim();
  return join(dataHome || join(homedir(), ".local", "share"), "OpenBot");
}

function readConfigFile(path: string): DynamicRecord {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new LocalPairingError(500, "invalid_config", "The local pairing configuration is not valid JSON.");
  }
  if (!isDynamicRecord(parsed)) {
    throw new LocalPairingError(500, "invalid_config", "The local pairing configuration is not valid.");
  }
  return parsed;
}

function readText(value: unknown): string | null {
  return isString(value) && value.trim() ? value.trim() : null;
}

function readPort(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : isString(value) ? Number(value.trim()) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new LocalPairingError(500, "invalid_config", `${label} must be a port between 1 and 65535.`);
  }
  return parsed;
}

function normalizeHttpOrigin(value: string): string {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("not an origin");
    }
    return url.origin;
  } catch {
    throw new LocalPairingError(
      500,
      "invalid_config",
      "publicApiUrl must be an HTTP origin without a path, query or fragment.",
    );
  }
}

function normalizeSignalUrl(value: string): string {
  try {
    const url = new URL(value);
    if ((url.protocol !== "ws:" && url.protocol !== "wss:") || url.hash) throw new Error("not a signal URL");
    return url.toString();
  } catch {
    throw new LocalPairingError(500, "invalid_config", "publicSignalUrl must be a ws or wss URL.");
  }
}

function readUserId(value: string): string {
  if (!USER_ID_PATTERN.test(value)) {
    throw new LocalPairingError(500, "invalid_config", "The local pairing user ID is invalid.");
  }
  return value;
}

function readEmail(value: string): string {
  const email = value.normalize("NFC").trim().toLowerCase();
  if (email.length > 254 || !email.includes("@") || /\s/u.test(email)) {
    throw new LocalPairingError(500, "invalid_config", "The local pairing email address is invalid.");
  }
  return email;
}

function readName(value: string): string {
  const name = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!name || name.length > 120 || /[\p{Cc}\p{Cf}]/u.test(name)) {
    throw new LocalPairingError(500, "invalid_config", "The local pairing user name is invalid.");
  }
  return name;
}

function readLogLevel(value: string | null): LogLevel {
  if (!value) return "info";
  const level = LOG_LEVELS.find((candidate) => candidate === value);
  if (!level) {
    throw new LocalPairingError(500, "invalid_config", "The local pairing log level is invalid.");
  }
  return level;
}
