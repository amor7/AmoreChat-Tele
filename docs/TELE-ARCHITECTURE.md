# Tele integration architecture

This document describes the design and module boundaries of the Telegram user-account integration (Tele) in AmoreChat. It is implemented in `server/src/tele/` (plus `server/src/routes/tele.js`) and in the web client's `web/src/components/Tele*.jsx`; the sections below are the rules that code is meant to follow, and the milestone list records what is done.

## Goals

- Keep the existing AmoreChat chat, authentication, realtime, and media paths operational without Telegram connectivity.
- Add a separate Tele area in the web client, with Telegram account sessions owned by the signed-in AmoreChat user.
- Permit authorized users to connect their own Telegram account and choose which dialogs to mirror into Tele.
- Send supported outgoing messages through the same Telegram account and reflect supported incoming updates.
- Keep Telegram egress server-side. Browser clients must not need a VPN/proxy.
- Provide an administrator-managed outbound proxy inventory and routing policy, with health/availability information.
- Fail closed: when the configured Telegram route is unavailable, pause/retry Telegram operations; never silently route Telegram traffic directly.

## Proposed boundaries

1. **Tele API and authorization** — authenticated routes, per-user ownership checks, admin-only proxy inventory and routing policy.
2. **Telegram account/session manager** — one isolated TDLib client/session per connected Telegram account; login flow, session lifecycle, updates, and logout/revocation.
3. **Dialog sync and message bridge** — selected-dialog state, bounded initial history import, update mapping, media transfer, and idempotency/deduplication.
4. **Egress routing service** — turns supported proxy definitions into a local proxy endpoint for Telegram clients; chooses manual, priority/failover, random, or measured-health route.
5. **Tele UI** — separate navigation and views, independent of the existing AmoreChat conversation store where practical.

## Data isolation and credentials

- Telegram account records and mirrored dialog/message rows must be scoped to the owning AmoreChat user.
- Every API operation must verify ownership server-side; a client-provided account or dialog ID is not authorization.
- TDLib session/database files and proxy credentials are secrets. Store them outside public/static/upload paths, restrict filesystem permissions, and do not log auth codes, passwords, session data, or proxy URLs.
- The owner/admin may manage proxy endpoints and policies, but must not be able to read users' Telegram login credentials or session contents.
- Provide a disconnect action that stops the TDLib client and removes/revokes local session data as appropriate.

## Egress safety

- Telegram clients must be configured to use an explicitly selected local proxy/egress bridge.
- Do not configure a direct connection as a fallback.
- If a proxy is unhealthy or routing fails, mark the route unavailable, queue/retry permitted work with bounded backoff, and expose status in Tele.
- Health checks should test Telegram-relevant reachability through the proxy, not rely solely on ICMP.
- Proxy tests and Telegram connectivity tests must run through the candidate route.
- The regular AmoreChat API, Socket.IO, and media paths must not be redirected through the Telegram proxy.

## Proxy support strategy

Treat protocol support as adapter-specific and verify each implementation with integration tests before advertising it. The inventory can represent V2Ray-style links/subscriptions, SOCKS4/5, HTTP(S), MTProto, and VPN profiles, but not every protocol necessarily maps to the same local bridge.

- Prefer a local proxy bridge supported by the Telegram client (for example, SOCKS5/HTTP/MTProto where supported).
- Use a separately managed routing adapter for protocols that need a local SOCKS/HTTP bridge.
- Do not claim OpenVPN, WireGuard, or every V2Ray URI is supported until parsing, lifecycle, health checks, and no-direct-fallback behavior are tested for that adapter.
- Keep endpoint secrets encrypted at rest and redact them from API responses and logs.

## Telegram passcode

Optional per-user passcode (migration v26, table `tele_passcodes`, scrypt hash via `auth.js`). Code: `tele/passcode.js`, `tele/passcode-rules.js`, `routes/tele-passcode.js`, `backup-redact.js`.

- Threat model: panel admins and anyone who resets a user's password. Not root or shell on the server (they can read the data directly); the UI says so.
- Guard: the hook in `routes/tele.js` calls `assertTeleUnlocked` for every `/api/tele/*` route and for `/api/admin/tele/mirrors*`, matching on `req.routeOptions.url` (the registered route, not the raw URL, so encoded paths like `/api/%74ele/...` cannot bypass it). `/api/tele/status` is exempt but returns only `{access, locked, passcode}` while locked. The passcode routes live in their own plugin so they work while locked.
- State: unlocked sessions are kept in memory only (session id to user and last-use time). A restart locks everyone; logout, revoke and password reset make entries inert. Failed-attempt counters are in the database and survive restarts (5 wrong = 15 minutes).
- Locked requests get HTTP 423. Background jobs (send queue, mirror, sync, alerts) keep running while locked.
- Backups: `backup-redact.js` runs in a child process on the snapshot file (never the live DB) and removes Telegram messages and identifying fields of users with a passcode, then VACUUMs. It is applied to auto backups, panel downloads, and existing backups when a passcode is first enabled; a file that cannot be redacted is deleted.
- Restore from the panel: the current passcode rows are written to `data/tele-passcodes.carry.json` (0600) when the restore is requested (refreshed when the app stops) and put back with INSERT OR REPLACE at the next start, after the migrations (`passcode-carry.js`, `index.js`); rows only in the restored database stay, users missing from it are skipped. If that file can't be read it is moved to `data/tele-passcodes.carry.corrupt` and Telegram is closed (423) for every user while that file exists; the rest of the app works. Deleting it (shell, outside the threat model) lifts this at the next restart.
- Warning: any new route or socket event that returns a user's Telegram data outside `/api/tele/` must call `assertTeleUnlocked`. The hook does not cover it.

## Implementation milestones

Status as checked against the code (the tests in item 6 are only partly there).

1. Done: schema and migrations for Telegram accounts, dialogs, messages, proxy inventory and routing policy (`tele_*` tables in `server/src/db.js`).
2. Done: admin APIs/UI for proxy entries and routing policy (`tele/proxies.js`, `TeleAdmin.jsx`, `TeleProxyForm.jsx`), and a route-health probe through the candidate route (`probeViaEgress`, `probeAll` in `tele/egress.js`).
3. Done: isolated per-account Telegram session manager and login lifecycle, with encrypted sessions and a disconnect action (`tele/accounts.js`, `disconnectAccount`).
4. Done: per-user dialog selection and bounded history sync (`setDialogSelected`, `syncDialogMessages`).
5. Done: send/receive mapping for text, photos, voice and files, with an offline retry queue (`tele/messages.js`, `flushQueue`). Not re-verified here: the idempotency/deduplication behavior.
6. Partly done: authorization boundaries are covered by `server/test/tele-e2e.mjs` (real Telegram test DC), and proxy link parsing by `server/test/uri.test.mjs`. Dedicated tests for route failure, proxy failover and "no direct egress" were not found.

## Out of scope

- Telegram Secret Chats (they are device-specific and not available through the ordinary client API sync model).
- Telegram voice/video calls. (Voice messages are supported; calls are not.)
- Full mirroring of every dialog by default; users must opt in per dialog.
- Merging Telegram messages into native AmoreChat chats. (A single message can be forwarded between Tele and a native chat in both directions, but the two stay separate stores.)
