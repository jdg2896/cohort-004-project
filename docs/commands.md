# Commands

The canonical script list lives in `package.json` (`scripts`) — read it there rather than trusting a copy. The common ones: `pnpm dev`, `pnpm build`, `pnpm start`, `pnpm typecheck`, `pnpm test` / `pnpm test:watch`, and `pnpm db:generate` / `db:migrate` / `db:seed`.

This file only documents what `package.json` *can't* tell you.

## Running a subset of tests

Not defined as scripts — invoke Vitest directly:

- Single file: `pnpm vitest run app/services/courseService.test.ts`
- By test name: `pnpm vitest run -t "enrollment"`

## Cohort lesson navigation — ⚠️ rewrites your working tree

These run `ai-hero-cli` against the upstream course repo and **reset/modify your working tree** — don't run them with uncommitted work you want to keep:

- `pnpm reset <commit>` — jump to a lesson checkpoint.
- `pnpm cherry-pick <commit>` — pull a lesson's solution.
- `pnpm pull` — pull updates from upstream.
