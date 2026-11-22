import { isMobileConnectHostBinding } from "@openbot/contracts/mobile-connect";
import { mobileFeaturesOff } from "@openbot/contracts/mobile-features";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import type { Logger } from "@openbot/logging";
import { Effect } from "effect";
import { handleBrowserRequest } from "./browser-api";
import type { LocalPairingConfig } from "./config";
import { LocalPairingError } from "./errors";
import type { LocalPairingService, MobileDeviceIdentity, RegistrationInput, ResumeClaims } from "./service";
import { hashToken } from "./state";
import { verifyServiceRequest } from "./tickets";
import { serveLocalWeb } from "./web";

const MAX_BODY_BYTES = 1_000_000;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ROLES = ["host", "owner", "admin", "member"] as const;
const MARKETPLACE_PATH = /^\/(?:v1\/(?:marketplace|skills)|plugins\/icon)\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u;

function isRole(value: unknown): value is (typeof ROLES)[number] {
  return isString(value) && ROLES.some((role) => role === value);
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, idempotency-key, openbot-timestamp, openbot-signature",
  "access-control-max-age": "600",
};

export interface LocalPairingHandlerOptions {
  config: LocalPairingConfig;
  service: LocalPairingService;
  logger: Logger;
}

export function createLocalPairingHandler(
  options: LocalPairingHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      return withCors(await route(request, options));
    } catch (error) {
      if (error instanceof LocalPairingError) {
        return withCors(apiError(error.status, error.code, error.message));
      }
      options.logger.error("Local pairing request failed", errorText(error));
      return withCors(apiError(500, "internal_error", "The local pairing service failed."));
    }
  };
}

