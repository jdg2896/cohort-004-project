# Domain notes

- **Roles:** `Student` / `Instructor` / `Admin`. Route groups mirror these: `courses.*` + `dashboard` (student), `instructor.*` (authoring), `admin.*` (moderation).
- **Comment moderation:** soft-delete with a tombstone — comments with replies are kept with `deletedAt`/`removalReason`; childless ones are hard-deleted. `commentModerationActions` is an append-only audit log whose `commentId` is intentionally not a FK so it survives hard deletes.
- **PPP pricing:** `app/lib/ppp.ts` adjusts course prices by country tier. In dev, the country can be overridden via the DevUI selector (stored in the session).
- **DevUI** (`app/components/dev-ui.tsx`, dev-only): switch the current user and override country for PPP testing.
- **User content rendering:** instructor markdown → `renderMarkdown` (Shiki highlighting); untrusted comment markdown → `renderCommentMarkdown` (sanitized). Don't cross these wires.
