# Live Presence Indicator — Research & Implementation Plan

**Status:** Decided — Ably presence (confirmed 2026-06-12)
**Date:** 2026-06-12
**Surface:** Lesson page (`courses.$slug.lessons.$lessonId.tsx`) only

## What we're building

A live presence indicator on the lesson page showing students **who else is viewing the same lesson right now** — a stacked row of avatars with names on hover, reusing the existing `UserAvatar` component (`app/components/user-avatar.tsx`).

### Agreed requirements

| Decision     | Choice                                                                                    | Rationale                                                                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Display      | Avatars + names, with an "appear invisible" opt-out                                       | The product intent is knowing _who_, not just how many. Profiles/names are already public on comments, so showing identity matches existing norms. The opt-out defuses the privacy objection. |
| Freshness    | Near-real-time **requirement** (≤15s staleness acceptable); instant is a bonus            | Presence here is ambient social proof, not collaborative editing. Requirement set by product need, not by transport capability.                                                               |
| Persistence  | Ephemeral only — no presence history written to the database                              | Engagement data is already covered by video tracking; avoids schema and write load.                                                                                                           |
| Scope        | Lesson page only                                                                          | One channel per lesson. Course-level aggregate is a possible phase 2.                                                                                                                         |
| Scale target | Design for growth (multiple server instances / hundreds of concurrent viewers eventually) | This is the deciding constraint — see below.                                                                                                                                                  |

## Approaches researched

### 1. Polling + server-side heartbeat (self-contained)

