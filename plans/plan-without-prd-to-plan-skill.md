# Implementation Plan — Instructor Analytics Dashboard

Derived from [`prd/instructor-analytics-dashboard.md`](./instructor-analytics-dashboard.md). This breaks the PRD into six dependency-ordered phases. Each phase is independently reviewable, ends green (`pnpm typecheck` + `pnpm test`), and lists the PRD user stories it satisfies.

---

## Grounding: what already exists

Confirmed by reading the codebase. New work plugs into these.

**Schema** (`app/db/schema.ts`):
- `enrollments` — has `userId`, `courseId`, `enrolledAt` (ISO text), `completedAt` (ISO text, **nullable, not yet auto-populated**).
- `purchases` — `userId`, `courseId`, `pricePaid` (integer cents, **already PPP-adjusted at purchase time**, includes team/seat purchases), `country`, `createdAt` (ISO text). No refund/fee concept.
- `courses` — `instructorId` (author), `price`, `pppEnabled`.
- `modules` — `courseId`, `position` (order within course).
- `lessons` — `moduleId`, `position` (order within module).
- `lessonProgress` — `userId`, `lessonId`, `status` (`not_started|in_progress|completed`), `completedAt`.
- `quizzes` — `lessonId`, `passingScore` (real, 0.0–1.0).
- `quizAttempts` — `userId`, `quizId`, `score` (real **0.0–1.0**, not a percentage), `passed` (bool), `attemptedAt`.

**Services** (`app/services/`):
- `enrollmentService.ts` — `getEnrollmentsByCourse`, `getEnrollmentCountForCourse`, `getCourseEnrolledStudents`, `isUserEnrolled`, and `markEnrollmentComplete(userId, courseId)` (**unconditional** setter; positional args).
- `progressService.ts` — `markLessonComplete(userId, lessonId)`, `calculateProgress(userId, courseId, includeQuizzes, weightByDuration)`, `getCompletedLessonCount(userId, courseId)`, `getTotalLessonCount(courseId)`.
- `purchaseService.ts`, `courseService.ts` (`getCoursesByInstructor`, `getCourseById`), `quizService.ts`, `quizScoringService.ts` (`getQuizStats` — **already uses raw aggregate SQL**, a good template), `userService.ts` (`getUserById`).

**Routes** (`app/routes.ts`, dotted-file convention):
- `instructor.tsx` (My Courses), `instructor.$courseId.tsx` (editor, has Students tab), `instructor.$courseId.students.tsx` (roster — **the access-control pattern to mirror**), `courses.$slug.lessons.$lessonId.tsx` (lesson view with the `mark-complete` action).

**UI**: shadcn/ui in `app/components/ui/`, icons from `lucide-react`, Tailwind v4. **No chart library** (hand-roll SVG, per PRD). Sidebar nav in `app/components/sidebar.tsx` (role-gated via `NavItem.roles`).

**Access-control pattern** (from `instructor.$courseId.students.tsx`): `getCurrentUserId(request)` → 401 if none; `getUserById` → 403 unless `Instructor`/`Admin`; load course → 404 if missing; 403 unless `course.instructorId === currentUserId || user.role === Admin`. Throw via `data("…", { status })`.

**Testing** (`docs/commands.md`, `app/test/setup.ts`): Vitest, `*.test.ts`, in-memory SQLite via `createTestDb()` + `seedBaseData()`, `db` mocked with `vi.mock("~/db", …)`. Single file: `pnpm vitest run app/services/analyticsService.test.ts`.

**Seed**: `scripts/seed.ts` (`pnpm db:seed`). DB is always regenerated — **no migration/backfill tooling needed**.

## Conventions checklist (apply in every phase)

