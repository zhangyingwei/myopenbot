# Plan 013: Local intranet mode for the desktop host

> **Executor instructions**: Each stage below is one commit. Read the whole plan before you start.
> Run the drift check first. Respect the `STOP` conditions. This plan is for the developer's private
> fork. It is not an upstream change.
>
> **Drift check**: `git diff --stat ca7f191eb..HEAD -- src/main/central-auth-manager.ts
> src/main/team-store.ts src/main/account-service-access.ts src/main/application-services.ts
> remote/api/src/tokens.ts remote/api/src/config.ts packages/contracts/src/mobile-connect.ts
> apps/mobile/app.json`. If a file changed, compare the line references below with the live code.
> On a mismatch, STOP.

## State

- **Priority**: P1 for the fork
- **Planned at**: commit `ca7f191eb` (`main`, 2026-11-21)
- **Size**: M (about 1000-1500 new lines, most of them in a new service)
- **State**: IN PROGRESS
- **Constraint**: The phone app stays unchanged. No new store release.

## Request

The developer runs OpenBot on one Windows computer. A phone must reach that computer over an
EasyTier virtual private network. The developer wants no external account service and no relay.
Chats, agents and files stay on the Windows computer.

## Decisions

1. Keep the existing phone app. Keep WebRTC and the Team API wire protocol.
2. Do not run `apps/auth-api`, Cloudflare, D1 or SMTP. Keep the package in the tree for upstream
   merges. Do not delete it.
3. Replace the account service with a local pairing service. The service has one fixed user and one
   host. It speaks the account API subset that the desktop and the phone call.
4. Keep Signal (`remote/api`). Signal is signaling, not a relay. Run it locally on the EasyTier
   address.
5. Disable TURN. EasyTier provides a flat private network, so WebRTC uses host candidates.
6. The Windows desktop app is the host. No Linux server, no Docker, no hosted server.
7. The desktop app starts the local services. The user sees one application: `OpenBot.exe`.
8. The phone connects with the existing store app by scanning the Mobile Connect QR code.

## Why the phone can stay unchanged

- `isMobileConnectDevelopmentHost` accepts plain HTTP on `10/8`, `172.16/12` and `192.168/16`
  (`packages/contracts/src/mobile-connect.ts:127`). EasyTier uses a private IPv4 address.
- iOS allows local networking (`apps/mobile/app.json:18`, `NSAllowsLocalNetworking`).
- Android allows cleartext (`apps/mobile/app.json:125`, `usesCleartextTraffic`).
- `decodeRemoteSessionTicket` accepts `ws:` on the same private hosts
  (`packages/contracts/src/remote-control-plane.ts`).
- The hidden WebRTC page allows `ws:` (`src/renderer/team-webrtc.html:5`).

If any of these four checks fails on the installed phone build, STOP. Do not rebuild the phone.

## Target architecture

```text
Windows computer
  EasyTier (service)
  OpenBot.exe
    Electron main
      agents, SQLite, Team API, pairing HTTP server
      Signal child process (openbot-signal.exe)
    hidden Chromium page (RTCPeerConnection)

Phone
  EasyTier (VPN)
  OpenBot store app (unchanged)
```

No TURN. No Cloudflare. No D1. No SMTP. No Linux server.

## Stage 0: Prove the path with zero code

Use the existing development stack. This stage proves the network and the phone build. It does not
remove the account service.

1. Find the EasyTier IPv4 address of the Windows computer.
2. Start the local stack:

   ```sh
   OPENBOT_MOBILE_AUTH_API_URL=http://<easytier-ip>:3100 \
   REMOTE_SIGNAL_URL=ws://<easytier-ip>:3101/v1/signal \
   bun run dev
   ```

3. Open **Settings > Mobile Connect** and scan the QR code with the store app.
4. Send one message from the phone and read one answer.

Acceptance: the phone connects, lists agents, sends a message, and receives an answer.

If the phone cannot reach the ports, check the Windows firewall and the EasyTier route first. Do not
write code until this stage passes.

