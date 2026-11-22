import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { LocalPairingError } from "./errors";
import type { AuthenticatedSession, LocalPairingService } from "./service";
import { hashToken } from "./state";

const COOKIE = "openbot_local_web";
const COOKIE_MAX_AGE_SECONDS = 31_536_000;
const MAX_BODY_BYTES = 1_000_000;

export async function handleBrowserRequest(
  request: Request,
  path: string,
  service: LocalPairingService,
): Promise<Response> {
  const method = request.method;

  if (method === "POST" && path === "email/start") {
    const email = stringField(await readJsonObject(request), "email");
    if (!email) return failure(400, "invalid_email", "Enter a valid email address.");
    return json(await run(service.startEmailSignIn(email)));
  }

  if (method === "POST" && path === "email/verify") {
    const body = await readJsonObject(request);
    const challengeId = stringField(body, "challengeId");
    const code = stringField(body, "code");
    if (!challengeId || !code) return failure(400, "invalid_sign_in_code", "The sign-in code is invalid.");
    const result = await run(service.verifyEmailCode({ challengeId, code, surface: "desktop" }));
    const response = json({ user: result.user });
    response.headers.append("set-cookie", sessionCookie(result.sessionToken));
    return response;
  }

  if (method === "POST" && path === "company/start") {
    return failure(400, "company_sign_in_unavailable", "Company sign-in is not available in local mode.");
  }

  const token = cookieValue(request, COOKIE);

  if (method === "GET" && path === "session") {
    const current = token ? await authenticate(service, token) : null;
    if (current) return json({ user: current.user });
    const created = await run(service.openBrowserSession());
    const response = json({ user: created.user });
    response.headers.append("set-cookie", sessionCookie(created.sessionToken));
    return response;
  }

  if (method === "POST" && path === "logout") {
    if (token) await Effect.runPromise(service.logout(token)).catch(() => undefined);
    const response = json({ signedOut: true });
    response.headers.append("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return response;
  }

  if (!token) return failure(401, "sign_in_required", "Sign in is required.");
  const session = await authenticate(service, token);
  if (session === null) return failure(401, "sign_in_required", "Sign in is required.");
  const userId = session.user.id;

  if (method === "GET" && path === "v1/me") return json(session.user);

  if (method === "PATCH" && path === "v1/me/profile") {
    await readJsonObject(request);
    return json(session.user);
  }

  if (method === "PUT" && (path === "v1/me/analytics" || path === "v1/me/chat-color")) {
    await readJsonObject(request);
    return json(session.user);
  }

  if (path === "v1/me/avatar" && (method === "PUT" || method === "DELETE")) {
    await request.arrayBuffer().catch(() => undefined);
    return json(session.user);
  }

  if (method === "GET" && path === "v1/me/sessions") {
    return json({ sessions: await run(service.listAccountSessions(token)) });
  }

  const revokeSession = /^v1\/me\/sessions\/([^/]+)$/u.exec(path);
  if (revokeSession && method === "DELETE") {
    await run(service.revokeSession(token, decodeURIComponent(revokeSession[1] ?? ""), true));
    return noContent();
  }

  if (method === "GET" && (path === "v2/remote/hosts" || path === "v2/remote/hosts/")) {
    return json(await run(service.listHosts(userId)));
  }

  if (method === "GET" && (path === "v2/remote/owner-transfers" || path === "v2/remote/owner-transfers/")) {
    return json({ transfers: [] });
  }

  const hostRead = /^v2\/remote\/hosts\/([^/]+)$/u.exec(path);
  if (hostRead && method === "GET") {
    return json(await run(service.getHost(userId, decodeURIComponent(hostRead[1] ?? ""))));
  }

  const hostLogo = /^v2\/remote\/hosts\/([^/]+)\/logo$/u.exec(path);
  if (hostLogo && method === "GET") {
    return failure(404, "host_logo_not_found", "The host has no logo.");
  }

  if (method === "POST" && (path === "v2/remote/sessions" || path === "v2/remote/sessions/")) {
    const hostId = stringField(await readJsonObject(request), "hostId");
    if (!hostId) return failure(400, "invalid_remote_request", "The host ID is invalid.");
    return json(await run(service.startSession(userId, hostId, hashToken(token))), 201);
  }

  const sessionAction = /^v2\/remote\/sessions\/([^/]+)\/(ticket|end)$/u.exec(path);
  if (sessionAction && method === "POST") {
    const sessionId = decodeURIComponent(sessionAction[1] ?? "");
    if (sessionAction[2] === "end") {
      await run(service.endSession(userId, sessionId));
      return json({ ended: true });
    }
    const clientPublicKey = stringField(await readJsonObject(request), "clientPublicKey");
    if (!clientPublicKey) {
      return failure(400, "invalid_remote_request", "The client public key is required.");
    }
    return json(await run(service.issueSessionTicket(userId, sessionId, clientPublicKey)));
  }

  if (method === "GET" && (path === "v2/hosting/servers" || path === "v2/hosting/servers/")) {
    return json({ available: false, lifecycleAvailable: false, maxServers: null, servers: [] });
  }

  if (method === "POST" && path === "checkout-attribution") return json({ accepted: true });

  return failure(404, "browser_operation_not_found", "This browser operation is not available.");
}

async function authenticate(service: LocalPairingService, token: string): Promise<AuthenticatedSession | null> {
  try {
    return await Effect.runPromise(service.authenticate(token));
  } catch (error) {
    if (error instanceof LocalPairingError && error.status === 401) return null;
    throw error;
  }
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      return value === "" ? null : value;
    }
  }
  return null;
}

function sessionCookie(token: string): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}`;
}

async function readJsonObject(request: Request): Promise<DynamicRecord> {
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) throw new LocalPairingError(400, "invalid_json", "The request body is invalid.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new LocalPairingError(400, "invalid_json", "The request body is invalid.");
  }
  if (!isDynamicRecord(parsed)) throw new LocalPairingError(400, "invalid_json", "The request body is invalid.");
  return parsed;
}

function stringField(body: DynamicRecord, key: string): string | null {
  const value = body[key];
  return isString(value) ? value : null;
}

async function run<A>(effect: Effect.Effect<A, LocalPairingError>): Promise<A> {
  return Effect.runPromise(effect);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
  });
}

function noContent(): Response {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

function failure(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
  });
}
