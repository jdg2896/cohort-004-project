# Gotchas & environment notes

- Ably is wired up only as a **dev-only presence prototype** (`/dev/presence-prototype`, token endpoint at `/api/ably-token`) — see `plans/live-presence-indicator-prototype.md`. Not on any real page yet. `ABLY_API_KEY` is read from `.env` **at dev-server startup** — restart after changing it; Ably error 40160 on `presence.enter` means the API key itself lacks the `presence` capability.
- `data.db` is committed and gitignored variants (`-shm`/`-wal`) are working files; regenerate state with `db:migrate` + `db:seed` if it gets messy.
- UI is shadcn/ui ("new-york" style) in `app/components/ui/` + Tailwind 4. Add primitives via the `shadcn` CLI rather than hand-rolling.
