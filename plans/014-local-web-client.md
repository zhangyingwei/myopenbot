# Plan 014: Browser web client on the local host

## State

IN PROGRESS

## Request

The owner runs the fork on one Windows host. They want to operate the same personal bot from a
browser on another computer in the EasyTier network. The phone app, the Team API wire protocol and
the migrations stay unchanged.

## Premise

The service is private: it binds loopback and the EasyTier host address only, and it never goes to
the public internet. The owner accepts no security layer: no sign-in, no origin checks, no CSRF
checks, no TLS. Plan 013 already loads the desktop account automatically; the browser session does
the same.

## Current facts

- The web client is in the repository: the route `apps/auth-api/src/routes/app.tsx` loads
  `src/renderer/src/features/web-client/WebApp.tsx`, which uses the shared renderer features through
  browser ports.
- The web client calls `/api/browser/*` with a cookie session. The directory client
  (`packages/team-client/src/remote-directory.ts`) prefixes `/api/browser` for `authentication:
  { kind: "browser" }`.
- The local pairing service (`apps/local-pairing`) already serves `/v2/remote/hosts/`,
  `/v2/remote/sessions/`, `/v2/remote/sessions/:id/ticket` and the account routes, and it starts
  with the desktop app in local mode (`src/main/local-services.ts`).
- The web client computes `apiUrl` from `window.location.origin`, so serving it from the local
  service origin needs no change in WebApp.
- Secure-context APIs are missing on plain HTTP over a private IP: `crypto.randomUUID`,
  `navigator.locks` and `navigator.clipboard`. The web client uses the first two in the connection
  path (`web-host-lock.ts`, `web-runtime.ts`, `web-notifications.ts`).

## Decisions

- Host the web client from the local pairing service origin, `http://<host>:<apiPort>/app`, not
  from a second port. Same origin removes CORS work.
- Do not run the Cloudflare Worker locally. The Worker needs D1, R2, billing and mail bindings that
  the fork does not have.
- Build a small standalone Vite entry (`apps/local-web`) that mounts the existing `WebApp`
  component. Do not statically export the TanStack Start application.
- Create the cookie session on the first `/api/browser/session` request and bind it to
  `local-owner`. The browser needs no sign-in step. Store only a hash of the cookie token.
- Send no security headers that the local mode cannot honor, and check no origin, CSRF or host
  header. The bind address is the boundary.
- Keep HTTP. The core chat path uses WebSocket and WebRTC data channels. Document that microphone,
  clipboard and notifications need HTTPS, and that the host must join EasyTier to be reachable.

## Target architecture

```text
OpenBot.exe
  local pairing service  127.0.0.1:<apiPort> and <host>:<apiPort>
    /app                static web client
    /api/browser/*      cookie session bound to local-owner
    /v1/... /v2/remote/ existing JSON API
  Signal                 <host>:<signalPort>
remote computer browser -> http://<host>:<apiPort>/app
  -> /api/browser/* (cookie) -> local service -> host bootstrap -> Signal -> host
```

## Stage 0: Build spike

- Add `apps/local-web` with `index.html`, `src/main.tsx`.
- `main.tsx` renders `WebApp` and imports `web-client.css`, the i18n catalogs and the language
  loader.
- Alias `@openbot/renderer-web` to `src/renderer/src/features/web-client/WebApp.tsx`, as
  `apps/auth-api` does.
- Acceptance: `vite build` produces a self-contained client bundle, and a plain static server shows
  the sign-in or the workspace without a TanStack Start server.

## Stage 1: Static routes in the local service

- Serve the built assets at `/app` and `/app/assets/*`, with `index.html` for unknown `/app`
  paths.
- Read the assets from `resources/web` in a packaged app and from `apps/local-web/dist` in
  development.
- Send `Cache-Control: no-store` for `index.html` and a long cache for hashed assets.
- Load only the files that Stage 0 produces; no path outside the web root.
- Acceptance: `curl http://<host>:<apiPort>/app` returns the shell, and each asset has a 200.

## Stage 2: Browser session adapter

- Add `/api/browser/*` to the local service.
- Create the cookie session on the first request: a random 256-bit token, `HttpOnly`,
  `SameSite=Lax`, `Path=/`, no `Secure` because the origin is HTTP. Store only a hash of the token.
- Map the user to `local-owner` and the same profile that the desktop uses.
- Add the account routes that the web client calls: `GET /v1/me`, `PATCH /v1/me/profile`,
  `PUT|DELETE /v1/me/avatar`, `PUT /v1/me/analytics`, `PUT /v1/me/chat-color`,
  `GET /v1/me/sessions`, `DELETE /v1/me/sessions/:id`. Return stubs where local mode has no data.
- Map the directory routes to the existing service: hosts list, host read, session start, session
  ticket, session end.
- Keep the phone flows and the Team API wire protocol unchanged.
- Acceptance: the browser opens `/app`, lists the host, opens an agent and a conversation, and sends
  a message that the desktop shows.

## Stage 3: Secure-context shims

- Add `apps/local-web/src/polyfills.ts` and load it before `WebApp`: a `crypto.randomUUID` shim from
  `crypto.getRandomValues`, a minimal `navigator.locks` implementation with a localStorage lease,
  and a `navigator.clipboard.writeText` fallback.
- Acceptance: over `http://<host>:<apiPort>/app`, the browser connects to the host, and a second tab
  gets the shared other-tab message.

## Stage 4: Packaging

- Build `apps/local-web` in `package:win` and `dist:win`, beside `build:local-signal`.
- Copy the output to `resources/web` through `electron-builder.yml`.
- Acceptance: the installed app serves `/app` from `resources/web`.

## Stage 5: Acceptance on Windows

- Desktop and web client show the same agent list and the same conversation order.
- A message from the web client reaches the desktop and the phone.
- A desktop restart does not break the open browser page; the browser reconnects.
- The phone connects as before, with no new QR scan.
- The update log still reports `unsupported`.

## Risks

- `WebApp` expects browser ports that call `/api/browser/*` and `window.location.origin`; any missing
  route shows as a failed panel, not as a crash. Add routes as the browser reports them.
- The standalone build may miss a global style or a Vite transform that the Start build supplies.
  Stage 0 finds this early.
- Plain HTTP limits some browser APIs. The shims cover the connection path; microphone and
  notifications stay unavailable.
- A cookie session that maps to `local-owner` gives full host control to every device in the
  EasyTier network. This is the same trust the phone app has, and it stays off the public internet.

## STOP conditions

- Stage 0 cannot produce a bundle without the Cloudflare Worker runtime.
- The browser client needs a server route that the local service cannot answer without the account
  service.
- A change would alter the phone flows, the Team API wire protocol or a released migration.

## Rollback

The `/app` and `/api/browser/*` routes are additive. Remove the static route and the adapter, drop
`apps/local-web`, and rebuild. No database change is needed.
