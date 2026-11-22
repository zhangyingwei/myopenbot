import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { exportJWK, generateKeyPair, importJWK, type JWK, SignJWT } from "jose";
import type { TicketKeyRecord } from "./state";

export const REMOTE_TICKET_AUDIENCE = "openbot-remote";
export const REMOTE_TICKET_PROTOCOL_VERSION = 2;
export const TICKET_TTL_SECONDS = 180;
export const PERSISTENT_SESSION_EXPIRES_AT = 8_640_000_000_000_000;
export const SERVICE_TIMESTAMP_TOLERANCE_SECONDS = 300;

export interface TicketClaims {
  sessionId: string;
  hostId: string;
  userId: string;
  membershipId: string;
  role: "host" | "owner" | "admin" | "member";
  authEpoch: number;
  sessionExpiresAt: number;
  clientPublicKey?: string;
}

export class TicketSigner {
  readonly #kid: string;
  readonly #publicJwk: JWK;
  readonly #privateKey: Awaited<ReturnType<typeof importJWK>>;

  constructor(kid: string, publicJwk: JWK, privateKey: Awaited<ReturnType<typeof importJWK>>) {
    this.#kid = kid;
    this.#publicJwk = publicJwk;
    this.#privateKey = privateKey;
  }

  publicJwks(): { keys: JWK[] } {
    return { keys: [this.#publicJwk] };
  }

  async issue(claims: TicketClaims, now = Date.now()): Promise<{ ticket: string; expiresAt: number }> {
    const issuedAt = Math.floor(now / 1_000);
    const expiresAt = Math.min(issuedAt + TICKET_TTL_SECONDS, Math.floor(claims.sessionExpiresAt / 1_000));
    const ticket = await new SignJWT({
      sessionId: claims.sessionId,
      hostId: claims.hostId,
      userId: claims.userId,
      membershipId: claims.membershipId,
      role: claims.role,
      authEpoch: claims.authEpoch,
      protocolMinimum: REMOTE_TICKET_PROTOCOL_VERSION,
      protocolMaximum: REMOTE_TICKET_PROTOCOL_VERSION,
      sessionExpiresAt: Math.floor(claims.sessionExpiresAt / 1_000),
      ...(claims.clientPublicKey ? { clientPublicKey: claims.clientPublicKey } : {}),
    })
      .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: this.#kid })
      .setJti(randomUUID())
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .setAudience(REMOTE_TICKET_AUDIENCE)
      .sign(this.#privateKey);
    return { ticket, expiresAt: expiresAt * 1_000 };
  }
}

export async function createTicketSigner(
  existing: TicketKeyRecord | null,
): Promise<{ signer: TicketSigner; created: TicketKeyRecord | null }> {
  if (existing) {
    const privateJwk = parseJwk(existing.privateJwk);
    const publicJwk = parseJwk(existing.publicJwk);
    return {
      signer: new TicketSigner(existing.kid, publicJwk, await importJWK(privateJwk, "ES256")),
      created: null,
    };
  }
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const kid = `local-pairing-${randomUUID()}`;
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), alg: "ES256", use: "sig", kid };
  const privateJwk: JWK = { ...(await exportJWK(privateKey)), alg: "ES256", use: "sig", kid };
  return {
    signer: new TicketSigner(kid, publicJwk, await importJWK(privateJwk, "ES256")),
    created: { kid, privateJwk: JSON.stringify(privateJwk), publicJwk: JSON.stringify(publicJwk) },
  };
}

function parseJwk(value: string): JWK {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("The local pairing ticket key is not valid JSON.");
  }
  if (!isDynamicRecord(parsed) || parsed.kty !== "EC") {
    throw new Error("The local pairing ticket key is invalid.");
  }
  return { ...parsed, kty: "EC" };
}

export function verifyServiceRequest(
  secret: string | null,
  body: string,
  timestamp: string | null,
  signature: string | null,
  now = Date.now(),
): boolean {
  if (!secret || !timestamp || !signature) return false;
  if (!/^\d{1,12}$/u.test(timestamp)) return false;
  const seconds = Number(timestamp);
  if (Math.abs(Math.floor(now / 1_000) - seconds) > SERVICE_TIMESTAMP_TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "base64url");
  } catch {
    return false;
  }
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
