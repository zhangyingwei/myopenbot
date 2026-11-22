import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MobileDevicePlatform } from "@openbot/contracts/mobile-connect";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { LocalPairingError } from "./errors";

const STATE_VERSION = 1;
const PRUNE_AFTER_MS = 24 * 60 * 60_000;
const MOBILE_SESSION_EXPIRES_AT = 8_640_000_000_000_000;

export interface LocalUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  analyticsEnabled: boolean | null;
}

export interface LocalHost {
  hostId: string;
  ownerUserId: string;
  name: string;
  devicePublicKey: string | null;
  machineTokenHash: string;
  membershipId: string;
  authEpoch: number;
  createdAt: number;
  updatedAt: number;
}

export interface DesktopSession {
  sessionId: string;
  name: string;
  tokenHash: string;
  connectedAt: number;
  lastActiveAt: number;
  revokedAt: number | null;
}

export interface MobileSession {
  sessionId: string;
  name: string;
  platform: MobileDevicePlatform;
  tokenHash: string;
  hostId: string | null;
  fingerprint: string | null;
  via: "code" | "link";
  connectedAt: number;
  lastActiveAt: number;
  revokedAt: number | null;
  expiresAt: number;
}

export interface EmailChallenge {
  challengeId: string;
  email: string;
  codeHash: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
  attempts: number;
}

export interface MobileTicket {
  ticketHash: string;
  userId: string;
  hostId: string;
  fingerprint: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
}

export interface MobileLink {
  linkHash: string;
  userId: string;
  hostId: string;
  fingerprint: string;
  createdAt: number;
  revokedAt: number | null;
}

export interface RemoteSessionRecord {
  sessionId: string;
  hostId: string;
  userId: string;
  membershipId: string;
  role: "owner" | "admin" | "member";
  authEpoch: number;
  authSessionHash: string | null;
  startedAt: number;
  expiresAt: number;
  endedAt: number | null;
}

export interface TicketKeyRecord {
  kid: string;
  privateJwk: string;
  publicJwk: string;
}

export interface State {
  version: typeof STATE_VERSION;
  ticketKey: TicketKeyRecord | null;
  user: LocalUser | null;
  host: LocalHost | null;
  desktopSessions: DesktopSession[];
  mobileSessions: MobileSession[];
  challenges: EmailChallenge[];
  mobileTickets: MobileTicket[];
  mobileLinks: MobileLink[];
  remoteSessions: RemoteSessionRecord[];
}

export function emptyState(): State {
  return {
    version: STATE_VERSION,
    ticketKey: null,
    user: null,
    host: null,
    desktopSessions: [],
    mobileSessions: [],
    challenges: [],
    mobileTickets: [],
    mobileLinks: [],
    remoteSessions: [],
  };
}

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function randomIdentifier(): string {
  return randomUUID();
}

export function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function hostFingerprint(devicePublicKey: string): string {
  return createHash("sha256").update(devicePublicKey).digest("base64url");
}

export class StateStore {
  readonly #path: string;
  #state: State;
  #queue: Promise<void> = Promise.resolve();

  private constructor(path: string, state: State) {
    this.#path = path;
    this.#state = state;
  }

  static load(path: string): Effect.Effect<StateStore, LocalPairingError> {
    return Effect.try({
      try: () => {
        if (!existsSync(path)) return new StateStore(path, emptyState());
        return new StateStore(path, decodeState(JSON.parse(readFileSync(path, "utf8"))));
      },
      catch: (error) =>
        error instanceof LocalPairingError
          ? error
          : new LocalPairingError(500, "state_unreadable", "The local pairing state file could not be read."),
    });
  }

  snapshot(): State {
    return structuredClone(this.#state);
  }

  update<T>(mutation: (state: State) => T): Effect.Effect<T, LocalPairingError> {
    const run = this.#queue.then(() => {
      const next = structuredClone(this.#state);
      pruneState(next, Date.now());
      const result = mutation(next);
      this.#write(next);
      this.#state = next;
      return result;
    });
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return Effect.tryPromise({
      try: () => run,
      catch: (error) =>
        error instanceof LocalPairingError
          ? error
          : new LocalPairingError(500, "state_write_failed", "The local pairing state could not be saved."),
    });
  }

  #write(state: State): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.#path);
  }
}