- [ ] **Function params:** any new function with **>1 param of the same type** takes a single `opts` object (`{ userId, courseId }`), per the `function-parameters` skill. Existing positional setters predate this — see Phase 1.
- [ ] **Naming:** service `analyticsService.ts` (camelCase); components `kebab-case`; DB columns `snake_case` ↔ camelCase TS; constants `UPPER_SNAKE_CASE`.
- [ ] **Layering:** loaders/actions validate input (Zod via `app/lib/validation.ts` helpers) and do access-control; **all data access lives in services**; no business logic in routes.
- [ ] **No N+1:** use set-based aggregate queries (group/join), not per-student/per-lesson loops. Don't repeat the roster's redundant-query shape.
- [ ] **Service tests:** every service file has a `.test.ts` (`service-testing` skill).
- [ ] **After route/loader changes:** run `pnpm typecheck` (runs `react-router typegen` then `tsc`). Import route types from `./+types/<route-name>`.
- [ ] **Money:** display with `formatPrice` from `app/lib/utils.ts` (cents → `$X.XX`).
- [ ] **Server-only:** services touch SQLite; never import them into client components.

---

## Phase 1 — Completion signal (foundation)

**Goal:** Make course completion a real, maintained, set-once signal, so "completion rate" reflects reality. This is foundational — the completion metric in later phases reads this flag.

**Depends on:** nothing.

**Files**
- *Modify* `app/services/enrollmentService.ts` — add the set-once completion function (and, if absent, a `getEnrollment` row lookup by user+course).
- *Modify* `app/routes/courses.$slug.lessons.$lessonId.tsx` — call it right after `markLessonComplete` in the `mark-complete` action.
- *Modify* `app/services/enrollmentService.test.ts` — tests for the new function.
- *Modify* `scripts/seed.ts` — seed hygiene (below).

**Implementation**
- New function, set-once, one-way (enrollmentService → progressService for counts). The lesson-completion primitive (`markLessonComplete`) stays pure — no new side effects in it.

  ```ts
  // app/services/enrollmentService.ts
  // One-way, set-once milestone. No-op if: no enrollment, already complete,
  // course has zero lessons, or not all lessons complete.
  export function markEnrollmentCompleteIfFinished(opts: { userId: number; courseId: number }) {
    const { userId, courseId } = opts;
    const enrollment = getEnrollment({ userId, courseId });
    if (!enrollment || enrollment.completedAt) return;          // no enrollment / already set
    const total = getTotalLessonCount(courseId);
    if (total === 0) return;                                    // zero-lesson course
    if (getCompletedLessonCount({ userId, courseId }) < total) return;
    markEnrollmentComplete({ userId, courseId });               // stamps completedAt = now
  }
  ```
- **Convention note:** `getCompletedLessonCount`/`markEnrollmentComplete` currently use positional same-type args (pre-skill). Recommended: in this phase, migrate these few signatures to `opts` objects and update their call sites (small, contained), so the new code is consistent. If the ripple is undesirable, call them positionally and leave a TODO — but prefer the migration.
- Wire into the action (course already in scope):
  ```ts
  markLessonComplete(currentUserId, lessonId);
  markEnrollmentCompleteIfFinished({ userId: currentUserId, courseId: course.id });
  ```

**Seed hygiene** (PRD "Seed data"): any student whose enrollment has `completedAt` set **must** also have 100% lesson progress, so the completion tile (flag) and funnel/avg-progress (lesson rows) agree. Audit the existing 7 enrollments — today James is complete with all lessons done, but others have near-complete progress without the flag. Adjust the seed so the complete/incomplete demo set is internally consistent. No backfill tooling.

**Tests** (`enrollmentService.test.ts`)
- Marks complete when the final lesson finishes; stamps a timestamp.
- Idempotent / set-once: a second call (or progress later dropping below 100%) does **not** move or clear `completedAt`.
- No-op when course has zero lessons.
- No-op when the user has no enrollment.
- No-op when lessons remain incomplete.

**Acceptance criteria**
- Finishing the last lesson in the app flips the enrollment to complete automatically; re-running does nothing.
- Seed produces a state where the completion flag and lesson progress agree for every student.
- `pnpm test` + `pnpm typecheck` green.

**PRD stories:** 29, 30, 31 (and unblocks 5, 16, 35-completion-correctness).

---

## Phase 2 — Analytics service (data layer) + tests

**Goal:** One service owning all dashboard data via set-based aggregate queries. Loaders stay thin.

**Depends on:** Phase 1 (completion flag exists).

**Files**
- *New* `app/services/analyticsService.ts`
- *New* `app/services/analyticsService.test.ts`