**Result (2026-11-21)**: passed. The store app connected over EasyTier to
`http://10.222.0.11:3100` and `ws://10.222.0.11:3101/v1/signal`. The phone reached Signal from
`10.222.0.100`, WebRTC used `host/udp -> prflx/udp` with no TURN, and a phone message received an
answer. The phone app and `packages/contracts` were unchanged.

## Stage 1: Local pairing service (MVP)

Create `apps/local-pairing/`. Use Bun and `Bun.serve`, or Elysia. Reuse `jose` and
`@openbot/contracts`. Do not import Electron.

### Endpoints

Required:

| Method | Path | Caller | Notes |
| --- | --- | --- | --- |
| POST | `/v1/auth/email/start` | desktop | Return `{ challengeId, expiresAt, developmentCode }` |
| POST | `/v1/auth/email/verify` | desktop | Return `{ sessionToken, user }` |
| GET | `/v1/me` | desktop | Return the fixed user |
| GET | `/.well-known/jwks.json` | desktop, Signal | Public ES256 JWKS |
| POST | `/v1/mobile-auth/ticket` | desktop | Return `{ ticket, expiresAt }` |
| POST | `/v1/mobile-auth/redeem` | phone | Return `{ sessionToken, user, host }` |
| GET | `/v1/mobile-auth/session` | phone | Return the fixed user |
| POST | `/v2/remote/hosts/register` | desktop | Return `{ hostId, name, membershipId, authEpoch, machineToken }` |
| GET | `/v2/remote/hosts/` | phone | Return `{ hosts: [...] }` |
| POST | `/v2/remote/hosts/:hostId/ticket` | desktop | Return `{ ticket, signalUrl, expiresAt }` |
| POST | `/v2/remote/sessions/` | phone | Return `{ sessionId, hostId, expiresAt }` |
| POST | `/v2/remote/sessions/:sessionId/ticket` | phone | Return `{ ticket, signalUrl, expiresAt }` |
| POST | `/v2/remote/resume/validate` | Signal | Return `{ valid: true }` for an active session |

Recommended:

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/v1/mobile/features` | `{ features: {}, latestVersion: null, minimumVersion: null }` |
| GET | `/v1/mobile-auth/devices` | Empty list |
| DELETE | `/v1/mobile-auth/devices/:id` | 204 |
| POST | `/v1/auth/logout` | 204 |
| GET | `/v2/remote/hosts/:hostId` | Host summary |
| GET | `/v2/remote/hosts/:hostId/members` | One owner member |
| POST | `/v2/remote/sessions/:sessionId/end` | 204 |
| GET | `/v1/me/analytics` | Empty success |
| GET | `/health/live` | `{ status: "ok" }` |

Response shapes must match the desktop decoders in `src/main/central-auth-records.ts`. Read them
before you write an endpoint.

### Tickets

Copy the signing code from `apps/auth-api/src/server/remote-control-plane.ts:368`
(`RemoteTicketSigner.issue`):

- ES256, `kid`, `aud: "openbot-remote"`, `jti`, `iat`, `exp`.
- Host ticket: `sessionId: "host-<hostId>"`, `role: "host"`,
  `membershipId: "<hostId>:host"`, far-future `sessionExpiresAt`.
- Phone ticket: `role` is `owner`, `admin` or `member`; include `clientPublicKey`.
- Ticket lifetime: 180 seconds. The desktop and the phone renew through the ticket endpoints.
- `signalUrl` is `ws://<easytier-ip>:<signal-port>/v1/signal`.

### State

One JSON file in the user data folder, for example `local-pairing.json`:

- fixed user (`id`, `email`, `name`);
- host (`hostId`, `name`, `devicePublicKey`, `machineToken`, `authEpoch`, `membershipId`);
- phone session tokens;
- unused QR tickets with an expiry.

Write the file atomically. Do not add a database.

### Configuration

Read from a file in the user data folder, and allow environment overrides:

- `bindAddress` (EasyTier address);
- `apiPort` (default 3100);
- `signalPort` (default 3101);
- `publicApiUrl` (the value in the QR);
- `publicSignalUrl`;
- fixed user id, email and name.

