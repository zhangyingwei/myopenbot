import { createSocket } from "node:dgram";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";
import type { LocalPairingConfig } from "../apps/local-pairing/src/config";
import { createLocalPairingRuntime } from "../apps/local-pairing/src/runtime";
import { startLocalStunServer } from "../apps/local-pairing/src/stun";

const ORIGIN = "http://10.222.0.11:3200";
const failures: string[] = [];
const checks: { name: string; ok: boolean; detail?: string }[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  if (!ok) failures.push(name);
}

function expect(actual: unknown, expected: unknown, name: string): void {
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function textField(value: unknown, key: string): string {
  if (!isDynamicRecord(value) || !isString(value[key])) throw new Error(`The response has no ${key}.`);
  return value[key];
}

function booleanField(value: unknown, key: string): boolean {
  if (!isDynamicRecord(value) || typeof value[key] !== "boolean") {
    throw new Error(`The response has no ${key}.`);
  }
  return value[key];
}

function objectList(value: unknown, key: string): unknown[] {
  const items = isDynamicRecord(value) ? value[key] : undefined;
  if (!Array.isArray(items)) throw new Error(`The response has no ${key} list.`);
  return items;
}

const workspace = mkdtempSync(join(tmpdir(), "openbot-local-web-"));
const webRoot = join(workspace, "web");
mkdirSync(join(webRoot, "assets"), { recursive: true });
writeFileSync(join(webRoot, "index.html"), "<!doctype html><html><body>local web</body></html>\n");
writeFileSync(join(webRoot, "assets", "app.js"), "console.log('ok');\n");

const config: LocalPairingConfig = {
  dataDir: workspace,
  statePath: join(workspace, "local-pairing.json"),
  bindAddress: "127.0.0.1",
  apiPort: 3200,
  signalPort: 3111,
  publicApiUrl: ORIGIN,
  publicSignalUrl: "ws://10.222.0.11:3111/v1/signal",
  webRoot,
  marketplaceBaseUrl: null,
  authWebhookSecret: "local-web-e2e-secret",
  userId: "local-owner",
  email: "local@openbot.local",
  name: "Local Owner",
  logLevel: "error",
};

const logger = createOpenBotLogger("local-web-e2e", undefined, "error");
const runtime = await createLocalPairingRuntime(config, logger);

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return runtime.handle(new Request(`${ORIGIN}${path}`, init));
}

function jsonHeaders(token?: string): HeadersInit {
  return {
    "content-type": "application/json",
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  };
}

let cookie = "";

function browser(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  return call(path, { ...init, headers });
}