**Two exported functions** (single param each → positional is fine per skill):

```ts
export function getInstructorPortfolioAnalytics(instructorId: number): PortfolioAnalytics
export function getCourseAnalytics(courseId: number): CourseAnalytics
```

**`PortfolioAnalytics`** (PRD "Metric definitions"):
- `totalEarnings` (cents) — `SUM(purchases.price_paid)` joined to the instructor's courses.
- `totalEnrollments` — `COUNT(enrollments)` across the instructor's courses.
- `distinctLearners` — `COUNT(DISTINCT enrollments.user_id)` across the instructor's courses (a learner in several of the instructor's courses counts once; intentionally differs from the enrollment sum).
- `avgCompletionRate` — mean completion rate across the instructor's courses.
- `revenueByWeek`, `enrollmentsByWeek` — zero-filled weekly series (see helper).
- `last7Days` — `{ enrollmentsDelta, revenueDelta }` headline.
- `courses[]` — comparison rows: `{ courseId, title, enrollments, earnings, completionRate, avgQuizScore }`, each linkable to the deep dive.

**`CourseAnalytics`** (PRD "Metric definitions"):
- `enrollments`, `earnings` (cents), `completionRate` (complete enrollments ÷ all enrollments), `avgProgress` (mean of lessons-only progress across enrolled students — compute **set-based**, not by looping `calculateProgress` per student).
- `revenueByWeek`, `enrollmentsByWeek` — zero-filled weekly series.
- `funnel[]` — lessons in **module-position then lesson-position** order, each `{ lessonId, title, completionShare }`; flag the lesson with the **largest decrease vs the previous lesson** as `biggestDropOff`. Non-monotonic funnels are an accepted caveat.
- `quizzes[]` — per quiz `{ quizId, title, passingScore, buckets, passRate, avgScore }` where `buckets` are fixed **0–50 / 50–70 / 70–90 / 90–100** over each student's **best** attempt (scores are 0.0–1.0 → thresholds 0.5/0.7/0.9), with the passing threshold available for the histogram marker.

**Weekly bucketing** (PRD "Time and trends"):
- Window ≈ last **12 weeks**; series **zero-filled** so empty weeks render as 0.
- Date-based grouping in the query (SQLite `strftime` over the ISO text timestamp columns `enrolled_at` / `created_at`); the full week window is generated in the service so gaps fill deterministically.
  ```ts
  function buildWeeklyBuckets(opts: { rows: { weekKey: string; value: number }[]; weeks: number }): WeeklyPoint[]
  ```
- `last7Days` deltas computed from the same timestamp data.

**Query discipline:** model the aggregates on `quizScoringService.getQuizStats` (raw aggregate SQL) or Drizzle group-by. One query per metric family; **no per-student/per-lesson loops**.

**`avgQuizScore` (comparison table) definition:** mean across the course of each student's best attempt per quiz. State this in a code comment so the number is reproducible.

**Tests** (`analyticsService.test.ts`, in-memory DB)
- Earnings sum (incl. team/seat purchase rows); `$0.00`/zero when no purchases.
- Enrollment count vs distinct learners diverge when a learner takes two of the instructor's courses.
- Completion rate from the flag; avg progress from lesson rows; the two can legitimately differ.
- Weekly series zero-fills empty weeks and spans the full window; `last7Days` deltas correct.
- Funnel ordering (module then lesson position) and biggest-drop flag (incl. a non-monotonic case).
- Quiz buckets land in correct ranges; pass rate vs `passingScore`; avg score.
- Edge cases: zero enrollments, zero lessons, no quizzes, no purchases — neutral/empty values, no divide-by-zero.

**Acceptance criteria**
- Both functions return correct values on seeded fixtures; aggregate queries only; tests green; `pnpm typecheck` green.

**PRD stories (data side):** 2–5, 6–9, 14–22, 36, 38 (+ the data behind 39).

---

## Phase 3 — Shared chart & stat UI components

**Goal:** Hand-rolled, server-rendered inline-SVG primitives shared by both pages. No new dependency.

**Depends on:** nothing (can run parallel to Phase 2; types align with Phase 2 outputs).