Client posts a heartbeat to a resource route every ~10s (`useFetcher` + `setInterval` — a targeted fetch, unlike `useRevalidator` which re-runs _all_ active loaders on the page; polling is officially documented for both hooks, the only approach here with first-class RR7 docs — [useRevalidator](https://reactrouter.com/api/hooks/useRevalidator), [useFetcher](https://reactrouter.com/api/hooks/useFetcher)). A GET returns everyone whose last heartbeat is within a TTL window (~30s, i.e. 3 missed beats; TTL = 2–3× heartbeat is the conventional ratio, cf. socket.io's 25s/20s ping defaults). Presence state lives in an in-memory `Map` in a service (truly ephemeral, no schema changes).

- **Pros:** zero dependencies, no API keys, fits the Routes → Services layering perfectly, trivially testable, meets the ≤15s freshness requirement, and is the only option with current official RR7 documentation.
- **Cons:** an in-memory map is **single-process only** — it silently breaks the moment the app runs on more than one instance. Backing it with a SQLite table instead would survive multi-process-on-one-host, but SQLite itself pins the app to one host, so it never gets us to real horizontal scale — and it violates the "ephemeral only" decision.
- **Dev trap:** Vite HMR can reset module-level state, wiping the presence map on every server-code edit — the standard fix is the `globalThis` singleton pattern (as used for DB connections in Remix-era apps).
- **Leave detection:** TTL eviction is the source of truth; explicit leave signals are best-effort only. `navigator.sendBeacon` on `pagehide` makes departures faster but is only ~91% reliable even with best practices ([nicj.net beaconing study](https://nicj.net/beaconing-in-practice-an-update-on-reliability-and-the-pending-beacon-api/), [MDN sendBeacon](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon)). Note `visibilitychange → hidden` also fires on mere tab switches — the common choice is to stop heartbeating when hidden and let the TTL expire, rather than removing immediately.

### 2. Server-Sent Events (self-contained, push)

A resource route returns a `text/event-stream` via `eventStream` from `remix-utils/sse/server`; the client subscribes with `useEventSource` from `remix-utils/sse/react`. remix-utils supports React Router ≥7.3 with these subpath exports ([npm](https://www.npmjs.com/package/remix-utils), [sergiodxa's SSE tutorial](https://sergiodxa.com/tutorials/use-server-sent-events-with-remix)).

- **Pros:** instant updates, still no third-party service.
- **Cons:** all the multi-instance problems of approach 1 (the `EventEmitter` + presence map are in-process), **plus** long-lived connections: SSE counts against the browser's hard HTTP/1.1 limit of 6 connections per domain ("won't fix" in Chrome/Firefox, lifted by HTTP/2 — [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)). That bites in dev, where Vite serves HTTP/1.1 and HMR reloads are reported to leak zombie SSE connections until the cap hangs the app. We'd also still need heartbeats to detect dead clients. Notably, **no official RR7 doc covers streaming responses from resource routes** — remix-utils and Remix-era tutorials are the only sources. Strictly more complexity than polling for a freshness level we said we don't need.

### (Ruled out early) Self-hosted WebSockets

The default `react-router-serve` server explicitly **cannot be extended** ("we do not provide options to customize the React Router App Server" — [RR7 docs](https://reactrouter.com/api/other-api/serve)), so attaching a WebSocket server means replacing it with a custom Express server (the official `node-custom-server` template) plus Vite-middleware wiring for dev, plus care not to collide with Vite's own HMR WebSocket. That is a structural change to how the whole app is served, for one ambient feature — and it still has the in-process state problem. Not worth it.

### 3. Ably presence (managed) — **recommended**

Ably channels have a first-class presence set: clients `enter()`/`leave()` with an attached JSON payload (e.g. `{ name, avatarUrl }`), other clients subscribe to enter/leave/update events and read the current set with `presence.get()` ([Ably presence docs](https://ably.com/docs/presence-occupancy/presence)). Members are removed automatically when their connection drops (within ~1 minute), so liveness/heartbeating is Ably's problem, not ours.

- **React integration:** official hooks ship in the `ably` package under the `ably/react` subpath — `usePresence()` enters/leaves with component mount/unmount, `usePresenceListener()` returns the live `presenceData` array. Requires `AblyProvider` + `ChannelProvider` wrappers ([Ably React guide](https://ably.com/docs/getting-started/react)).
- **Auth:** token authentication — our server holds the API key and exposes an auth endpoint returning a `TokenRequest` (`ably.auth.createTokenRequest(...)` from the REST SDK); the browser client points `authUrl` at it and auto-renews. The token **binds `clientId`** (the user can't impersonate someone else) and **restricts capabilities** per channel namespace ([Ably token auth docs](https://ably.com/docs/auth/token)).
- **Free tier (verified June 2026):** 200 concurrent connections, 200 concurrent channels, 6M messages/month, 500 msg/s, max 200 presence members per channel. Next tier (Standard) is $29/mo + usage ([Ably pricing](https://ably.com/pricing), [limits](https://ably.com/docs/platform/pricing/limits)).
- **Cost trap to know about:** every presence enter/leave/update is a billed message fanned out to all presence subscribers — O(N²) on churn. 200 members churning on one channel ≈ 80k messages ([Ably FAQ](https://faqs.ably.com/why-do-you-have-a-limit-on-the-number-of-members-present-on-a-channel), [presence at scale](https://ably.com/blog/user-presence-at-scale)). At our scale this is a non-issue: a lesson with 20 concurrent viewers and healthy churn is hundreds of messages per hour against a 6M/month quota. It only matters if a single lesson approaches hundreds of simultaneous viewers — at which point Ably's server-side batching (paid tiers) raises the ceiling to 20k members.

### Why Ably wins here

The deciding constraint is **design for growth**. Both self-contained options keep presence state in the Node process, which breaks at the first horizontal scale-out (the standard mitigation — Redis pub/sub + sticky sessions — is more infrastructure than Ably, not less). Ably moves presence entirely out of our process and our database, so it scales independently of the SQLite question. Secondary points: the README already names Ably as the intended realtime layer; the free tier comfortably covers cohort scale; and presence (enter/leave/member-data/liveness) is exactly the feature Ably ships first-class, so we write almost no presence logic ourselves.

Polling (approach 1) remains the documented fallback if we want to avoid the external dependency: it meets the freshness requirement and is the least code, accepting the single-process ceiling.

### Other managed options considered (briefly)

- **Supabase Realtime** — has presence (25s default heartbeat, `track`/`untrack`), but pulls in a whole platform for one feature ([docs](https://supabase.com/docs/guides/realtime/presence)).
- **PartyKit** — acquired by Cloudflare (2024); now oriented toward Cloudflare Durable Objects deployment — a bigger architectural commitment ([Cloudflare blog](https://blog.cloudflare.com/cloudflare-acquires-partykit/)).
- **Liveblocks / Pusher** — comparable presence features; no advantage over Ably for us, and the README already standardizes on Ably.

## Implementation design

### Pieces

1. **Env + server lib** — `ABLY_API_KEY` in `.env`; `app/lib/ably.server.ts` exporting a lazily-created `Ably.Rest` client (server-only suffix per convention).

2. **Token endpoint** — resource route `app/routes/api.ably-token.ts` (registered in `app/routes.ts`):
   - `getCurrentUserId(request)` → 401 if absent.
   - Returns `ably.auth.createTokenRequest({ clientId: String(user.id), capability })`.
   - Capability: `{ "lesson:*": ["subscribe", "presence-subscribe", "presence"] }` — but **omit the `presence` (enter) capability when the user has opted out**, so invisibility is enforced server-side, not just in the UI.

3. **Channel naming** — `lesson:{lessonId}`. One channel per lesson; the `lesson:*` capability wildcard scopes tokens to exactly these.

4. **Client provider** — the Ably Realtime client must be created **browser-side only** (SSR caveat: never instantiate during server render). Mount `AblyProvider` + `ChannelProvider` inside a client-gated wrapper on the lesson route, with `authUrl: "/api/ably-token"`. Lazy-import the SDK so it stays out of the SSR bundle and off non-lesson pages.

5. **Presence component** — `app/components/lesson-presence.tsx`:
   - `usePresence(channel, { name, avatarUrl })` to enter (skipped entirely when the current user opted out).
   - `usePresenceListener(channel)` for the live member list.
   - **Dedupe by `clientId`** — the same user in two tabs appears as two presence members.
   - Filter out the current user; render stacked `UserAvatar`s (cap at ~5 + "+N" overflow), names in tooltips. Render nothing when alone — an empty presence strip is worse than none.
   - Note: the `{ name, avatarUrl }` payload is client-supplied. `clientId` is cryptographically bound by the token, so identity can't be spoofed — only the cosmetic fields could be, by an authenticated student editing their own payload in the console. Acceptable; if it ever matters, viewers can resolve `clientId → user` server-side instead.

6. **Opt-out setting** — boolean column on `users` (e.g. `hidePresence` / `hide_presence`, default false) + checkbox in `settings.tsx` ("Don't show me in 'currently viewing'"). This is a user preference, not presence history, so it doesn't conflict with the ephemeral-only decision. Enforced in the token endpoint (step 2) and respected in the component (step 5).

7. **Loader additions** — lesson loader passes the current user's `name`, `avatarUrl`, and `hidePresence` to the component (it already loads the user for access checks).

### What we deliberately get for free from Ably

- **Liveness/leave detection** — connection-based; no heartbeat code, no TTL eviction, no `sendBeacon`.
- **Instant updates** — exceeds our ≤15s requirement at no extra cost.
- **Multi-instance correctness** — presence state never touches our process or SQLite.

### Dev/test notes

- DevUI user-switching changes the session user; the token endpoint picks this up on the next token request — test multi-user presence with two browser profiles or a normal + incognito window.
- The token endpoint and the capability/opt-out logic are the only meaningful server logic; unit-test them (service-testing convention applies if any of it lands in a service file). The presence UI itself is thin over Ably's hooks.
- Without `ABLY_API_KEY` set, the lesson page must degrade gracefully: render no presence strip rather than erroring (guard in the loader/component).

### Estimated free-tier headroom

Cohort scale (~tens of concurrent users platform-wide): single-digit % of the 200-connection limit, negligible message volume. The first real ceiling is 200 concurrent connections platform-wide (one per open tab on a lesson page), then $29/mo Standard lifts it to 10k.

## Sources

- Ably presence: https://ably.com/docs/presence-occupancy/presence
- Ably token auth: https://ably.com/docs/auth/token
- Ably React hooks: https://ably.com/docs/getting-started/react
- Ably pricing/limits: https://ably.com/pricing • https://ably.com/docs/platform/pricing/limits
- Presence member limits & message math: https://faqs.ably.com/why-do-you-have-a-limit-on-the-number-of-members-present-on-a-channel • https://ably.com/blog/user-presence-at-scale
- SSE in Remix/RR7: https://sergiodxa.com/tutorials/use-server-sent-events-with-remix • https://www.npmjs.com/package/remix-utils
- RR7 polling hooks: https://reactrouter.com/api/hooks/useRevalidator • https://reactrouter.com/api/hooks/useFetcher • resource routes: https://reactrouter.com/how-to/resource-routes
- RR7 server cannot be extended (WebSockets): https://reactrouter.com/api/other-api/serve
- SSE connection limits: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
- Beacon reliability: https://nicj.net/beaconing-in-practice-an-update-on-reliability-and-the-pending-beacon-api/ • https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon
- Supabase Realtime presence: https://supabase.com/docs/guides/realtime/presence
- PartyKit → Cloudflare: https://blog.cloudflare.com/cloudflare-acquires-partykit/