async function route(request: Request, options: LocalPairingHandlerOptions): Promise<Response> {
  const { service, config } = options;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const segments = path.split("/").filter(Boolean);

  if (method === "GET" && path === "/health/live") return json({ status: "ok" });
  if (method === "GET" && path === "/.well-known/jwks.json") return json(service.jwks());
  if (path === "/app" || path.startsWith("/app/")) return serveLocalWeb(request, config.webRoot);
  if (path === "/api/browser" || path.startsWith("/api/browser/")) {
    return handleBrowserRequest(request, path.slice("/api/browser".length).replace(/^\/+/u, ""), service);
  }
  if (method === "GET" && path === "/v1/mobile/features") {
    return json({ features: mobileFeaturesOff(), latestVersion: null, minimumVersion: null });
  }

  if (
    config.marketplaceBaseUrl !== null &&
    (path.startsWith("/v1/marketplace/") || path.startsWith("/v1/skills/") || path.startsWith("/plugins/icon/"))
  ) {
    return marketplaceRead(request, path, url.search, config.marketplaceBaseUrl, options.logger);
  }

  if (method === "POST" && path === "/v1/auth/email/start") {
    const body = await readJsonObject(request);
    const email = stringField(body, "email");
    if (!email) throw invalid("invalid_email", "Enter a valid email address.");
    return json(await run(service.startEmailSignIn(email)));
  }

  if (method === "POST" && path === "/v1/auth/email/verify") {
    const body = await readJsonObject(request);
    const challengeId = stringField(body, "challengeId");
    const code = stringField(body, "code");
    if (!challengeId || !code) throw invalid("invalid_sign_in_code", "The sign-in code is invalid.");
    return json(await run(service.verifyEmailCode({ challengeId, code, surface: "desktop" })));
  }

  if (method === "POST" && path === "/v1/mobile-auth/email/verify") {
    const body = await readJsonObject(request);
    const challengeId = stringField(body, "challengeId");
    const code = stringField(body, "code");
    if (!challengeId || !code) throw invalid("invalid_sign_in_code", "The sign-in code is invalid.");
    return json(
      await run(
        service.verifyEmailCode({
          challengeId,
          code,
          surface: "mobile",
          device: mobileDevice(body),
        }),
      ),
    );
  }

  if (method === "POST" && path === "/v1/auth/logout") {
    const token = bearer(request);
    await run(service.logout(token));
    return noContent();
  }

  if (method === "POST" && path === "/v1/github/installation-tokens") return json({ installations: [] });

  if (method === "GET" && path === "/v1/me") {
    const token = bearer(request);
    const session = await run(service.authenticate(token));
    return json(session.user);
  }

  if (
    (method === "GET" || method === "PUT") &&
    (path === "/v1/me/analytics" || path === "/v1/me/profile" || path === "/v1/me/chat-color")
  ) {
    const token = bearer(request);
    const session = await run(service.authenticate(token));
    if (method === "PUT") await readJsonObject(request);
    return json(session.user);
  }

  if (method === "POST" && path === "/v1/mobile-auth/ticket") {
    const token = bearer(request);
    const session = await run(service.authenticateDesktop(token));
    const body = await readJsonObject(request);
    const host = readHostBinding(body);
    return json(await run(service.createMobileTicket(session.user.id, host)));
  }

  if (method === "DELETE" && path === "/v1/mobile-auth/ticket") {
    const token = bearer(request);
    const session = await run(service.authenticateDesktop(token));
    await run(service.cancelMobileTickets(session.user.id, url.searchParams.get("host") ?? ""));
    return noContent();
  }

  if (method === "POST" && path === "/v1/mobile-auth/link") {
    const token = bearer(request);
    const session = await run(service.authenticateDesktop(token));
    const body = await readJsonObject(request);
    const host = readHostBinding(body);
    return json(await run(service.createLink(session.user.id, host)));
  }

  if (method === "DELETE" && path === "/v1/mobile-auth/link") {
    const token = bearer(request);
    const session = await run(service.authenticateDesktop(token));
    await run(service.revokeLink(session.user.id, url.searchParams.get("host") ?? ""));
    return noContent();
  }

  if (method === "POST" && path === "/v1/mobile-auth/redeem") {
    const body = await readJsonObject(request);
    const ticket = stringField(body, "ticket");
    if (!ticket) throw invalid("invalid_mobile_ticket", "The Mobile Connect code is invalid.");
    const session = await run(service.redeemMobileTicket(ticket, mobileDevice(body)));
    if (!session) throw invalid("invalid_mobile_ticket", "The Mobile Connect code is invalid or expired.");
    return json(session);
  }

  if (method === "GET" && path === "/v1/mobile-auth/session") {
    const token = bearer(request);
    const session = await run(service.authenticateMobile(token));
    return json(session.user);
  }

  if (method === "DELETE" && path === "/v1/mobile-auth/session") {
    const token = bearer(request);
    await run(service.logoutMobile(token));
    return noContent();
  }

  if (method === "GET" && path === "/v1/mobile-auth/devices") {
    const token = bearer(request);
    if (url.searchParams.get("includeDesktop") === "true") {
      return json({ sessions: await run(service.listAccountSessions(token)) });
    }
    return json({ devices: await run(service.listMobileDevices(token, url.searchParams.get("host"))) });
  }

  if (
    method === "DELETE" &&
    segments.length === 4 &&
    segments[0] === "v1" &&
    segments[1] === "mobile-auth" &&
    segments[2] === "devices"
  ) {
    const token = bearer(request);
    await run(service.revokeSession(token, segments[3] ?? "", url.searchParams.get("includeDesktop") === "true"));
    return noContent();
  }

  if (method === "GET" && (path === "/v2/hosting/servers" || path === "/v2/hosting/servers/")) {
    const token = bearer(request);
    await run(service.authenticate(token));
    return json({ available: false, lifecycleAvailable: false, servers: [], maxServers: null });
  }

  if (method === "GET" && (path === "/v2/remote/owner-transfers" || path === "/v2/remote/owner-transfers/")) {
    const token = bearer(request);
    await run(service.authenticate(token));
    return json({ transfers: [] });
  }

  if (method === "POST" && path === "/v2/remote/hosts/register") {
    const token = bearer(request);
    const session = await run(service.authenticate(token));
    const body = await readJsonObject(request);
    return json(await run(service.registerHost(session.user.id, registrationInput(body))), 201);
  }

  if (method === "GET" && (path === "/v2/remote/hosts" || path === "/v2/remote/hosts/")) {
    const token = bearer(request);
    const session = await run(service.authenticate(token));
    return json(await run(service.listHosts(session.user.id)));
  }

  if (
    segments.length === 4 &&
    segments[0] === "v2" &&
    segments[1] === "remote" &&
    segments[2] === "hosts" &&
    segments[3] !== "register"
  ) {
    const hostId = segments[3] ?? "";
    const token = bearer(request);
    const session = await run(service.authenticate(token));
    if (method === "GET") return json(await run(service.getHost(session.user.id, hostId)));
  }

  if (
    method === "GET" &&
    segments.length === 5 &&
    segments[0] === "v2" &&
    segments[1] === "remote" &&
    segments[2] === "hosts" &&
    segments[4] === "invites"
  ) {
    const token = bearer(request);
    const session = await run(service.authenticate(token));
    await run(service.getHost(session.user.id, segments[3] ?? ""));
    return json({ invites: [] });
  }

  if (
    method === "POST" &&
    segments.length === 5 &&
    segments[0] === "v2" &&
    segments[1] === "remote" &&
    segments[2] === "hosts" &&
    segments[4] === "ticket"
  ) {
    const body = await readJsonObject(request);
    const machineToken = stringField(body, "machineToken");
    if (!machineToken) throw invalid("invalid_remote_request", "The host credential is invalid.");
    return json(await run(service.issueHostTicket(segments[3] ?? "", machineToken)));
  }

  if (
    method === "POST" &&
    segments.length === 5 &&
    segments[0] === "v2" &&
    segments[1] === "remote" &&
    segments[2] === "hosts" &&
    segments[4] === "key-handover"
  ) {
    throw invalid("not_supported", "Host key handover is not supported by the local pairing service.");
  }

  if (
    segments.length === 5 &&
    segments[0] === "v2" &&
    segments[1] === "remote" &&
    segments[2] === "hosts" &&
    segments[4] === "members"
  ) {
    const token = bearer(request);
    const session = await run(service.authenticate(token));
    return json(await run(service.listMembers(session.user.id, segments[3] ?? "")));
  }

  if (
    method === "POST" &&
    segments.length === 4 &&
    segments[0] === "v2" &&
    segments[1] === "remote" &&
    segments[2] === "hosts" &&
    segments[3] === "ticket"
  ) {
    throw invalid("not_found", "The requested resource was not found.");
  }

  if (method === "POST" && (path === "/v2/remote/sessions" || path === "/v2/remote/sessions/")) {
    const token = bearer(request);
    const session = await run(service.authenticate(token));
    const body = await readJsonObject(request);
    const hostId = stringField(body, "hostId");
    if (!hostId) throw invalid("invalid_remote_request", "The host ID is invalid.");
    return json(await run(service.startSession(session.user.id, hostId, hashToken(token))), 201);
  }

  if (
    method === "POST" &&
    segments.length === 5 &&
    segments[0] === "v2" &&
    segments[1] === "remote" &&
    segments[2] === "sessions" &&
    segments[4] === "ticket"
  ) {
    const token = bearer(request);
    const session = await run(service.authenticate(token));
    const body = await readJsonObject(request);
    const clientPublicKey = stringField(body, "clientPublicKey");
    if (!clientPublicKey) throw invalid("invalid_remote_request", "The client public key is required.");
    return json(await run(service.issueSessionTicket(session.user.id, segments[3] ?? "", clientPublicKey)));
  }

  if (
    method === "POST" &&
    segments.length === 5 &&
    segments[0] === "v2" &&
    segments[1] === "remote" &&
    segments[2] === "sessions" &&
    segments[4] === "end"
  ) {
    const token = bearer(request);
    const session = await run(service.authenticate(token));
    await run(service.endSession(session.user.id, segments[3] ?? ""));
    return noContent();
  }

  if (method === "POST" && path === "/v2/remote/resume/validate") {
    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) throw invalid("invalid_resume_claims", "The resume claims are invalid.");
    if (
      !verifyServiceRequest(
        config.authWebhookSecret,
        body,
        request.headers.get("openbot-timestamp"),
        request.headers.get("openbot-signature"),
      )
    ) {
      throw invalid("invalid_signature", "The Remote service signature is invalid.");
    }
    return json({ valid: await run(service.validateResume(readResumeClaims(body))) });
  }

  throw invalid("not_found", "The requested resource was not found.");
}

