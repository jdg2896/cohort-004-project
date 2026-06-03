# AGENTS.md

**Cadence** is a single-package React Router v7 (SSR) course platform (a mini Udemy) backed by SQLite via Drizzle ORM — the exercise repo for the "AI Coding for Real Engineers with Claude Code" cohort.

## Essentials

- **Package manager:** pnpm (not npm).
- **Path alias:** `~/` → `app/` (e.g. `import { getUserById } from "~/services/userService"`).
- **Strict layering:** Routes (HTTP) → Services (data + business logic) → Database. Keep business logic out of routes. See [docs/architecture.md](docs/architecture.md).
- **After route/loader changes, run `pnpm typecheck`** (runs `react-router typegen` then `tsc`).

```bash
pnpm dev          # Dev server at http://localhost:5173
pnpm typecheck    # Run after route/loader changes
pnpm test         # Run all tests once (Vitest)
```

## Deeper docs

Read these on demand for the task at hand:

- [docs/architecture.md](docs/architecture.md) — the three layers and the conventions that span files (validation, auth, server-only code, route types).
- [docs/domain.md](docs/domain.md) — roles, comment moderation, PPP pricing, DevUI, user-content rendering.
- [docs/commands.md](docs/commands.md) — single-test runs and the destructive cohort lesson commands (scripts themselves live in `package.json`).
- [docs/gotchas.md](docs/gotchas.md) — environment notes and traps (Ably, `data.db`, shadcn/ui).
