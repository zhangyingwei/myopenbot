import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";

const cryptoApi = globalThis.crypto;

if (typeof cryptoApi.randomUUID !== "function") {
  Object.defineProperty(cryptoApi, "randomUUID", {
    configurable: true,
    writable: true,
    value: () => {
      const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
      bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
      bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
  });
}

const LOCK_PREFIX = "openbot.local.lock.";
const LEASE_MS = 10_000;
const HEARTBEAT_MS = 3_000;
const POLL_MS = 100;
const WAIT_LIMIT_MS = 30_000;

interface LockLease {
  owner: string;
  expiresAt: number;
}

interface FallbackLock {
  name: string;
  mode: "exclusive";
}

type LockCallback = (lock: FallbackLock | null) => Promise<void> | void;

interface LockOptionsLike {
  ifAvailable?: boolean;
  signal?: AbortSignal;
}

function readLease(key: string): LockLease | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isDynamicRecord(parsed) || !isString(parsed.owner) || typeof parsed.expiresAt !== "number") return null;
    return { owner: parsed.owner, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

function writeLease(key: string, lease: LockLease): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(lease));
  } catch {}
}

function removeLease(key: string, owner: string): void {
  const lease = readLease(key);
  if (lease?.owner !== owner) return;
  try {
    window.localStorage.removeItem(key);
  } catch {}
}

function abortError(): Error {
  const error = new Error("The lock request was aborted.");
  error.name = "AbortError";
  return error;
}

async function requestLock(name: string, options: LockOptionsLike | undefined, callback: LockCallback): Promise<void> {
  const key = `${LOCK_PREFIX}${name}`;
  const owner = cryptoApi.randomUUID();
  const signal = options?.signal;
  const deadline = Date.now() + WAIT_LIMIT_MS;
  const attempt = (): boolean => {
    const current = readLease(key);
    const now = Date.now();
    if (current && current.expiresAt > now) return false;
    writeLease(key, { owner, expiresAt: now + LEASE_MS });
    return readLease(key)?.owner === owner;
  };
  if (!attempt()) {
    if (options?.ifAvailable) {
      await callback(null);
      return;
    }
    while (!attempt()) {
      if (signal?.aborted) throw abortError();
      if (Date.now() > deadline) throw abortError();
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
  const heartbeat = window.setInterval(() => {
    const lease = readLease(key);
    if (lease?.owner === owner) writeLease(key, { owner, expiresAt: Date.now() + LEASE_MS });
  }, HEARTBEAT_MS);
  try {
    await callback({ name, mode: "exclusive" });
  } finally {
    window.clearInterval(heartbeat);
    removeLease(key, owner);
  }
}

if (!navigator.locks) {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: requestLock },
  });
}

if (typeof navigator.clipboard?.writeText !== "function") {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText(text: string): Promise<void> {
        return new Promise((resolve, reject) => {
          try {
            const area = document.createElement("textarea");
            area.value = text;
            area.setAttribute("readonly", "");
            area.style.position = "fixed";
            area.style.opacity = "0";
            document.body.appendChild(area);
            area.select();
            const copied = document.execCommand("copy");
            area.remove();
            if (copied) resolve();
            else reject(new Error("The copy command failed."));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
      write(): Promise<void> {
        return Promise.reject(new Error("The clipboard image write is not available."));
      },
    },
  });
}
