import { type ChildProcess, spawn } from "node:child_process";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import type { CentralAuthState } from "@openbot/contracts/ipc";
import { createLocalPairingRuntime } from "@openbot/local-pairing";
import { closeLocalPairingServer, startLocalPairingServer } from "@openbot/local-pairing/node";
import type { Logger } from "@openbot/logging";
import { Effect } from "effect";
import { app } from "electron";
import type { CentralAuthManager } from "./central-auth-manager";
import { applyLocalModeEnvironment, type LocalModeConfig, localPairingConfig } from "./local-mode";
import type { RemoteWorkflowError } from "./remote-service-effects";
import type { TeamStore } from "./team-store";

export interface LocalServices {
  config: LocalModeConfig;
  stop(): Promise<void>;
}

export async function startLocalServices(config: LocalModeConfig, logger: Logger): Promise<LocalServices> {
  applyLocalModeEnvironment(config);
  const runtime = await createLocalPairingRuntime(localPairingConfig(config), logger);
  const report = (message: string, error: unknown) =>
    logger.error(message, error instanceof Error ? error.message : String(error));
  const servers: Server[] = [];
  if (config.host === "0.0.0.0") {
    servers.push(
      await startLocalPairingServer(runtime.handle, { host: "0.0.0.0", port: config.apiPort, onError: report }),
    );
  } else {
    servers.push(
      await startLocalPairingServer(runtime.handle, { host: "127.0.0.1", port: config.apiPort, onError: report }),
    );
    if (config.host !== "127.0.0.1") {
      servers.push(
        await startLocalPairingServer(runtime.handle, { host: config.host, port: config.apiPort, onError: report }),
      );
    }
  }
  let signal: ChildProcess | null = null;
  try {
    signal = await startSignal(config, runtime.service.jwks(), logger);
  } catch (error) {
    await Promise.all(servers.map(closeLocalPairingServer));
    throw error;
  }
  let stopping = false;
  return {
    config,
    async stop() {
      if (stopping) return;
      stopping = true;
      await Promise.all(servers.map(closeLocalPairingServer));
      if (signal && signal.exitCode === null) {
        signal.kill();
        await waitForExit(signal, 5_000);
        if (signal.exitCode === null) signal.kill("SIGKILL");
      }
    },
  };
}

export async function signInLocalAccount(options: {
  centralAuth: CentralAuthManager;
  teamStore: TeamStore;
  config: LocalModeConfig;
  initialization: Effect.Effect<CentralAuthState, RemoteWorkflowError>;
}): Promise<void> {
  const { centralAuth, teamStore, config, initialization } = options;
  const initialized = await Effect.runPromise(initialization).catch(() => null);
  if (initialized?.status === "signed_in" && initialized.user.id === config.userId) return;
  if (initialized?.status === "signed_in") await Effect.runPromise(centralAuth.logout());
  const challenge = await Effect.runPromise(centralAuth.requestEmailCode(config.email));
  if (challenge.status === "error") throw new Error(challenge.issue.message);
  if (challenge.status !== "code_sent" || !challenge.developmentCode) {
    throw new Error("The local account service did not return a sign-in code.");
  }
  const verified = await Effect.runPromise(
    centralAuth.verifyEmailCode(challenge.challengeId, challenge.developmentCode),
  );
  if (verified.status === "error") throw new Error(verified.issue.message);
  if (verified.status !== "signed_in") throw new Error("The local account sign-in did not finish.");
  await Effect.runPromise(teamStore.activateAccount(verified.user));
  if (!teamStore.configured) await Effect.runPromise(teamStore.configureWithAccount("OpenBot", verified.user));
}

async function startSignal(config: LocalModeConfig, publicJwks: unknown, logger: Logger): Promise<ChildProcess> {
  const packaged = app.isPackaged;
  const command = packaged
    ? join(process.resourcesPath, "signal", process.platform === "win32" ? "openbot-signal.exe" : "openbot-signal")
    : (config.bunPath ?? "bun");
  const args = packaged ? [] : [join(process.cwd(), "remote", "api", "src", "index.ts")];
  const cwd = packaged ? dirname(command) : process.cwd();
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "TURN_HOST",
    "TURN_SHARED_SECRET",
    "TURN_EXTRA_HOSTS",
    "REMOTE_TICKET_JWKS_URL",
    "REMOTE_TICKET_PUBLIC_KEYS",
    "DISCORD_BOT_TOKEN",
    "DISCORD_APPLICATION_ID",
    "TELEGRAM_BOT_TOKENS",
    "SLACK_SIGNING_SECRET",
    "GITHUB_WEBHOOK_SECRET",
    "SIGNAL_ENTRY_HOST",
    "SIGNAL_PUBLIC_IPV4",
    "REMOTE_METRICS_TOKEN",
  ]) {
    delete env[key];
  }
  Object.assign(env, {
    REMOTE_TICKET_PUBLIC_JWKS: JSON.stringify(publicJwks),
    REMOTE_TLS_DISABLED: "true",
    REMOTE_SIGNAL_HOST: config.host,
    REMOTE_SIGNAL_PORT: String(config.signalPort),
    REMOTE_HEALTH_HOST: "127.0.0.1",
    REMOTE_HEALTH_PORT: String(config.signalHealthPort),
    REMOTE_CONTROL_PLANE_URL: `http://127.0.0.1:${config.apiPort}`,
    REMOTE_SESSION_SECRET: config.sessionSecret,
    REMOTE_AUTH_WEBHOOK_SECRET: config.authWebhookSecret,
    REMOTE_TURN_DISABLED: "true",
    REMOTE_STUN_URL: config.stunUrl,
  });
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk: Buffer | string) => forwardLog(logger, "info", chunk));
  child.stderr?.on("data", (chunk: Buffer | string) => forwardLog(logger, "warn", chunk));
  if (!(await waitForHealth(`http://127.0.0.1:${config.signalHealthPort}/health/ready`, 30_000, child))) {
    child.kill();
    throw new Error("The local Signal did not start.");
  }
  return child;
}

async function waitForHealth(url: string, timeoutMs: number, child: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve();
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", onExit);
  });
}

function forwardLog(logger: Logger, level: "info" | "warn", chunk: Buffer | string): void {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    logger[level](`[local-signal] ${line.trim()}`);
  }
}
