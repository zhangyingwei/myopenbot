import { randomInt } from "node:crypto";
import type {
  AccountSession,
  MobileConnectedDevice,
  MobileConnectHostBinding,
  MobileDevicePlatform,
} from "@openbot/contracts/mobile-connect";
import { Effect } from "effect";
import type { LocalPairingConfig } from "./config";
import { fail, LocalPairingError } from "./errors";
import {
  type DesktopSession,
  hashToken,
  type LocalHost,
  type LocalUser,
  type MobileSession,
  type RemoteSessionRecord,
  randomIdentifier,
  randomToken,
  type State,
  type StateStore,
} from "./state";
import { PERSISTENT_SESSION_EXPIRES_AT, type TicketSigner } from "./tickets";

const CHALLENGE_TTL_MS = 10 * 60_000;
const RESEND_COOLDOWN_MS = 60_000;
const MOBILE_TICKET_TTL_MS = 2 * 60_000;
const MAX_CHALLENGE_ATTEMPTS = 5;
const HOST_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/u;
const OWNER_MEMBERSHIP_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface AccountUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  analyticsEnabled: boolean | null;
  chatColor: null;
}

export interface RegisteredHost {
  hostId: string;
  name: string;
  membershipId: string;
  authEpoch: number;
  machineToken: string | null;
}

export interface HostSummary {
  hostId: string;
  name: string;
  logoKey: null;
  devicePublicKey: string | null;
  keyHandovers: never[];
  authEpoch: number;
  membershipId: string;
  role: "owner";
  hosted: false;
}

export interface HostMember {
  membershipId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  chatColor: null;
  role: "owner";
  status: "active";
  createdAt: number;
}

export interface MobileDeviceIdentity {
  id: string;
  name: string;
  platform: MobileDevicePlatform;
}

export interface ResumeClaims {
  sessionId: string;
  hostId: string;
  userId: string;
  membershipId: string;
  role: "host" | "owner" | "admin" | "member";
  authEpoch: number;
  sessionExpiresAt: number;
}

export interface RegistrationInput {
  hostId: string;
  name: string;
  ownerMembershipId: string;
  devicePublicKey?: string | null | undefined;
  rotateCredential?: boolean | undefined;
  machineToken?: string | undefined;
  automatic?: boolean | undefined;
}

export interface AuthenticatedSession {
  user: AccountUser;
  kind: "desktop" | "mobile";
  sessionId: string;
  mobileHostId: string | null;
}

export class LocalPairingService {
  readonly #config: LocalPairingConfig;
  readonly #store: StateStore;
  readonly #signer: TicketSigner;

  constructor(config: LocalPairingConfig, store: StateStore, signer: TicketSigner) {
    this.#config = config;
    this.#store = store;
    this.#signer = signer;
  }

  readonly jwks = () => this.#signer.publicJwks();