Bind only the EasyTier address when possible. If the desktop must use `127.0.0.1`
(`readCentralAuthApiUrl` allows only loopback or HTTPS), start two listeners or change that validator
in Stage 3.

### Acceptance

- `curl` can complete the desktop login, host registration, host ticket, QR ticket, phone redeem,
  directory, session and session-ticket calls.
- The host ticket verifies with the public JWKS.
- Restart the service and the stored host and sessions survive.

**Result (2026-11-21)**: passed on Windows. `apps/local-pairing` speaks the desktop and phone
contract on `node:http`, so Stage 3 can embed it in Electron. TypeScript and the repository Biome
check passed, and a scripted check on Windows completed every required and recommended endpoint. The
host ticket verified against `/.well-known/jwks.json`. A restart kept the host, phone session,
machine token and signing key.

## Stage 2: Local Signal without TURN

Change `remote/api`:

1. `remote/api/src/config.ts`: read `REMOTE_TURN_DISABLED`. When it is `true`, do not require
   `TURN_HOST` or `TURN_SHARED_SECRET`.
2. `remote/api/src/tokens.ts:481`: `iceServers()` returns one `stun:` entry when TURN is
   disabled, and no `turn:` or `turns:` URL. The unchanged store app rejects an empty list with
   `error.app.iceServersMissing`.

Run Signal with:

```sh
REMOTE_TLS_DISABLED=true
REMOTE_SIGNAL_HOST=<easytier-ip>
REMOTE_SIGNAL_PORT=3101
REMOTE_HEALTH_HOST=127.0.0.1
REMOTE_HEALTH_PORT=3102
REMOTE_TICKET_PUBLIC_JWKS=<public jwks>
REMOTE_CONTROL_PLANE_URL=http://127.0.0.1:3100
REMOTE_SESSION_SECRET=<random>
REMOTE_AUTH_WEBHOOK_SECRET=<random>
REMOTE_TURN_DISABLED=true
```

Acceptance: the desktop pairs with a phone over EasyTier, and `/health/ready` returns 200. A packet
capture or the Signal metrics show no TURN traffic.

**Result (2026-11-22)**: passed on Windows. Signal started with
`REMOTE_TURN_DISABLED=true` and without `TURN_HOST` or `TURN_SHARED_SECRET`, bound to
`10.222.0.11:3111`, and `/health/ready` returned 200. The first version returned an empty
`iceServers` list; the unchanged store app rejected it with `error.app.iceServersMissing`. The
disabled path now returns one `stun:` entry and no TURN URL. The phone connected over EasyTier host
candidates, messages were answered, and no process listens on 3478 or 5349.

## Stage 3: Desktop wiring

### Stage 3a: configuration only

Run the packaged app with:

```sh
OPENBOT_AUTH_API_URL=http://127.0.0.1:3100
OPENBOT_MOBILE_AUTH_API_URL=http://<easytier-ip>:3100
```

The QR code uses `OPENBOT_MOBILE_AUTH_API_URL` (`src/main/account-service-access.ts:59`).

Owner check: `TeamStore.assertOwnerAccount` (`src/main/team-store.ts:399`) requires the fixed user
id to equal the existing owner `accountId` when one exists. Use one of these:

1. a fresh OpenBot profile and host (preferred);
2. set the pairing service user id to the existing owner `accountId`;
3. add a local-mode branch to `assertOwnerAccount`.

### Stage 3b: start and stop the local services

Add `src/main/local-services.ts`:

- resolve the EasyTier address from configuration, not from interface order;
- start Signal as a child process from `process.resourcesPath/signal/openbot-signal.exe`;
- wait for `http://127.0.0.1:<health-port>/health/ready`;
- stop Signal on teardown with a graceful signal and a timeout;
- expose status and the public URLs to the Mobile Connect UI.

Wire it in `src/main/application-services.ts` and register the stop step in
`src/main/teardown-registry.ts`. Keep the existing teardown order.

Embed the pairing HTTP server in the Electron main process. Use `node:http`, `jose` and the existing
user data folder. Do not add a second Electron process.

Change the default account URL in `src/main/account-service-access.ts:47` only when local mode is
enabled. Keep the upstream default otherwise.

