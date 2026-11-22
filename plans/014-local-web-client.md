# Plan 014: Browser web client on the local host

## State

PLANNED

## Request

The owner runs the fork on one Windows host. They want to operate the same personal bot from a
browser on another computer in the EasyTier network. The phone app, the Team API wire protocol and
the migrations stay unchanged.

## Current facts

- The web client is in the repository: the route `apps/auth-api/src/routes/app.tsx` loads
  `src/renderer/src/features/web-client/WebApp.tsx`, which uses the shared renderer features through
  browser ports.
- `apps/auth-api/src/server/browser-api.ts` serves `/api/browser/*` with a cookie session and the
  `X-OpenBot-Browser` header. The browser client uses this prefix for account, host and session
  calls.
- The local pairing service (`apps/local-pairing`) already serves `/v2/remote/hosts/`,
  `/v2/remote/sessions/` and `/v2/remote/sessions/:id/ticket`, so the host bootstrap that carries
  `signalUrl` is available. It has no static routes and no cookie session.
- The web client computes `apiUrl` from `window.location.origin`, so serving it from the local
  service origin needs no client change.

## Decisions

- Host the web client from the local pairing service origin, `http://10.222.0.11:3200/app`, not from
  a second port. Same origin removes CORS work.
- Do not run the Cloudflare Worker locally. The Worker needs D1, R2, billing and mail bindings that
  the fork does not have.
- Build a small standalone Vite entry (`apps/local-web`) that mounts the existing `WebApp`
  component. Do not statically export the TanStack Start application: the Start shell renders the
  HTML at request time, and its server routes have no static form. The first choice that works wins;
  a client-only export of `apps/auth-api` is the fallback.
- Bind the session to `local-owner` with a random token in an HttpOnly cookie. The browser then needs
  no sign-in step, and the desktop keeps its bearer token.
- Serve the web client only from the loopback and the host address, the same two addresses that the
  pairing service uses.
- Keep HTTP. The core chat path uses WebSocket and WebRTC data channels. Document that microphone,
  clipboard and notifications need HTTPS, and that the host must join EasyTier to be reachable.

## Target architecture

```text
OpenBot.exe
  local pairing service  127.0.0.1:3200 and 10.222.0.11:3200
    /app                static web client
    /api/browser/*      cookie session bound to local-owner
    /v1/... /v2/remote/ existing JSON API
  Signal                 10.222.0.11:3111
remote computer browser -> http://10.222.0.11:3200/app
  -> /api/browser/* (cookie) -> main API -> host bootstrap -> Signal -> host
```

## Stage 0: Build spike

- Add `apps/local-web` with `index.html`, `src/main.tsx`, `src/local-web.css`.
- `main.tsx` renders `WebApp` and imports `web-client.css`, the i18n catalogs and the language loader.
- Alias `@openbot/renderer-web` to `src/renderer/src/features/web-client/WebApp.tsx`, as
  `apps/auth-api` does.
- Acceptance: `vite build` produces a self-contained client bundle, and a plain static server shows
  the sign-in or the workspace without a TanStack Start server. If the bundle needs server functions,
  record which ones and stop.

## Stage 1: Static routes in the local service

- Serve the built assets at `/app` and `/app/assets/*`, with `index.html` for unknown `/app` paths.
- Read the assets from `resources/web` in a packaged app and from the build folder in development.
- Send `Cache-Control: no-store` for `index.html` and a long cache for hashed assets.
- Load only the files that Stage 0 produces; no path outside the web root.
- Acceptance: `curl http://10.222.0.11:3200/app` returns the shell, and each asset has a 200.

## Stage 2: Browser session adapter

- Add `/api/browser/*` to the local service and forward to the existing handlers where possible.
- Create the cookie session on the first request: a random 256-bit token, `HttpOnly`,
  `SameSite=Lax`, `Path=/`, no `Secure` because the origin is HTTP. Store only a hash of the token.
- Require `X-OpenBot-Browser: 1` on non-GET requests, as the official client already sends it.
- Map the user to `local-owner` and the same profile that the desktop uses.
- Add the account routes that the web client calls: `GET /v1/me`, `PATCH /v1/me/profile`,
  `PUT|DELETE /v1/me/avatar`, `PUT /v1/me/analytics`, `PUT /v1/me/chat-color`,
  `GET /v1/me/sessions`, `DELETE /v1/me/sessions/:id`. Return stubs where local mode has no data.
- Keep the market proxy, host list, session and ticket routes as they are.
- Acceptance: the browser opens `/app`, lists the host, opens an agent and a conversation, and sends
  a message that the desktop shows.

## Stage 3: Packaging

- Build `apps/local-web` in `package:win` and `dist:win`, beside `build:local-signal`.
- Copy the output to `resources/web` through `electron-builder.yml`.
- Add the local web origin to the CSP only if the renderer loads it; the browser page gets its own
  headers from the local service.
- Acceptance: the installed app serves `/app` from `D:\OpenBot\App\resources\web`.

## Stage 4: Security and limits

- Reject `/app` and `/api/browser/*` requests from an address that is not loopback or the host
  address. The service binds those two, and this check keeps the rule after a bind change.
- Do not log the cookie token. Redact it like the bearer token.
- Keep the phone flows and the Team API wire protocol unchanged.
- Document in `TASKS.md`: no HTTPS means no microphone, no clipboard API and no notifications; a
  remote computer needs EasyTier, and the app must be running.

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
- Plain HTTP limits some browser APIs. If the owner needs voice input, add a self-signed certificate
  as a later stage.
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