try {
  const start = await (
    await call("/v1/auth/email/start", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email: "local@openbot.local" }),
    })
  ).json();
  const challengeId = textField(start, "challengeId");
  const code = textField(start, "developmentCode");
  const verified = await (
    await call("/v1/auth/email/verify", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ challengeId, code }),
    })
  ).json();
  const desktopToken = textField(verified, "sessionToken");
  check("desktop sign-in returns a session token", desktopToken.length > 20);

  const devicePublicKey = "mBQ6f0w3Vn2c1sJ8t7w2kK4p9rYx8uL3hG5dN6qA7zE";
  const registered = await (
    await call("/v2/remote/hosts/register", {
      method: "POST",
      headers: jsonHeaders(desktopToken),
      body: JSON.stringify({
        hostId: "host-local",
        name: "Local host",
        ownerMembershipId: "host-local:owner",
        devicePublicKey,
      }),
    })
  ).json();
  const machineToken = textField(registered, "machineToken");
  check("host registration returns a machine token", machineToken.length > 20);

  const shell = await call("/app");
  const shellHtml = await shell.text();
  expect(shell.status, 200, "GET /app returns 200");
  check("GET /app serves the shell", shellHtml.includes("local web"));
  expect(shell.headers.get("cache-control"), "no-store", "the shell is not cached");

  const script = await call("/app/assets/app.js");
  check("GET /app/assets/app.js returns 200", script.status === 200);
  check("hashed assets are cached", (script.headers.get("cache-control") ?? "").includes("immutable"));
  check("asset content type", (script.headers.get("content-type") ?? "").startsWith("text/javascript"));

  const deepLink = await call("/app/agents/anything");
  check("unknown /app paths fall back to the shell", (await deepLink.text()).includes("local web"));

  const outside = await call("/app/../package.json");
  check("paths outside the web root are refused", outside.status === 404);

  const signedOut = await call("/api/browser/v1/me");
  expect(signedOut.status, 401, "browser calls without a cookie get 401");

  const sessionResponse = await call("/api/browser/session");
  const cookieHeader = sessionResponse.headers.get("set-cookie") ?? "";
  cookie = cookieHeader.split(";")[0] ?? "";
  const session = await sessionResponse.json();
  const sessionUser = isDynamicRecord(session) ? session.user : undefined;
  expect(sessionResponse.status, 200, "GET /api/browser/session returns 200");
  expect(textField(sessionUser, "id"), "local-owner", "the browser session maps to local-owner");
  check("the session cookie is HttpOnly", cookieHeader.toLowerCase().includes("httponly"));
  check("the session cookie is not Secure", !cookieHeader.toLowerCase().includes("secure"));
  check("the session cookie has a value", cookie.startsWith("openbot_local_web="));

  const me = await (await browser("/api/browser/v1/me")).json();
  expect(textField(me, "id"), "local-owner", "GET /api/browser/v1/me returns the owner");

  const hosts = await (await browser("/api/browser/v2/remote/hosts")).json();
  const hostList = objectList(hosts, "hosts");
  expect(hostList.length, 1, "the browser lists the local host");
  expect(textField(hostList[0], "hostId"), "host-local", "the host id matches");

  const transfers = await browser("/api/browser/v2/remote/owner-transfers/");
  expect(transfers.status, 200, "the owner transfer list answers");
  expect(objectList(await transfers.json(), "transfers").length, 0, "the owner transfer list is empty");

  const started = await browser("/api/browser/v2/remote/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-openbot-browser": "1" },
    body: JSON.stringify({ hostId: "host-local" }),
  });
  expect(started.status, 201, "the browser starts a remote session");
  const sessionId = textField(await started.json(), "sessionId");

  const ticketResponse = await browser(`/api/browser/v2/remote/sessions/${encodeURIComponent(sessionId)}/ticket`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-openbot-browser": "1" },
    body: JSON.stringify({ clientPublicKey: devicePublicKey }),
  });
  expect(ticketResponse.status, 200, "the browser gets a session ticket");
  const ticket = await ticketResponse.json();
  check("the ticket has a signal URL", textField(ticket, "signalUrl").startsWith("ws://"));
  check("the ticket carries a token", textField(ticket, "ticket").length > 20);

  const secondSessionResponse = await call("/api/browser/session");
  const secondCookie = (secondSessionResponse.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  function secondBrowser(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("cookie", secondCookie);
    return call(path, { ...init, headers });
  }
  const secondStarted = await secondBrowser("/api/browser/v2/remote/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-openbot-browser": "1" },
    body: JSON.stringify({ hostId: "host-local" }),
  });
  const secondSessionId = textField(await secondStarted.json(), "sessionId");
  check("a second client gets its own remote session", secondSessionId !== sessionId);

  const sessions = await (await browser("/api/browser/v1/me/sessions")).json();
  const accountSessions = objectList(sessions, "sessions");
  check(
    "the account session list includes the browser session",
    accountSessions.some((item) => isDynamicRecord(item) && item.name === "Browser" && item.current === true),
  );

  const ended = await browser(`/api/browser/v2/remote/sessions/${encodeURIComponent(sessionId)}/end`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-openbot-browser": "1" },
    body: "{}",
  });
  expect(ended.status, 200, "the browser ends the remote session");

  const secondTicket = await secondBrowser(
    `/api/browser/v2/remote/sessions/${encodeURIComponent(secondSessionId)}/ticket`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-openbot-browser": "1" },
      body: JSON.stringify({ clientPublicKey: devicePublicKey }),
    },
  );
  expect(secondTicket.status, 200, "ending one session keeps another client connected");

  const profile = await browser("/api/browser/v1/me/profile", {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-openbot-browser": "1" },
    body: JSON.stringify({ name: "Local Owner" }),
  });
  expect(profile.status, 200, "the profile route answers");

  const hosting = await (await browser("/api/browser/v2/hosting/servers")).json();
  expect(booleanField(hosting, "available"), false, "hosted servers stay off in local mode");

  const stun = await startLocalStunServer({ host: "127.0.0.1", port: 3479 });
  try {
    const binding = await stunBinding("127.0.0.1", 3479);
    check("the local STUN server answers a binding request", binding.ok);
    expect(binding.address, "127.0.0.1", "the STUN reply mirrors the client address");
  } finally {
    await stun.close();
  }

  writeReport();
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  writeReport();
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

interface StunBindingResult {
  ok: boolean;
  address: string | null;
}

function stunBinding(host: string, port: number): Promise<StunBindingResult> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    const finish = (result: StunBindingResult): void => {
      socket.close();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, address: null }), 2000);
    socket.on("message", (message: Buffer) => {
      clearTimeout(timer);
      if (message.length < 32 || message.readUInt16BE(0) !== 0x0101) {
        finish({ ok: false, address: null });
        return;
      }
      const value = message.subarray(28, 32);
      const cookie = Buffer.from([0x21, 0x12, 0xa4, 0x42]);
      const address = [0, 1, 2, 3].map((index) => (value[index] ?? 0) ^ (cookie[index] ?? 0)).join(".");
      finish({ ok: true, address });
    });
    const request = Buffer.alloc(20);
    request.writeUInt16BE(0x0001, 0);
    request.writeUInt16BE(0, 2);
    request.writeUInt32BE(0x2112_a442, 4);
    socket.send(request, port, host);
  });
}

function writeReport(): void {
  const reportPath = join(process.cwd(), ".openbot-build", "local-web", "report.json");
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    `${JSON.stringify({ checks, failures, generatedAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

if (failures.length > 0) {
  process.stderr.write(`local web check failed: ${failures.join(", ")}\n`);
  process.exit(1);
}
process.stdout.write(`local web check passed: ${checks.length} checks\n`);
