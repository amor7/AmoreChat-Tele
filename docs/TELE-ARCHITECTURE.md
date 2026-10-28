# Tele integration architecture (draft)

This document records the implementation boundaries for adding Telegram user-account integration to AmoreChat. It is a design note, not a claim that Telegram integration is already implemented.

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

## First implementation milestones

1. Add schema and migration for Telegram account metadata, selected dialogs, proxy inventory, and routing policy (without storing plaintext auth secrets).
2. Add admin APIs/UI for proxy entries and policy selection, plus a route-health test that is explicitly non-fallback.
3. Add the isolated Telegram session manager and login lifecycle.
4. Add per-user dialog selection and bounded history sync.
5. Add message send/receive mapping and media handling with idempotency.
6. Add tests for authorization boundaries, route failure, proxy failover, and ensuring no direct egress.

## Out of scope for the initial milestone

- Telegram Secret Chats (they are device-specific and not available through the ordinary client API sync model).
- Telegram voice/video calls.
- Full mirroring of every dialog by default; users must opt in per dialog.
- Merging Telegram messages into native AmoreChat chats.
