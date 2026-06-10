---
name: service-testing
description: Cadence rule that service files require accompanying tests. Use when creating or editing a file named like a service (e.g. userService.ts, authService.ts), adding a function to a service, or when a service lacks a .test.ts file.
---

# Service Testing

## Rule

Any file whose name marks it as a **service** (`authService.ts`,
`userService.ts`, `bookmarkService.ts`, …) must have tests in an accompanying
`.test.ts` file alongside it.

```
app/services/authService.ts
app/services/authService.test.ts   ← required
```

## Workflow

When you create a new service or add/modify exported functions in one:

1. Create or open the matching `<serviceName>.test.ts` in the same directory.
2. Cover each exported function — happy path plus the meaningful edge cases
   (not-found, unauthorized, constraint violations, etc.).
3. Run the tests:

   ```bash
   pnpm test                              # all tests
   pnpm test app/services/authService     # one service (Vitest filter)
   ```

4. Tests must pass before the work is considered done.

## Notes

- Tests use Vitest. Look at an existing `*.test.ts` for the setup/fixtures
  pattern used in this repo (e.g. `bookmarkService.test.ts`).
- This applies to the service layer specifically — routes and components don't
  carry the same hard requirement.
