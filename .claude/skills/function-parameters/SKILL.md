---
name: function-parameters
description: Cadence convention for declaring function parameters in TypeScript. Use when writing or editing a function, method, or arrow function that takes more than one parameter, or when reviewing a signature with multiple same-typed positional args.
---

# Function Parameters

## Rule

When a function has **more than one parameter of the same type**, use a single
object parameter instead of positional parameters. This prevents call sites from
silently swapping arguments.

```ts
// BAD — two strings, easy to pass in the wrong order
const addUserToPost = (userId: string, postId: string) => {};
addUserToPost(postId, userId); // compiles, but wrong

// GOOD — named keys make the call self-documenting
const addUserToPost = (opts: { userId: string; postId: string }) => {};
addUserToPost({ userId, postId });
```

## When it does NOT apply

- A single parameter: `const getUserById = (id: string) => {}` — fine as-is.
- Multiple parameters of **distinct** types where order is unambiguous, e.g.
  `(user: User, count: number)`. Object params are still allowed, but not required.

## Applying it

- Name the object `opts` (or a more specific noun when it reads better).
- Destructure in the body if it improves clarity: `({ userId, postId }) => {...}`.
- Update all call sites to pass an object literal.