If the pairing server binds only the EasyTier address, update
`src/main/central-auth-manager.ts:2519` to accept a private HTTP origin for local mode.

### Acceptance

- Start `OpenBot.exe`. The pairing server and Signal start automatically.
- The Mobile Connect QR code contains the EasyTier URL.
- Stop the app. Both child processes exit.
- Start the app again. The phone reconnects without a new QR scan.

**Result (2026-11-22, Stage 3a)**: the configuration-only path passed on Windows. A standalone
pairing service on `0.0.0.0:3200` and a local Signal on `10.222.0.11:3111` served a fresh dev
profile. The desktop signed in automatically, registered host `14d33a27-f31d-4378-a87c-f62ab7f5b8c0`
at auth epoch 1, and connected to the Signal. The phone redeemed the QR at
`http://10.222.0.11:3200`, connected, and received an answer.

**Result (2026-11-22, Stage 3b)**: the embedded manager passed on Windows. The Electron main process
starts the pairing server on `127.0.0.1:3200` and `10.222.0.11:3200`, starts Signal as a child
process on `10.222.0.11:3111`, signs in as the fixed `local-owner`, starts the host, and stops both
services on exit. `bun run dev` starts only the app in local mode. The desktop settings page loads,
the host reports `online`, and the phone reconnects from `10.222.0.100` without a new QR scan.

Two fixes were needed:

- the renderer CSP is built before the application services, so local mode applies
  `REMOTE_SIGNAL_URL` in `src/main/index.ts` before the CSP, and
  `src/main/content-security-policy.ts` accepts the private Signal origin;
- the server settings error toast called `onCleanup` inside a ref callback, which halted the Solid
  reactive system and left the page blank. It now owns its `ResizeObserver` from a `createEffect`.

The pairing service also answers `GET /v2/hosting/servers/`,
`GET /v2/remote/hosts/:id/invites` and `GET /v2/remote/owner-transfers/` so the desktop does not
show load errors.

The marketplace needs public catalog reads. The service proxies `GET /v1/marketplace/` and
`GET /v1/skills/` to `https://api.openbot.run` with no local token, a fixed upstream origin and a
path allow list, and returns empty lists for the `/mine` paths. The renderer CSP also allows the
local API origin so marketplace images load in a packaged local build. `POST
/v1/github/installation-tokens` returns an empty installation list and does not validate the GitHub
token; the GitHub connector then uses the signed-in user token and stays connected across restarts.

## Stage 4: Windows packaging

1. Add `scripts/build-local-signal.ts`:

   ```sh
   bun build --compile --target=bun-windows-x64 remote/api/src/index.ts --outfile build/openbot-signal.exe
   ```

2. Add the file to `electron-builder.yml` `extraResources`:

   ```yaml
   - from: build/openbot-signal.exe
     to: signal/openbot-signal.exe
   ```

3. Run the build before `package:win` and `dist:win`.
4. Check that the Windows package starts Signal and that the phone connects.
5. Note the extra binary size in the release notes.

If `bun build --compile` fails for the Signal entry point, fall back to a Node implementation of the
minimal signal protocol. Do not ship a Bun runtime as a second install.

**Result (2026-11-22, unpacked)**: `bun run package:win` produced `dist/win-unpacked` with the
compiled `resources/signal/openbot-signal.exe`. Starting the packaged app starts the pairing API on
`127.0.0.1:3200` and `10.222.0.11:3200`, Signal on `10.222.0.11:3111`, and a host registered with the
copied pairing state. Local mode is the packaged default with host `10.222.0.11` and ports
3200/3111/3112; `OPENBOT_LOCAL_MODE=false` turns it off. Automatic updates and the minimum-version
check are disabled in local mode.

**Result (2026-11-22, installed)**: the NSIS package installed with `/S` to `D:\OpenBot\App`. The
installer default is `D:\OpenBot\App` through `build/installer.nsh`. The packaged app uses
`D:\OpenBot\Data` for the database, pairing state, secrets and logs, and `D:\OpenBot` for `Agents`,
`Shared` and `Downloads`. The stored agent workspace paths were rewritten to `D:\OpenBot\Agents`.
The C-drive profile and the old agent root stay as backups. The plugin icon route returns
`200 image/png` and the update log reports `unsupported`.