function pruneState(state: State, now: number): void {
  const cutoff = now - PRUNE_AFTER_MS;
  state.challenges = state.challenges.filter((challenge) => challenge.expiresAt > cutoff);
  state.mobileTickets = state.mobileTickets.filter((ticket) => ticket.expiresAt > cutoff);
  state.mobileLinks = state.mobileLinks.filter((link) => link.revokedAt === null || link.revokedAt > cutoff);
  state.remoteSessions = state.remoteSessions.filter(
    (session) => session.expiresAt > cutoff && (session.endedAt === null || session.endedAt > cutoff),
  );
  state.desktopSessions = state.desktopSessions.filter(
    (session) => session.revokedAt === null || session.revokedAt > cutoff,
  );
  state.mobileSessions = state.mobileSessions.filter(
    (session) => session.revokedAt === null || session.revokedAt > cutoff,
  );
}

function decodeState(value: unknown): State {
  const source = recordOf(value, "local pairing state");
  if (source.version !== STATE_VERSION) {
    throw new LocalPairingError(500, "state_version_unsupported", "The local pairing state version is not supported.");
  }
  return {
    version: STATE_VERSION,
    ticketKey: nullableOf(source.ticketKey, decodeTicketKey),
    user: nullableOf(source.user, decodeUser),
    host: nullableOf(source.host, decodeHost),
    desktopSessions: arrayOf(source.desktopSessions, "desktop sessions", decodeDesktopSession),
    mobileSessions: arrayOf(source.mobileSessions, "mobile sessions", decodeMobileSession),
    challenges: arrayOf(source.challenges, "email challenges", decodeChallenge),
    mobileTickets: arrayOf(source.mobileTickets, "mobile tickets", decodeMobileTicket),
    mobileLinks: arrayOf(source.mobileLinks, "mobile links", decodeMobileLink),
    remoteSessions: arrayOf(source.remoteSessions, "remote sessions", decodeRemoteSession),
  };
}

function decodeTicketKey(value: unknown): TicketKeyRecord {
  const source = recordOf(value, "ticket key");
  return {
    kid: textOf(source.kid, "ticket key ID"),
    privateJwk: textOf(source.privateJwk, "ticket private key"),
    publicJwk: textOf(source.publicJwk, "ticket public key"),
  };
}

function decodeUser(value: unknown): LocalUser {
  const source = recordOf(value, "user");
  return {
    id: textOf(source.id, "user ID"),
    email: textOf(source.email, "user email"),
    name: nullableTextOf(source.name, "user name"),
    avatarUrl: nullableTextOf(source.avatarUrl, "user avatar"),
    analyticsEnabled: nullableBooleanOf(source.analyticsEnabled, "user analytics answer"),
  };
}

function decodeHost(value: unknown): LocalHost {
  const source = recordOf(value, "host");
  return {
    hostId: textOf(source.hostId, "host ID"),
    ownerUserId: textOf(source.ownerUserId, "host owner"),
    name: textOf(source.name, "host name"),
    devicePublicKey: nullableTextOf(source.devicePublicKey, "host device key"),
    machineTokenHash: textOf(source.machineTokenHash, "host machine token"),
    membershipId: textOf(source.membershipId, "host membership"),
    authEpoch: integerOf(source.authEpoch, "host auth epoch"),
    createdAt: numberOf(source.createdAt, "host creation time"),
    updatedAt: numberOf(source.updatedAt, "host update time"),
  };
}

function decodeDesktopSession(value: unknown): DesktopSession {
  const source = recordOf(value, "desktop session");
  return {
    sessionId: textOf(source.sessionId, "desktop session ID"),
    name: textOf(source.name, "desktop session name"),
    tokenHash: textOf(source.tokenHash, "desktop session token"),
    connectedAt: numberOf(source.connectedAt, "desktop session start"),
    lastActiveAt: numberOf(source.lastActiveAt, "desktop session activity"),
    revokedAt: nullableNumberOf(source.revokedAt, "desktop session revocation"),
  };
}

