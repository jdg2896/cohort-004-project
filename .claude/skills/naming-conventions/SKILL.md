---
name: naming-conventions
description: Cadence naming rules for code identifiers, file names, and database columns. Use when creating a new file, naming a variable/function/type/component/constant, adding a Drizzle column, or deciding what to call something in this repo.
---

# Naming Conventions

## Code identifiers

- `camelCase` — variables, functions, object properties.
- `PascalCase` — types, enums, React components.
- `UPPER_SNAKE_CASE` — constants.

## File names

- **Components:** `kebab-case` — `user-avatar.tsx`.
- **Services:** `camelCase` — `userService.ts`, `authService.ts`.
- **Routes:** follow React Router's dotted convention (e.g. `courses.$courseId.tsx`).

## Database (Drizzle)

- SQL column names are `snake_case` — `avatar_url`.
- The TypeScript property is `camelCase` — `avatarUrl`.
- Drizzle maps between the two; declare both explicitly in the schema:

```ts
avatarUrl: text("avatar_url"),
```

## Quick check

Before naming something, ask: *what kind of thing is it?* (identifier vs file vs
column) and *which category?* (component vs service vs constant). Pick the case
from the matching rule above.