  readonly startEmailSignIn = Effect.fn("LocalPairing.startEmailSignIn")(
    function* (this: LocalPairingService, input: string) {
      const email = normalizeEmail(input);
      if (!email) return yield* fail(400, "invalid_email", "Enter a valid email address.");
      const now = Date.now();
      const challengeId = randomIdentifier();
      const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
      const expiresAt = now + CHALLENGE_TTL_MS;
      const codeHash = hashToken(code);
      yield* this.#store.update((state) => {
        state.challenges.push({
          challengeId,
          email,
          codeHash,
          createdAt: now,
          expiresAt,
          consumedAt: null,
          attempts: 0,
        });
      });
      return {
        challengeId,
        expiresAt,
        resendAt: now + RESEND_COOLDOWN_MS,
        developmentCode: code,
      };
    },
    (operation) => operation,
  );

  readonly verifyEmailCode = Effect.fn("LocalPairing.verifyEmailCode")(
    function* (
      this: LocalPairingService,
      input: { challengeId: string; code: string; surface: "desktop" | "mobile"; device?: MobileDeviceIdentity },
    ) {
      const now = Date.now();
      const codeHash = hashToken(normalizeCode(input.code));
      const sessionToken = randomToken();
      const sessionId = randomIdentifier();
      const tokenHash = hashToken(sessionToken);
      const result = yield* this.#store.update((state) => {
        const user = stateUser(state);
        const challenge = state.challenges.find((item) => item.challengeId === input.challengeId);
        if (!challenge || challenge.consumedAt !== null || challenge.expiresAt <= now) {
          return { kind: "invalid" as const };
        }
        if (challenge.attempts >= MAX_CHALLENGE_ATTEMPTS) return { kind: "attempts" as const };
        if (challenge.codeHash !== codeHash) {
          challenge.attempts += 1;
          return { kind: challenge.attempts >= MAX_CHALLENGE_ATTEMPTS ? ("attempts" as const) : ("invalid" as const) };
        }
        challenge.consumedAt = now;
        if (input.surface === "desktop") {
          state.desktopSessions.push({
            sessionId,
            name: "Desktop",
            tokenHash,
            connectedAt: now,
            lastActiveAt: now,
            revokedAt: null,
          });
        } else {
          const device = input.device;
          state.mobileSessions.push({
            sessionId,
            name: device?.name ?? "Mobile",
            platform: device?.platform ?? "unknown",
            tokenHash,
            hostId: null,
            fingerprint: null,
            via: "code",
            connectedAt: now,
            lastActiveAt: now,
            revokedAt: null,
            expiresAt: PERSISTENT_SESSION_EXPIRES_AT,
          });
        }
        return { kind: "verified" as const, user: userView(user) };
      });
      if (result.kind === "attempts") {
        return yield* fail(429, "too_many_code_attempts", "Too many incorrect codes. Request a new code.");
      }
      if (result.kind === "invalid") {
        return yield* fail(400, "invalid_sign_in_code", "The sign-in code is invalid or expired.");
      }
      return { sessionToken, user: result.user };
    },
    (operation) => operation,
  );

  readonly authenticate = Effect.fn("LocalPairing.authenticate")(
    function* (this: LocalPairingService, token: string) {
      const tokenHash = hashToken(token);
      const now = Date.now();
      const result = yield* this.#store.update((state) => {
        const user = stateUser(state);
        const desktop = activeDesktopSession(state, tokenHash);
        if (desktop) {
          desktop.lastActiveAt = now;
          return { user: userView(user), kind: "desktop" as const, sessionId: desktop.sessionId, mobileHostId: null };
        }
        const mobile = activeMobileSession(state, tokenHash);
        if (mobile) {
          mobile.lastActiveAt = now;
          return {
            user: userView(user),
            kind: "mobile" as const,
            sessionId: mobile.sessionId,
            mobileHostId: mobile.hostId,
          };
        }
        return null;
      });
      if (!result) return yield* fail(401, "unauthorized", "The session is invalid.");
      return result;
    },
    (operation) => operation,
  );

  readonly authenticateDesktop = Effect.fn("LocalPairing.authenticateDesktop")(
    function* (this: LocalPairingService, token: string) {
      const tokenHash = hashToken(token);
      const now = Date.now();
      const result = yield* this.#store.update((state) => {
        const user = stateUser(state);
        const session = activeDesktopSession(state, tokenHash);
        if (!session) return null;
        session.lastActiveAt = now;
        return { user: userView(user), sessionId: session.sessionId };
      });
      if (!result) return yield* fail(401, "unauthorized", "A desktop session is required.");
      return result;
    },
    (operation) => operation,
  );

  readonly authenticateMobile = Effect.fn("LocalPairing.authenticateMobile")(
    function* (this: LocalPairingService, token: string) {
      const tokenHash = hashToken(token);
      const now = Date.now();
      const result = yield* this.#store.update((state) => {
        const user = stateUser(state);
        const session = activeMobileSession(state, tokenHash);
        if (!session) return null;
        session.lastActiveAt = now;
        return { user: userView(user), sessionId: session.sessionId };
      });
      if (!result) return yield* fail(401, "unauthorized", "The mobile session is invalid.");
      return result;
    },
    (operation) => operation,
  );

  readonly openBrowserSession = Effect.fn("LocalPairing.openBrowserSession")(
    function* (this: LocalPairingService) {
      const now = Date.now();
      const sessionId = randomIdentifier();
      const sessionToken = randomToken();
      const user = yield* this.#store.update((state) => {
        state.desktopSessions.push({
          sessionId,
          name: "Browser",
          tokenHash: hashToken(sessionToken),
          connectedAt: now,
          lastActiveAt: now,
          revokedAt: null,
        });
        return userView(stateUser(state));
      });
      return { sessionToken, sessionId, user };
    },
    (operation) => operation,
  );

  readonly logout = Effect.fn("LocalPairing.logout")(
    function* (this: LocalPairingService, token: string) {
      const tokenHash = hashToken(token);
      const now = Date.now();
      yield* this.#store.update((state) => {
        const session = activeDesktopSession(state, tokenHash);
        if (session) session.revokedAt = now;
      });
    },
    (operation) => operation,
  );

  readonly logoutMobile = Effect.fn("LocalPairing.logoutMobile")(
    function* (this: LocalPairingService, token: string) {
      const tokenHash = hashToken(token);
      const now = Date.now();
      const revoked = yield* this.#store.update((state) => {
        const session = activeMobileSession(state, tokenHash);
        if (!session) return false;
        session.revokedAt = now;
        return true;
      });
      if (!revoked) return yield* fail(401, "unauthorized", "The mobile session is invalid.");
    },
    (operation) => operation,
  );

  readonly registerHost = Effect.fn("LocalPairing.registerHost")(
    function* (this: LocalPairingService, userId: string, input: RegistrationInput) {
      if (!HOST_ID_PATTERN.test(input.hostId)) {
        return yield* fail(400, "invalid_remote_request", "The host ID is invalid.");
      }
      const name = normalizeText(input.name, 120);
      if (!name) return yield* fail(400, "invalid_remote_request", "The host name is invalid.");
      if (!OWNER_MEMBERSHIP_PATTERN.test(input.ownerMembershipId)) {
        return yield* fail(400, "invalid_remote_request", "The owner membership ID is invalid.");
      }
      const devicePublicKey =
        input.devicePublicKey === undefined || input.devicePublicKey === null || input.devicePublicKey === ""
          ? null
          : input.devicePublicKey;
      if (devicePublicKey !== null && devicePublicKey.length > 8_192) {
        return yield* fail(400, "invalid_remote_request", "The host public key is invalid.");
      }
      const providedHash = input.machineToken ? hashToken(input.machineToken) : null;
      const now = Date.now();
      const machineToken = randomToken();
      const result = yield* this.#store.update((state) => {
        const existing = state.host;
        if (existing && existing.hostId !== input.hostId) {
          return { kind: "other-host" as const };
        }
        if (existing && existing.ownerUserId !== userId) {
          return { kind: "owner-mismatch" as const };
        }
        const rotate =
          !existing?.machineTokenHash ||
          input.rotateCredential !== false ||
          existing.devicePublicKey !== devicePublicKey ||
          existing.machineTokenHash !== providedHash;
        if (!rotate && existing) {
          existing.name = name;
          existing.devicePublicKey = devicePublicKey;
          existing.updatedAt = now;
          return {
            kind: "kept" as const,
            host: {
              hostId: existing.hostId,
              name,
              membershipId: existing.membershipId,
              authEpoch: existing.authEpoch,
              machineToken: null,
            },
          };
        }
        const host: LocalHost = {
          hostId: input.hostId,
          ownerUserId: userId,
          name,
          devicePublicKey,
          machineTokenHash: hashToken(machineToken),
          membershipId: existing?.membershipId ?? input.ownerMembershipId,
          authEpoch: (existing?.authEpoch ?? 0) + 1,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        state.host = host;
        return {
          kind: "rotated" as const,
          host: {
            hostId: host.hostId,
            name,
            membershipId: host.membershipId,
            authEpoch: host.authEpoch,
            machineToken,
          },
        };
      });
      if (result.kind === "other-host") {
        return yield* fail(409, "host_limit", "This local service supports one host.");
      }
      if (result.kind === "owner-mismatch") {
        return yield* fail(403, "host_owner_mismatch", "This host belongs to another account.");
      }
      return result.host;
    },
    (operation) => operation,
  );

  readonly listHosts = Effect.fn("LocalPairing.listHosts")(
    function* (this: LocalPairingService, userId: string) {
      return yield* Effect.sync(() => {
        const state = this.#store.snapshot();
        const host = state.host;
        if (!host || host.ownerUserId !== userId) return { hosts: [] };
        return { hosts: [hostSummary(host)] };
      });
    },
    (operation) => operation,
  );

  readonly getHost = Effect.fn("LocalPairing.getHost")(
    function* (this: LocalPairingService, userId: string, hostId: string) {
      const state = this.#store.snapshot();
      const host = state.host;
      if (!host || host.hostId !== hostId || host.ownerUserId !== userId) {
        return yield* fail(404, "host_not_found", "The host was not found.");
      }
      return hostSummary(host);
    },
    (operation) => operation,
  );

  readonly listMembers = Effect.fn("LocalPairing.listMembers")(
    function* (this: LocalPairingService, userId: string, hostId: string) {
      const state = this.#store.snapshot();
      const host = state.host;
      if (!host || host.hostId !== hostId || host.ownerUserId !== userId) {
        return yield* fail(404, "host_not_found", "The host was not found.");
      }
      const user = stateUser(state);
      return {
        members: [
          {
            membershipId: host.membershipId,
            email: user.email,
            name: user.name,
            avatarUrl: user.avatarUrl,
            chatColor: null,
            role: "owner" as const,
            status: "active" as const,
            createdAt: host.createdAt,
          },
        ],
      };
    },
    (operation) => operation,
  );

  readonly issueHostTicket = Effect.fn("LocalPairing.issueHostTicket")(
    function* (this: LocalPairingService, hostId: string, machineToken: string) {
      const state = this.#store.snapshot();
      const host = state.host;
      if (!host || host.hostId !== hostId || !safeEqual(host.machineTokenHash, hashToken(machineToken))) {
        return yield* fail(401, "host_unauthorized", "The host credential is invalid.");
      }
      const issued = yield* this.#sign(host.hostId, host.ownerUserId, `${host.hostId}:host`, "host", host.authEpoch, {
        sessionId: `host-${host.hostId}`,
        sessionExpiresAt: PERSISTENT_SESSION_EXPIRES_AT,
      });
      return { ...issued, signalUrl: this.#config.publicSignalUrl };
    },
    (operation) => operation,
  );

  readonly createMobileTicket = Effect.fn("LocalPairing.createMobileTicket")(
    function* (this: LocalPairingService, userId: string, binding: MobileConnectHostBinding) {
      const now = Date.now();
      const ticket = randomToken();
      const expiresAt = now + MOBILE_TICKET_TTL_MS;
      const result = yield* this.#store.update((state) => {
        const host = validatedHostBinding(state, userId, binding);
        if (!host) return false;
        for (const existing of state.mobileTickets) {
          if (existing.userId === userId && existing.hostId === binding.hostId && existing.consumedAt === null) {
            existing.consumedAt = now;
          }
        }
        state.mobileTickets.push({
          ticketHash: hashToken(ticket),
          userId,
          hostId: binding.hostId,
          fingerprint: binding.fingerprint,
          createdAt: now,
          expiresAt,
          consumedAt: null,
        });
        return true;
      });
      if (!result) return yield* fail(409, "mobile_host_mismatch", "The Mobile Connect host identity does not match.");
      return { ticket, expiresAt };
    },
    (operation) => operation,
  );

  readonly cancelMobileTickets = Effect.fn("LocalPairing.cancelMobileTickets")(
    function* (this: LocalPairingService, userId: string, hostId: string) {
      if (!HOST_ID_PATTERN.test(hostId)) {
        return yield* fail(400, "invalid_mobile_host", "The Mobile Connect host ID is invalid.");
      }
      const now = Date.now();
      yield* this.#store.update((state) => {
        for (const ticket of state.mobileTickets) {
          if (ticket.userId === userId && ticket.hostId === hostId && ticket.consumedAt === null) {
            ticket.consumedAt = now;
          }
        }
      });
    },
    (operation) => operation,
  );

  readonly createLink = Effect.fn("LocalPairing.createLink")(
    function* (this: LocalPairingService, userId: string, binding: MobileConnectHostBinding) {
      const now = Date.now();
      const link = randomToken();
      const result = yield* this.#store.update((state) => {
        const host = validatedHostBinding(state, userId, binding);
        if (!host) return false;
        for (const existing of state.mobileLinks) {
          if (existing.userId === userId && existing.hostId === binding.hostId && existing.revokedAt === null) {
            existing.revokedAt = now;
          }
        }
        state.mobileLinks.push({
          linkHash: hashToken(link),
          userId,
          hostId: binding.hostId,
          fingerprint: binding.fingerprint,
          createdAt: now,
          revokedAt: null,
        });
        return true;
      });
      if (!result) return yield* fail(409, "mobile_host_mismatch", "The Mobile Connect host identity does not match.");
      return { link, createdAt: now };
    },
    (operation) => operation,
  );

  readonly revokeLink = Effect.fn("LocalPairing.revokeLink")(
    function* (this: LocalPairingService, userId: string, hostId: string) {
      if (!HOST_ID_PATTERN.test(hostId)) {
        return yield* fail(400, "invalid_mobile_host", "The Mobile Connect host ID is invalid.");
      }
      const now = Date.now();
      yield* this.#store.update((state) => {
        for (const link of state.mobileLinks) {
          if (link.userId === userId && link.hostId === hostId && link.revokedAt === null) {
            link.revokedAt = now;
          }
        }
      });
    },
    (operation) => operation,
  );

  readonly redeemMobileTicket = Effect.fn("LocalPairing.redeemMobileTicket")(
    function* (this: LocalPairingService, ticket: string, device: MobileDeviceIdentity) {
      if (!ticket || ticket.length > 128) return null;
      const now = Date.now();
      const sessionToken = randomToken();
      const sessionId = randomIdentifier();
      const tokenHash = hashToken(ticket);
      const result = yield* this.#store.update((state) => {
        const user = stateUser(state);
        const mobileTicket = state.mobileTickets.find(
          (item) => item.ticketHash === tokenHash && item.consumedAt === null && item.expiresAt > now,
        );
        const link = mobileTicket
          ? null
          : state.mobileLinks.find((item) => item.linkHash === tokenHash && item.revokedAt === null);
        const source = mobileTicket ?? link;
        if (!source) return null;
        if (mobileTicket) mobileTicket.consumedAt = now;
        state.mobileSessions.push({
          sessionId,
          name: device.name,
          platform: device.platform,
          tokenHash: hashToken(sessionToken),
          hostId: source.hostId,
          fingerprint: source.fingerprint,
          via: mobileTicket ? "code" : "link",
          connectedAt: now,
          lastActiveAt: now,
          revokedAt: null,
          expiresAt: PERSISTENT_SESSION_EXPIRES_AT,
        });
        return {
          sessionToken,
          user: userView(user),
          host: { hostId: source.hostId, fingerprint: source.fingerprint },
        };
      });
      return result;
    },
    (operation) => operation,
  );

  readonly listMobileDevices = Effect.fn("LocalPairing.listMobileDevices")(
    function* (this: LocalPairingService, token: string, hostId: string | null) {
      if (hostId !== null && !HOST_ID_PATTERN.test(hostId)) {
        return yield* fail(400, "invalid_mobile_host", "The Mobile Connect host ID is invalid.");
      }
      yield* this.authenticate(token);
      const state = this.#store.snapshot();
      const now = Date.now();
      const devices: MobileConnectedDevice[] = state.mobileSessions
        .filter(
          (item) => item.revokedAt === null && (hostId === null || item.hostId === hostId) && item.expiresAt > now,
        )
        .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
        .map((item) => ({
          sessionId: item.sessionId,
          name: item.name,
          platform: item.platform,
          connectedAt: item.connectedAt,
          lastActiveAt: item.lastActiveAt,
          via: item.via,
        }));
      return devices;
    },
    (operation) => operation,
  );

  readonly listAccountSessions = Effect.fn("LocalPairing.listAccountSessions")(
    function* (this: LocalPairingService, token: string) {
      const current = yield* this.authenticate(token);
      const state = this.#store.snapshot();
      const now = Date.now();
      const sessions: AccountSession[] = [
        ...state.desktopSessions
          .filter((item) => item.revokedAt === null)
          .map((item) => ({
            sessionId: item.sessionId,
            name: item.name,
            kind: "desktop" as const,
            current: item.sessionId === current.sessionId,
            connectedAt: item.connectedAt,
            lastActiveAt: item.lastActiveAt,
            hostedServer: false,
          })),
        ...state.mobileSessions
          .filter((item) => item.revokedAt === null && item.expiresAt > now)
          .map((item) => ({
            sessionId: item.sessionId,
            name: item.name,
            kind: "mobile" as const,
            current: item.sessionId === current.sessionId,
            connectedAt: item.connectedAt,
            lastActiveAt: item.lastActiveAt,
            hostedServer: false,
          })),
      ];
      return sessions.sort((left, right) => right.lastActiveAt - left.lastActiveAt);
    },
    (operation) => operation,
  );

  readonly revokeSession = Effect.fn("LocalPairing.revokeSession")(
    function* (this: LocalPairingService, token: string, sessionId: string, includeDesktop: boolean) {
      if (!UUID_V4_PATTERN.test(sessionId)) {
        return yield* fail(400, "invalid_session", "The session ID is invalid.");
      }
      const current = yield* this.authenticate(token);
      const now = Date.now();
      const result = yield* this.#store.update((state) => {
        if (includeDesktop) {
          const desktop = state.desktopSessions.find((item) => item.sessionId === sessionId);
          if (desktop) {
            if (current.kind === "mobile") return { kind: "protected" as const };
            desktop.revokedAt = now;
            return { kind: "ok" as const };
          }
        }
        const mobile = state.mobileSessions.find((item) => item.sessionId === sessionId);
        if (mobile) {
          mobile.revokedAt = now;
          return { kind: "ok" as const };
        }
        return { kind: "ok" as const };
      });
      if (result.kind === "protected") {
        return yield* fail(403, "desktop_session_protected", "Desktop sessions cannot be disconnected from mobile.");
      }
    },
    (operation) => operation,
  );

  readonly startSession = Effect.fn("LocalPairing.startSession")(
    function* (this: LocalPairingService, userId: string, hostId: string, authSessionHash: string) {
      const now = Date.now();
      const result = yield* this.#store.update((state) => {
        const host = state.host;
        if (!host || host.hostId !== hostId || host.ownerUserId !== userId) return { kind: "host" as const };
        if (!hasActiveAuthSession(state, authSessionHash)) return { kind: "auth" as const };
        const active = state.remoteSessions.find(
          (item) =>
            item.hostId === hostId &&
            item.userId === userId &&
            item.authSessionHash === authSessionHash &&
            item.endedAt === null &&
            item.expiresAt > now &&
            hasActiveAuthSession(state, item.authSessionHash),
        );
        if (active) {
          return {
            kind: "ok" as const,
            session: { sessionId: active.sessionId, hostId, expiresAt: active.expiresAt },
          };
        }
        const session: RemoteSessionRecord = {
          sessionId: randomIdentifier(),
          hostId,
          userId,
          membershipId: host.membershipId,
          role: "owner",
          authEpoch: host.authEpoch,
          authSessionHash,
          startedAt: now,
          expiresAt: PERSISTENT_SESSION_EXPIRES_AT,
          endedAt: null,
        };
        state.remoteSessions.push(session);
        return {
          kind: "ok" as const,
          session: { sessionId: session.sessionId, hostId, expiresAt: session.expiresAt },
        };
      });
      if (result.kind === "host") return yield* fail(404, "host_not_found", "The host was not found.");
      if (result.kind === "auth") {
        return yield* fail(401, "auth_session_revoked", "The account session has ended.");
      }
      return result.session;
    },
    (operation) => operation,
  );

  readonly issueSessionTicket = Effect.fn("LocalPairing.issueSessionTicket")(
    function* (this: LocalPairingService, userId: string, sessionId: string, clientPublicKey: string) {
      if (!clientPublicKey || clientPublicKey.length > 8_192) {
        return yield* fail(400, "invalid_remote_request", "The client public key is required.");
      }
      const state = this.#store.snapshot();
      const now = Date.now();
      const session = state.remoteSessions.find((item) => item.sessionId === sessionId && item.userId === userId);
      if (
        !session ||
        session.endedAt !== null ||
        session.expiresAt <= now ||
        (session.authSessionHash !== null && !hasActiveAuthSession(state, session.authSessionHash))
      ) {
        return yield* fail(403, "session_inactive", "The remote session is not active.");
      }
      const host = state.host;
      if (!host || host.hostId !== session.hostId) {
        return yield* fail(403, "session_inactive", "The remote session is not active.");
      }
      const issued = yield* this.#sign(session.hostId, userId, session.membershipId, session.role, host.authEpoch, {
        sessionId: session.sessionId,
        sessionExpiresAt: session.expiresAt,
        clientPublicKey,
      });
      return { ...issued, signalUrl: this.#config.publicSignalUrl };
    },
    (operation) => operation,
  );

  readonly endSession = Effect.fn("LocalPairing.endSession")(
    function* (this: LocalPairingService, userId: string, sessionId: string) {
      const now = Date.now();
      const ended = yield* this.#store.update((state) => {
        const session = state.remoteSessions.find((item) => item.sessionId === sessionId && item.userId === userId);
        if (!session) return false;
        if (session.endedAt === null) session.endedAt = now;
        return true;
      });
      if (!ended) return yield* fail(404, "session_not_found", "The remote session was not found.");
    },
    (operation) => operation,
  );

  readonly validateResume = Effect.fn("LocalPairing.validateResume")(
    function* (this: LocalPairingService, claims: ResumeClaims) {
      const now = Date.now();
      if (claims.sessionExpiresAt * 1_000 <= now || !Number.isSafeInteger(claims.authEpoch)) return false;
      const state = this.#store.snapshot();
      const host = state.host;
      if (!host || host.hostId !== claims.hostId) return false;
      if (claims.role === "host") {
        return (
          claims.sessionId === `host-${host.hostId}` &&
          claims.userId === host.ownerUserId &&
          claims.membershipId === `${host.hostId}:host` &&
          claims.authEpoch === host.authEpoch
        );
      }
      const session = state.remoteSessions.find((item) => item.sessionId === claims.sessionId);
      if (
        !session ||
        session.endedAt !== null ||
        session.expiresAt <= now ||
        session.hostId !== claims.hostId ||
        session.userId !== claims.userId ||
        session.membershipId !== claims.membershipId ||
        session.role !== claims.role ||
        host.authEpoch !== claims.authEpoch ||
        Math.floor(session.expiresAt / 1_000) !== claims.sessionExpiresAt
      ) {
        return false;
      }
      return session.authSessionHash === null || hasActiveAuthSession(state, session.authSessionHash);
    },
    (operation) => operation,
  );

  #sign(
    hostId: string,
    userId: string,
    membershipId: string,
    role: "host" | "owner" | "admin" | "member",
    authEpoch: number,
    input: { sessionId: string; sessionExpiresAt: number; clientPublicKey?: string },
  ): Effect.Effect<{ ticket: string; expiresAt: number }, LocalPairingError> {
    return Effect.tryPromise({
      try: () =>
        this.#signer.issue({
          sessionId: input.sessionId,
          hostId,
          userId,
          membershipId,
          role,
          authEpoch,
          sessionExpiresAt: input.sessionExpiresAt,
          ...(input.clientPublicKey ? { clientPublicKey: input.clientPublicKey } : {}),
        }),
      catch: () => new LocalPairingError(500, "ticket_signing_failed", "The local pairing ticket could not be signed."),
    });
  }
}

