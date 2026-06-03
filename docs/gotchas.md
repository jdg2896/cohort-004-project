# Gotchas & environment notes

- The README lists Ably for real-time presence, but it is **not currently wired into the codebase** — don't assume it exists.
- `data.db` is committed and gitignored variants (`-shm`/`-wal`) are working files; regenerate state with `db:migrate` + `db:seed` if it gets messy.
- UI is shadcn/ui ("new-york" style) in `app/components/ui/` + Tailwind 4. Add primitives via the `shadcn` CLI rather than hand-rolling.
