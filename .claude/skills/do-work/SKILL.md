---
name: do-work
description: Take a discrete piece of work from plan to committed code — plan it, implement it, drive it green with pnpm typecheck and pnpm test, then commit. Use when the user invokes /do-work, or asks you to fully own a task end-to-end (plan, implement, verify, commit) rather than just sketch an approach.
---

# Do Work

Own one discrete piece of work end-to-end: **plan → implement → verify (green) → commit**.
Run autonomously through all four steps, but **pause and ask when uncertain** (see the gate in step 1).

## Workflow

### 1. Plan

1. Explore the relevant code so the plan reflects reality, not assumptions.
2. Lay out a short plan **inline in the conversation** — the goal, the files/layers you'll touch, the approach, and how you'll verify it. Don't write a plan file by default; the steps below already structure the work. Only for heavy or multi-step work, save a scratch plan to `/tmp/<kebab-slug>-plan.md` to track progress. (For a full multi-phase PRD breakdown, use the `prd-to-plan` skill instead.)
3. **Uncertainty gate** — pause and ask the user before implementing if any of these hold:
   - The request is ambiguous or could be read multiple ways.
   - The change is risky or hard to reverse (schema/data migrations, auth, deletions, public-facing behavior).
   - It sprawls across many files or layers and scope is unclear.

   Otherwise, proceed straight to step 2.

### 2. Implement

- Follow the plan and the repo's conventions in `AGENTS.md` / `docs/`.
- **Load the skills that match what you're touching** (e.g. `naming-conventions`, `function-parameters`, `service-testing`). New/edited service files need tests.
- Respect the layering: Routes → Services → Database. Keep business logic out of routes.

### 3. Feedback loop (drive it green)

Run both checks and fix what they surface:

```bash
pnpm typecheck   # react-router typegen && tsc — run after any route/loader change
pnpm test        # vitest run
```

- **Cap at 10 fix-and-rerun cycles.** If it's still red after that, stop and report what's failing, what you tried, and your best hypothesis — do **not** commit red code or paper over failures (no skipped tests, no loosened types to dodge an error).

### 4. Commit

Only once `pnpm typecheck` and `pnpm test` both pass:

- If on the default branch (`main`), create a feature branch first.
- Stage only the files this work touched (the scratch plan in `/tmp`, if any, stays out of the commit).
- Write a [Conventional Commit](https://www.conventionalcommits.org/) message (`feat:`, `fix:`, `docs:`, `refactor:`, …) describing the change, and end it with the harness `Co-Authored-By:` trailer.
- Report the commit hash and a one-line summary of what landed.