function readResumeClaims(body: string): ResumeClaims {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw invalid("invalid_resume_claims", "The resume claims are invalid.");
  }
  if (!isDynamicRecord(parsed)) throw invalid("invalid_resume_claims", "The resume claims are invalid.");
  const sessionId = boundedString(parsed.sessionId);
  const hostId = boundedString(parsed.hostId);
  const userId = boundedString(parsed.userId);
  const membershipId = boundedString(parsed.membershipId);
  const role = parsed.role;
  const authEpoch = parsed.authEpoch;
  const sessionExpiresAt = parsed.sessionExpiresAt;
  if (
    !sessionId ||
    !hostId ||
    !userId ||
    !membershipId ||
    !isRole(role) ||
    typeof authEpoch !== "number" ||
    !Number.isSafeInteger(authEpoch) ||
    authEpoch < 0 ||
    typeof sessionExpiresAt !== "number" ||
    !Number.isSafeInteger(sessionExpiresAt) ||
    sessionExpiresAt <= 0
  ) {
    throw invalid("invalid_resume_claims", "The resume claims are invalid.");
  }
  return {
    sessionId,
    hostId,
    userId,
    membershipId,
    role,
    authEpoch,
    sessionExpiresAt,
  };
}

function registrationInput(body: DynamicRecord): RegistrationInput {
  const hostId = stringField(body, "hostId");
  const name = stringField(body, "name");
  const ownerMembershipId = stringField(body, "ownerMembershipId");
  if (!hostId || !name || !ownerMembershipId) {
    throw invalid("invalid_remote_request", "The host registration is invalid.");
  }
  const devicePublicKey = body.devicePublicKey;
  if (
    !(
      devicePublicKey === undefined ||
      devicePublicKey === null ||
      (isString(devicePublicKey) && devicePublicKey.length <= 8_192)
    )
  ) {
    throw invalid("invalid_remote_request", "The host public key is invalid.");
  }
  const rotateCredential = body.rotateCredential;
  if (!(rotateCredential === undefined || typeof rotateCredential === "boolean")) {
    throw invalid("invalid_remote_request", "The host registration is invalid.");
  }
  const machineToken = body.machineToken;
  if (!(machineToken === undefined || isString(machineToken))) {
    throw invalid("invalid_remote_request", "The host credential is invalid.");
  }
  const automatic = body.automatic;
  if (!(automatic === undefined || typeof automatic === "boolean")) {
    throw invalid("invalid_remote_request", "The host registration is invalid.");
  }
  return {
    hostId,
    name,
    ownerMembershipId,
    devicePublicKey,
    rotateCredential,
    machineToken,
    automatic,
  };
}