**Files** (`app/components/`, kebab-case)
- *New* `analytics-line-chart.tsx` — sparkline/line for weekly trends; renders the zero-filled series; lightweight hover tooltip.
- *New* `analytics-bar-chart.tsx` — horizontal bars for the lesson funnel; supports highlighting the biggest-drop bar.
- *New* `analytics-histogram.tsx` — quiz score distribution over the four fixed buckets, with a marker line at the passing threshold.
- *New* `analytics-stat-tile.tsx` — a metric tile (label, value, optional `last 7 days` delta), built on shadcn `Card`.

**Implementation notes**
- Pure presentational; all data from props (loader-provided). SSR-friendly inline SVG; interactivity limited to hover tooltips. Tailwind for styling, `lucide-react` for any small icons, `formatPrice` for money. Keep them reusable across both routes.

**Tests:** none required (presentational; not service files). Optional light render test only if convenient.

**Acceptance criteria:** components render from static props in isolation (e.g., a temporary DevUI/story or a throwaway route) with correct shapes, the biggest-drop highlight, and the threshold marker; `pnpm typecheck` green.

**PRD stories (presentation side):** 6, 7, 19, 20, 21, 23, 38.

---

## Phase 4 — Per-course deep-dive page

**Goal:** A dedicated analytics page per course with totals, trends, funnel, quizzes, and a link to the roster — access-controlled like the roster.

**Depends on:** Phases 2 (service) and 3 (charts).

**Files**
- *New* `app/routes/instructor.$courseId.analytics.tsx`
- *Modify* `app/routes.ts` — register `route("instructor/:courseId/analytics", "routes/instructor.$courseId.analytics.tsx")`.