function stateUser(state: State): LocalUser {
  if (!state.user) throw new LocalPairingError(500, "user_missing", "The local pairing user is not initialized.");
  return state.user;
}

function userView(user: LocalUser): AccountUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    analyticsEnabled: user.analyticsEnabled,
    chatColor: null,
  };
}

function hostSummary(host: LocalHost): HostSummary {
  return {
    hostId: host.hostId,
    name: host.name,
    logoKey: null,
    devicePublicKey: host.devicePublicKey,
    keyHandovers: [],
    authEpoch: host.authEpoch,
    membershipId: host.membershipId,
    role: "owner",
    hosted: false,
  };
}

function activeDesktopSession(state: State, tokenHash: string): DesktopSession | undefined {
  return state.desktopSessions.find((item) => item.tokenHash === tokenHash && item.revokedAt === null);
}

function activeMobileSession(state: State, tokenHash: string): MobileSession | undefined {
  return state.mobileSessions.find(
    (item) => item.tokenHash === tokenHash && item.revokedAt === null && item.expiresAt > Date.now(),
  );
}

function hasActiveAuthSession(state: State, tokenHash: string | null): boolean {
  if (!tokenHash) return false;
  return Boolean(activeDesktopSession(state, tokenHash) ?? activeMobileSession(state, tokenHash));
}

function validatedHostBinding(state: State, userId: string, binding: MobileConnectHostBinding): LocalHost | null {
  const host = state.host;
  if (
    !host ||
    host.hostId !== binding.hostId ||
    host.ownerUserId !== userId ||
    !host.devicePublicKey ||
    hostFingerprintOf(host.devicePublicKey) !== binding.fingerprint
  ) {
    return null;
  }
  return host;
}

function hostFingerprintOf(devicePublicKey: string): string {
  return hashToken(devicePublicKey);
}

function normalizeEmail(value: string): string | null {
  const email = value.normalize("NFC").trim().toLowerCase();
  if (!email || email.length > 254 || !email.includes("@") || /\s/u.test(email)) return null;
  return email;
}

function normalizeCode(value: string): string {
  return value.replace(/\D/gu, "");
}

function normalizeText(value: string, maximum: number): string | null {
  const text = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!text || text.length > maximum || /[\p{Cc}\p{Cf}]/u.test(text)) return null;
  return text;
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