function readHostBinding(body: DynamicRecord) {
  if (!isMobileConnectHostBinding(body.host)) {
    throw invalid("invalid_mobile_host", "Update the desktop app to create a host-bound Mobile Connect code.");
  }
  return body.host;
}

function mobileDevice(body: DynamicRecord): MobileDeviceIdentity {
  const id = stringField(body, "deviceId");
  const rawName = stringField(body, "deviceName");
  const platform = body.platform;
  if (
    !id ||
    !UUID_V4_PATTERN.test(id) ||
    !rawName ||
    (platform !== "ios" && platform !== "android" && platform !== "unknown")
  ) {
    throw invalid("invalid_mobile_device", "The mobile device is invalid.");
  }
  const name = rawName.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!name || name.length > 80 || /[\p{Cc}\p{Cf}]/u.test(name)) {
    throw invalid("invalid_mobile_device", "The mobile device is invalid.");
  }
  return { id, name, platform };
}

function bearer(request: Request): string {
  const header = request.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw invalid("unauthorized", "Sign in is required.");
  return token;
}

async function readJsonObject(request: Request): Promise<DynamicRecord> {
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) throw invalid("invalid_json", "The request body is invalid.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw invalid("invalid_json", "The request body is invalid.");
  }
  if (!isDynamicRecord(parsed)) throw invalid("invalid_json", "The request body is invalid.");
  return parsed;
}

function stringField(body: DynamicRecord, key: string): string | null {
  const value = body[key];
  return isString(value) ? value : null;
}

function boundedString(value: unknown): string | null {
  return isString(value) && value.length > 0 && value.length <= 256 ? value : null;
}

async function run<A>(effect: Effect.Effect<A, LocalPairingError>): Promise<A> {
  return Effect.runPromise(effect);
}

async function marketplaceRead(
  request: Request,
  path: string,
  search: string,
  baseUrl: string,
  logger: Logger,
): Promise<Response> {
  if (request.method !== "GET") return apiError(404, "not_found", "The requested resource was not found.");
  if (!MARKETPLACE_PATH.test(path) || path.includes("..") || path.includes("//") || /%(?:2e|2f|5c)/iu.test(path)) {
    return apiError(404, "not_found", "The requested resource was not found.");
  }
  if (path === "/v1/marketplace/agents/mine" || path === "/v1/skills/mine") return json([]);
  try {
    const target = new URL(`${path}${search}`, baseUrl);
    const answer = await fetch(target, {
      method: "GET",
      headers: { accept: request.headers.get("accept") ?? "*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    const headers = new Headers();
    for (const name of ["content-type", "cache-control", "etag", "last-modified"]) {
      const value = answer.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(answer.body, { status: answer.status, headers });
  } catch (error) {
    logger.warn("The marketplace catalog request failed.", errorText(error));
    return apiError(502, "marketplace_unavailable", "The marketplace catalog is not available.");
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function noContent(): Response {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

function apiError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function invalid(code: string, message: string): LocalPairingError {
  return new LocalPairingError(
    code === "not_found"
      ? 404
      : code === "not_supported"
        ? 400
        : code === "unauthorized" || code === "invalid_signature" || code === "invalid_mobile_ticket"
          ? 401
          : 400,
    code,
    message,
  );
}

function withCors(response: Response): Response {
  for (const [key, value] of Object.entries(CORS_HEADERS)) response.headers.set(key, value);
  return response;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
