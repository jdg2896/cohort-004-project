# Architecture

Three layers, strictly separated:

1. **Routes** (`app/routes/`) handle HTTP — loaders (read), actions (write), and the React component. They validate input and call services. Routes are **explicitly registered in `app/routes.ts`** (not auto file-discovered), though filenames follow the dotted convention (`courses.$slug.lessons.$lessonId.tsx`).
2. **Services** (`app/services/`) hold all data access and business logic. One file per domain (`userService.ts`, `courseService.ts`, `enrollmentService.ts`, etc.). Functions take **positional params** and return Drizzle query results directly. This is where new business logic belongs — keep it out of routes.
3. **Database** (`app/db/`) — `schema.ts` is the single source of truth (all tables + enums like `UserRole`, `CourseStatus`); `index.ts` is the better-sqlite3 connection (WAL mode, FKs on).

## Conventions that span files

- **Path alias:** `~/` → `app/` (e.g. `import { getUserById } from "~/services/userService"`).
- **Server-only code:** suffix `.server.ts` (e.g. `markdown.server.ts`, `country.server.ts`). Import these only from loaders/actions, never from components. Services are server-only by convention (they touch SQLite).
- **Validation:** Zod schemas defined locally in each route. Parse with the helpers in `app/lib/validation.ts` — `parseFormData` / `parseJsonBody` return `{ success, data | errors }`; `parseParams` throws a 400.
- **Multi-action forms:** routes with several mutations use a Zod `discriminatedUnion("intent", …)` and branch on `intent` in the action.
- **Auth:** cookie session via `app/lib/session.ts`. Get the user with `getCurrentUserId(request)` then `getUserById(...)`. Role gating is done inline in each loader/action by throwing `data("…", { status: 403 })`. There is no global auth middleware — protected routes live under the `layout("routes/layout.app.tsx", …)` group but still check the session themselves.
- **Route types:** import generated types as `import type { Route } from "./+types/<route-name>"`. Run `pnpm typecheck` (which runs `typegen` first) after adding/changing routes.