## Stage 5: Hardening

- Phone reconnect after Signal restart.
- Phone reconnect after desktop restart.
- Session expiry and ticket renewal.
- EasyTier address change: update the QR and restart the services.
- Desktop sleep and wake: keep the services alive or restart them.
- A second phone: the service must support at least two phone sessions.
- Remove a phone from the desktop Connected devices list.
- Keep analytics, update checks and telemetry off in local mode, or point them nowhere.

## Stage 6: Documentation and checks

- Write `docs/local-mode.md`: requirements, EasyTier setup, pairing, ports, firewall, backup, and
  known losses.
- Add `changelog.d/<branch>.md` with the local-mode note.
- Add one E2E script `scripts/local-mode-e2e.ts`:
  - start the pairing service and Signal;
  - exercise the desktop and phone HTTP contract;
  - connect a WebRTC peer through the local Signal;
  - write `.openbot-build/local-mode/report.json`.
- Run focused checks only: the changed files with `biome check`, the relevant typecheck project, and
  the new E2E script. Leave broad checks to CI.

## File change list

| File or directory | Change | Stage |
| --- | --- | --- |
| `apps/local-pairing/` | New service, including the `node:http` listener and the account stubs | 1, 3 |
| `remote/api/src/config.ts` | `REMOTE_TURN_DISABLED`, `REMOTE_STUN_URL` | 2 |
| `remote/api/src/tokens.ts` | STUN-only ICE servers when TURN is off | 2 |
| `remote/api/src/app.ts` | Report TURN as disabled | 2 |
| `src/main/local-mode.ts` | Local mode configuration and early environment | 3 |
| `src/main/local-services.ts` | Start and stop the pairing server and Signal | 3 |
| `src/main/index.ts` | Apply local mode before the CSP; disable the dev remote role | 3 |
| `src/main/application-services.ts` | Start the services, sign in, start the host, teardown | 3 |
| `src/main/content-security-policy.ts` | Allow the private Signal origin | 3 |
| `src/main/session-configuration.ts` | Pass the local Signal origin to the CSP | 3 |
| `src/renderer/src/features/servers/ServerSettingsModal.tsx` | Own the toast observer from an effect | 3 |
| `scripts/dev-services.ts` | Start only the app in local mode | 3 |
| `package.json`, `electron.vite.config.ts` | Workspace dependency and bundling | 3 |
| `scripts/build-local-signal.ts` | Compile Signal | 4 |
| `scripts/local-mode-e2e.ts` | E2E check | 6 |
| `electron-builder.yml` | Ship the Signal binary | 4 |
| `docs/local-mode.md` | Operator guide | 6 |
| `changelog.d/<branch>.md` | Release note | 6 |

Do not change:

- `apps/mobile`;
- `packages/contracts`;
- Team API routes and wire formats;
- `openbot.db`, migrations and released schemas;
- the Signal protocol.

## Risks

| Risk | Check | Response |
| --- | --- | --- |
| The installed phone build rejects a private HTTP URL | Stage 0 | STOP and report. Do not rebuild the phone. |
| WebRTC has no host candidate over EasyTier | Stage 2 | Check the hidden page and the EasyTier route. |
| The existing host owner id does not match | Stage 3 | Fresh profile, fixed user id, or local owner branch. |
| The Signal binary fails to compile | Stage 4 | Minimal Node signal implementation. |
| The EasyTier address changes | Stage 5 | Fixed virtual IP or a new QR. |
| The phone app updates past the protocol window | Ongoing | Update the fork within 60 days. |

## STOP conditions

- The store app cannot connect in Stage 0.
- The desktop cannot publish a host without an external account after Stage 3.
- Any change would require a phone rebuild or a changeset to the Team API wire protocol.
- Any step needs a released migration change.

## Rollback

All fork changes stay behind local-mode configuration. Unset the local mode and the app uses the
default account service again. Keep `apps/auth-api` and the Signal TURN defaults unchanged so the
upstream path still works.

