# Live Presence Indicator — Prototype Handoff

**Status:** Prototype verified end-to-end (2026-06-12)
**Research:** [live-presence-indicator-research.md](live-presence-indicator-research.md) (decided: Ably presence)
**Try it:** `pnpm dev` → log in via DevUI → http://localhost:5173/dev/presence-prototype

This document is the handoff for the agent implementing presence on the real
lesson page. The prototype proved the full chain live: session cookie → token
endpoint → Ably handshake → two users entering presence on `lesson:prototype`,
seeing each other's `{ name, avatarUrl }` payloads, and leave propagating in
~1.5s.

## File map

### Reusable as-is (lift directly into the real implementation)

| File                                        | What it is                                                                                                                                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app/lib/ably.server.ts`                    | Lazy `Ably.Rest` singleton (`getAblyRest`, returns `null` when `ABLY_API_KEY` unset → callers degrade gracefully) + `buildPresenceTokenParams({ userId, hidden })` (tested).                                                                                                   |
| `app/lib/ably.server.test.ts`               | Unit tests for clientId binding, capability grants, and the hidden opt-out.                                                                                                                                                                                                    |
| `app/routes/api.ably-token.ts`              | Token endpoint (GET). 401 unauthenticated, 503 without key, otherwise returns a `TokenRequest` with clientId bound to the session user. Registered at `api/ably-token` in `app/routes.ts`.                                                                                     |
| `app/components/lesson-presence.tsx`        | Public `<LessonPresence channelName user enter? debug?>` component. Hydration-gated + `React.lazy` so the Ably SDK never runs during SSR and stays out of the server bundle.                                                                                                   |
| `app/components/lesson-presence-client.tsx` | The Ably-touching half: singleton `Ably.Realtime` (one connection per tab, `authUrl: "/api/ably-token"`, `closeOnUnload`), `AblyProvider`/`ChannelProvider`, presence enter + listener, clientId dedupe, avatar stack (cap 5 + "+N", hidden when alone), optional debug panel. |

### Throwaway (delete when the real feature ships)

- `app/routes/dev.presence-prototype.tsx` + its entry in `app/routes.ts` —
  dev-only route (404s in production), joins `lesson:prototype`, renders the
  component with the debug panel and multi-user test instructions.

## Findings that correct or sharpen the research doc

1. **There is no `presence-subscribe` capability operation.** The valid set
   (verified against https://ably.com/docs/auth/capabilities) is: `subscribe`
   covers receiving presence events _and_ `presence.get()`; `presence` covers
   enter/update/leave. So the capability is `{ "lesson:*": ["subscribe", "presence"] }`,
   and the opt-out variant is `{ "lesson:*": ["subscribe"] }`.
2. **Token capability is intersected with the issuing API key's capability.**
   A key lacking `presence` will still happily issue a `TokenRequest` that
   _claims_ `presence` — the failure only surfaces at `presence.enter()` as
   Ably error **40160** ("lacking the required 'presence' capability",
   HTTP 401). If you see 40160, check the key's capabilities in the Ably
   dashboard before debugging the token endpoint. This also confirms the
   opt-out enforcement works: a subscribe-only token genuinely cannot enter.
3. **The dev server snapshots `.env` at startup.** React Router's dev server
   loads `.env` into `process.env` once; editing `ABLY_API_KEY` requires a
   server restart. (Hit live: a stale server on 5173 kept serving tokens from
   a rotated-out key.)
4. **`capability` can be passed as an object** (`Ably.TokenParams` accepts
   `{ [resource]: capabilityOp[] }`) — no manual `JSON.stringify`.
5. **ably/react v2 hook signatures** (verified against installed `ably@2.22.1`):
   `usePresence(channelName, payload)` enters on mount / leaves on unmount;
   `usePresenceListener(channelName)` returns `{ presenceData }`. Hooks can't
   be conditional, so opting out of _entering_ is done by conditionally
   rendering a child component that calls `usePresence` (see `EnterPresence`
   in `lesson-presence-client.tsx`).
6. **Same user in two tabs = two presence members** (same clientId, different
   connectionId). The component dedupes by clientId; the debug panel on the
   prototype route makes this visible.

## Checklist to ship on the real lesson page

1. **Channel per lesson:** render `<LessonPresence channelName={`lesson:${lessonId}`} ...>`
   in `courses.$slug.lessons.$lessonId.tsx`. The existing `lesson:\*` token
   capability already covers it — no token endpoint changes.
2. **Loader:** pass `{ id, name, avatarUrl }` for the current user (the lesson
   loader already loads the user) and an `ablyConfigured` flag from
   `getAblyRest() !== null`; render nothing when unconfigured.
3. **Opt-out ("appear invisible"):** add a `hidePresence` boolean to `users`
   (column `hide_presence`, default false) + a checkbox in `settings.tsx`.
   Wire it in **two** places: pass `hidden: user.hidePresence` to
   `buildPresenceTokenParams` in the token endpoint (server-side enforcement —
   already supported and tested), and `enter={!user.hidePresence}` on the
   component (avoids a guaranteed-to-fail enter attempt).
4. **Polish:** drop the `debug` prop; names currently surface via the avatar
   `alt`/initials only — add a tooltip (`pnpm dlx shadcn@latest add tooltip`,
   per the repo's add-via-CLI convention) if names-on-hover is wanted.
5. **Cleanup:** delete `app/routes/dev.presence-prototype.tsx` and its route
   entry; delete this file and mark the research doc shipped; update the Ably
   line in `docs/gotchas.md`.

## Testing notes

- Multi-user: two windows (normal + incognito), switch users via DevUI. The
  token endpoint picks up a user switch on the next token request — force it
  with a hard reload.
- The token endpoint + capability logic is the only meaningful server logic
  and is unit-tested in `app/lib/ably.server.test.ts`. The UI is thin over
  Ably's hooks; the prototype route is the manual harness for it.
- Headless end-to-end check (what verified this prototype): authenticate two
  session cookies via `POST /api/switch-user`, then two `Ably.Realtime` node
  clients with an `authCallback` that curls `/api/ably-token` with each cookie
  jar — enter both, `presence.get()`, leave one, re-get.