**Loader**
- Access control mirrors the roster exactly: 401 if no `currentUserId`; 403 unless `Instructor`/`Admin`; validate `courseId` (Zod via `parseParams`) → 404 if missing; **403 unless `course.instructorId === currentUserId || role === Admin`** (admins may open any course, per PRD #34).
- Call `getCourseAnalytics(courseId)`; return its shape (fully typed via `./+types/instructor.$courseId.analytics`).

**Component**
- Stat tiles: enrollments, earnings (`formatPrice`), completion rate, avg progress.
- Weekly revenue + enrollment line charts.
- Lesson funnel (bar chart) with the biggest-drop lesson highlighted.
- Per-quiz histograms with pass rate, avg score, and the passing-threshold marker.
- A link to the existing roster (`/instructor/:courseId/students`) — roster kept as-is.
- **Empty states:** no enrolled students → neutral placeholder + empty state (no divide-by-zero); no lessons → suppress funnel with an explanation; no quizzes → hide the quiz section; no purchases → earnings reads `$0.00`.
- `ErrorBoundary` for the thrown `data(...)` responses.

**Acceptance criteria**
- Owner and admin can view; non-owner instructor gets 403; logged-out/non-instructor gets a clear denial.
- All four empty states behave as specified.
- `pnpm typecheck` + `pnpm test` green.

**PRD stories:** 13–28, 32–34, 35 (per-course), 37, 38.

---

## Phase 5 — Portfolio overview page + navigation wiring

**Goal:** The cross-course overview and the navigation that makes both pages reachable.

**Depends on:** Phases 2, 3, 4 (comparison rows link into the deep dive).

**Files**
- *New* `app/routes/instructor.analytics.tsx`
- *Modify* `app/routes.ts` — register `route("instructor/analytics", "routes/instructor.analytics.tsx")`. **Order/specificity note:** static `instructor/analytics` must resolve over dynamic `instructor/:courseId`; React Router v7 ranks static segments higher, but verify the analytics route wins (a course can't be named "analytics" since `:courseId` is numeric, so this is safe).
- *Modify* `app/components/sidebar.tsx` — add an `Analytics` `NavItem` → `/instructor/analytics`, gated `roles: [UserRole.Instructor]`, with a `lucide-react` icon (e.g. `BarChart3`).
- *Modify* `app/routes/instructor.tsx` (My Courses cards) and `app/routes/instructor.$courseId.tsx` (editor) — link into per-course analytics (`/instructor/:courseId/analytics`).

**Loader**
- 401 if no user; 403 unless `Instructor` (role gate). Scope strictly to **the current user's authored courses** (`getCoursesByInstructor(currentUserId)`); an admin sees only courses they authored (often none). No platform-wide super-view.
- Call `getInstructorPortfolioAnalytics(currentUserId)`.

**Component**
- Totals tiles (earnings, enrollments, distinct learners, avg completion) + `last 7 days` deltas.
- Weekly revenue + enrollment line charts.
- **Sortable** per-course comparison table (enrollments, earnings, completion rate, avg quiz score); each row links to that course's deep dive. Client-side column sort (allowed lightweight interactivity).
- **Empty state:** instructor with no courses → friendly prompt to create the first course (no broken page).

**Acceptance criteria**
- Sidebar shows Analytics only for instructors; overview loads scoped to the viewer's courses; comparison table sorts by any column and links into deep dives; new-instructor empty state renders.
- `pnpm typecheck` + `pnpm test` green.

**PRD stories:** 1–12, 32, 35 (portfolio), 37, 38.

---

## Phase 6 — Verification, performance & polish

**Goal:** Confirm correctness end-to-end and that the dashboard stays fast as data grows.

**Depends on:** Phases 1–5.

**Tasks**
- Full suite: `pnpm test` and `pnpm typecheck` clean.
- **Performance** (PRD #39): confirm loaders issue a bounded number of aggregate queries (no per-student/per-lesson loops); spot-check query count against a course with many students/lessons.
- **Consistency** (accepted trade-off): verify the completion tile (flag) and funnel/avg-progress (lesson rows) agree on seed data; document the known divergence when an instructor adds lessons after students finish.
- **Manual verification** via the app + DevUI (`pnpm dev`, switch to an instructor user, override country for a PPP purchase if needed): walk both pages, every empty state, the funnel highlight, the quiz threshold marker, table sorting, and access denials (non-owner instructor, logged-out).
- Money formatting and zero-filled trends visually correct.

**Acceptance criteria:** all PRD user stories demonstrably satisfied; both pages load quickly; tests + typecheck green.

---

## Cross-cutting concerns

**Access control** (mirror the roster):
| Surface | Rule |
| --- | --- |
| Per-course analytics | course owner **or** admin; else 403. 401 if logged out; 403 if not instructor/admin. |
| Portfolio overview | scoped to the viewer's own authored courses; instructor-gated. No admin super-view. |

**Charting:** hand-rolled inline SVG, server-rendered from loader data, no new dependency; interactivity limited to hover tooltips (+ client-side table sort on the overview).

**Edge cases** (must all be handled): zero enrolled students (neutral placeholder, no divide-by-zero), zero lessons (funnel suppressed + explanation), no quizzes (section hidden), no purchases (`$0.00`), new instructor with no courses (friendly empty state).

## Risks & accepted trade-offs (from the PRD)

- **Non-monotonic funnel:** out-of-order completion or optional/bonus lessons can show a false "cliff." The biggest-drop highlight is a heuristic, not a guarantee. Accepted for v1.
- **Completion vs lesson-level divergence:** completion is set-once; funnel/avg-progress are live. Adding lessons after students finish can make them disagree. Accepted (completion is a historical milestone).
- **Distinct learners ≠ sum of enrollments** whenever learners take multiple of the instructor's courses. Both shown intentionally.
- **No backfill tooling** — DB is regenerated from seed; not applicable outside production.

## Out of scope (do not build)

Date-range picker that recomputes metrics; within-video drop-off; per-question quiz difficulty; ratings/reviews analytics; platform-wide admin super-view; net-of-fee/refund earnings; quizzes gating completion; bidirectional completion sync; completion notifications.

## Sequencing summary

```
Phase 1 (completion signal) ─┐
                             ├─> Phase 2 (analytics service) ─┐
Phase 3 (chart components) ──┘ (parallel-ok)                  ├─> Phase 4 (per-course page) ─> Phase 5 (overview + nav) ─> Phase 6 (verify)
```

Phase 3 can proceed in parallel with Phase 1/2. Phases 4→5→6 are strictly sequential. Run `pnpm typecheck` after any route/loader change and `pnpm test` after any service change.