function decodeMobileSession(value: unknown): MobileSession {
  const source = recordOf(value, "mobile session");
  const via = source.via;
  if (via !== "code" && via !== "link") throw new Error("Invalid mobile session source.");
  return {
    sessionId: textOf(source.sessionId, "mobile session ID"),
    name: textOf(source.name, "mobile session name"),
    platform: platformOf(source.platform),
    tokenHash: textOf(source.tokenHash, "mobile session token"),
    hostId: nullableTextOf(source.hostId, "mobile session host"),
    fingerprint: nullableTextOf(source.fingerprint, "mobile session fingerprint"),
    via,
    connectedAt: numberOf(source.connectedAt, "mobile session start"),
    lastActiveAt: numberOf(source.lastActiveAt, "mobile session activity"),
    revokedAt: nullableNumberOf(source.revokedAt, "mobile session revocation"),
    expiresAt: numberOf(source.expiresAt ?? MOBILE_SESSION_EXPIRES_AT, "mobile session expiry"),
  };
}

function decodeChallenge(value: unknown): EmailChallenge {
  const source = recordOf(value, "email challenge");
  return {
    challengeId: textOf(source.challengeId, "email challenge ID"),
    email: textOf(source.email, "email challenge address"),
    codeHash: textOf(source.codeHash, "email challenge code"),
    createdAt: numberOf(source.createdAt, "email challenge start"),
    expiresAt: numberOf(source.expiresAt, "email challenge expiry"),
    consumedAt: nullableNumberOf(source.consumedAt, "email challenge use"),
    attempts: integerOf(source.attempts, "email challenge attempts"),
  };
}

function decodeMobileTicket(value: unknown): MobileTicket {
  const source = recordOf(value, "mobile ticket");
  return {
    ticketHash: textOf(source.ticketHash, "mobile ticket"),
    userId: textOf(source.userId, "mobile ticket user"),
    hostId: textOf(source.hostId, "mobile ticket host"),
    fingerprint: textOf(source.fingerprint, "mobile ticket fingerprint"),
    createdAt: numberOf(source.createdAt, "mobile ticket start"),
    expiresAt: numberOf(source.expiresAt, "mobile ticket expiry"),
    consumedAt: nullableNumberOf(source.consumedAt, "mobile ticket use"),
  };
}

function decodeMobileLink(value: unknown): MobileLink {
  const source = recordOf(value, "mobile link");
  return {
    linkHash: textOf(source.linkHash, "mobile link"),
    userId: textOf(source.userId, "mobile link user"),
    hostId: textOf(source.hostId, "mobile link host"),
    fingerprint: textOf(source.fingerprint, "mobile link fingerprint"),
    createdAt: numberOf(source.createdAt, "mobile link start"),
    revokedAt: nullableNumberOf(source.revokedAt, "mobile link revocation"),
  };
}

function decodeRemoteSession(value: unknown): RemoteSessionRecord {
  const source = recordOf(value, "remote session");
  const role = source.role;
  if (role !== "owner" && role !== "admin" && role !== "member") throw new Error("Invalid remote session role.");
  return {
    sessionId: textOf(source.sessionId, "remote session ID"),
    hostId: textOf(source.hostId, "remote session host"),
    userId: textOf(source.userId, "remote session user"),
    membershipId: textOf(source.membershipId, "remote session membership"),
    role,
    authEpoch: integerOf(source.authEpoch, "remote session auth epoch"),
    authSessionHash: nullableTextOf(source.authSessionHash, "remote session auth session"),
    startedAt: numberOf(source.startedAt, "remote session start"),
    expiresAt: numberOf(source.expiresAt, "remote session expiry"),
    endedAt: nullableNumberOf(source.endedAt, "remote session end"),
  };
}

function recordOf(value: unknown, label: string): DynamicRecord {
  if (!isDynamicRecord(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function textOf(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid ${label}.`);
  return value;
}

function nullableTextOf(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`Invalid ${label}.`);
  return value;
}

function numberOf(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function nullableNumberOf(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return numberOf(value, label);
}

function integerOf(value: unknown, label: string): number {
  const parsed = numberOf(value, label);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid ${label}.`);
  return parsed;
}

function nullableBooleanOf(value: unknown, label: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") throw new Error(`Invalid ${label}.`);
  return value;
}

function platformOf(value: unknown): MobileDevicePlatform {
  if (value !== "ios" && value !== "android" && value !== "unknown") throw new Error("Invalid mobile platform.");
  return value;
}

function nullableOf<T>(value: unknown, decode: (value: unknown) => T): T | null {
  if (value === null || value === undefined) return null;
  return decode(value);
}

function arrayOf<T>(value: unknown, label: string, decode: (value: unknown) => T): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  return value.map(decode);
}
