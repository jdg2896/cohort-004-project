# Plan: Instructor Analytics Dashboard

> Source PRD: `prd/instructor-analytics-dashboard.md`

## Architectural decisions

Durable decisions that apply across all phases:

- **Routes**:
  - Portfolio overview: `/instructor/analytics` (the sidebar "Analytics" destination; static segment, so it sits alongside `/instructor/:courseId` the same way `/instructor/new` already does).
  - Per-course deep dive: `/instructor/:courseId/analytics` (sits beside the existing `/instructor/:courseId/students` roster).
- **Schema**: No migration. Reuse the existing nullable `enrollments.completedAt` (ISO 8601 text) as the maintained completion signal — today it exists but nothing sets it. All other needed columns already exist: `purchases.pricePaid` (integer cents, already PPP-adjusted, already includes team/seat purchases), `lesson_progress` (status enum + `completedAt`), `quizzes.passingScore` (real, 0–1), `quiz_attempts` (`score` real 0–1, `passed` boolean, `attemptedAt`), `modules.position` + `lessons.position` for funnel ordering. Timestamps are ISO 8601 strings, so weekly grouping uses date-based grouping on those text columns.
- **Key models / services**:
  - A new **analytics service** owns all dashboard reads, using **set-based aggregate queries** (counts, sums, group-by, joins, `inArray`) — never per-student/per-lesson loops. It exposes one function for the portfolio overview and one for the per-course deep dive. Service files are tested (repo convention).
  - **Completion wiring** adds one function to the existing **enrollment service**: given a user and course, if the user has completed all the course's lessons and the enrollment is not already complete, mark it complete with a timestamp. One-way, set-once; no-op for zero-lesson courses or users without an enrollment. This introduces a one-way dependency from the enrollment service to the progress service (for lesson counts). The lesson-completion primitive stays pure.
- **Access control**: Per-course analytics mirror the roster's inline 3-layer guard — authenticated (401) → instructor-or-admin role (403) → course owner or admin (403). The portfolio overview is scoped to the current user's own authored courses (an admin sees only courses they authored). No platform-wide super-view.
- **Charting**: Hand-rolled inline SVG, rendered server-side from loader data, no new dependency. A line/sparkline component for trends (born in Phase 3) and a bar component for the funnel and quiz histograms (born in Phase 4). Interactivity limited to lightweight hover tooltips.
- **Performance (cross-cutting, Story 39)**: Every data phase (2–6) must use set-based aggregate queries rather than reproducing the roster's N+1 per-student loop. This lands as an acceptance criterion on each of those phases rather than as its own phase.
- **Money & trends conventions**: Earnings are the gross sum of `purchases.pricePaid` (cents), displayed with the existing `formatPrice()` helper; no net-of-fee or refund concept. Trends are bucketed weekly over ~12 weeks with a "last 7 days" headline delta, and series are **zero-filled** across the full window so empty weeks render as zero (week window computed in the service for deterministic gap-filling).

---

## Phase 1: Completion tracking signal

**User stories**: 29, 30, 31

### What to build

When a student marks the last remaining lesson of a course complete, their enrollment is automatically marked complete. Add a function to the enrollment service that, given a user and course, checks whether the user has completed all of that course's lessons and — if so, and the enrollment is not already complete — sets `completedAt` once. It never moves or clears an existing timestamp, and does nothing for courses with zero lessons or users without an enrollment. The existing lesson "mark complete" action calls this immediately after marking the lesson (the course is already in scope there). The lesson-completion primitive itself gains no new side effects.

Seed hygiene: any student the seed marks complete must also have their lesson progress seeded to 100%, so the completion tile (from the flag) and the funnel / average-progress (from lesson progress) agree on demo data.

### Acceptance criteria

- [ ] Completing the final lesson of a course sets that enrollment's `completedAt` (verifiable in the DB / a follow-up read).
- [ ] Completing a non-final lesson leaves `completedAt` null.
- [ ] Re-completing lessons after completion does not change the original `completedAt` (set-once).
- [ ] No enrollment, or a course with zero lessons, is a safe no-op (no error, no write).
- [ ] The lesson-completion primitive still only sets the lesson's status (no new side effects in it).
- [ ] Seeded "complete" students also have 100% lesson progress in the seed.
- [ ] New enrollment-service function has accompanying tests covering: completes on last lesson, no-op when partial, idempotent when already complete, no-op with zero lessons / no enrollment.

---

## Phase 2: Per-course foundation (route, access control, snapshot tiles)

**User stories**: 13, 14, 15, 16, 17, 24, 25, 28, 32, 33, 34, 35, 36, 37

### What to build

The per-course analytics route at `/instructor/:courseId/analytics`, guarded exactly like the roster (owner or admin; forbidden with a clear message otherwise; clear denial for logged-out / non-instructor users). The new analytics service exposes its per-course function returning the course's snapshot numbers. The page renders four headline tiles: enrollment count, total earnings (currency-formatted, `$0.00` when there are no purchases), completion rate (from the maintained completion flag), and average progress (mean of the existing lessons-only progress calc) as its companion. Earnings reflect actual amounts paid including team/seat purchases. When the course has no enrolled students, completion/earnings render as a neutral empty state rather than dividing by zero. The page links to the existing student roster, and the course editor gains a link into this analytics page.

### Acceptance criteria

- [ ] `/instructor/:courseId/analytics` is reachable and renders for the course owner and for an admin.
- [ ] A non-owner instructor gets a forbidden response; a logged-out / non-instructor user gets a clear denial message.
- [ ] Tiles show enrollment count, earnings, completion rate, and average progress for the course.
- [ ] Earnings sum actual `pricePaid` (cents), include team/seat purchases, and display via `formatPrice()`; a course with no purchases shows `$0.00`, not an error.
- [ ] Completion rate is derived from `enrollments.completedAt`; average progress uses the existing lessons-only calculation.
- [ ] A course with zero enrolled students shows a neutral empty state (no divide-by-zero).
- [ ] The page links to `/instructor/:courseId/students`; the course editor links to the analytics page.
- [ ] The analytics service's per-course function uses set-based aggregate queries (no per-student loop) and has accompanying tests, including the zero-students and no-purchases cases.

---

## Phase 3: Per-course weekly trends

**User stories**: 18, 38

### What to build

Weekly revenue and enrollment trend charts on the per-course page, covering roughly the last twelve weeks. The analytics service computes the week window and zero-fills it so weeks with no activity render as zero rather than being skipped. Introduce the reusable inline-SVG line/sparkline chart component, rendered server-side from loader data with lightweight hover tooltips.

### Acceptance criteria

- [ ] The per-course page shows a weekly revenue trend and a weekly enrollment trend over the ~12-week window.
- [ ] Weeks with no purchases/enrollments render as zero (series is zero-filled across the full window).
- [ ] Charts are hand-rolled inline SVG rendered server-side; no charting dependency is added.
- [ ] Weekly buckets come from set-based date grouping in the service; the window is computed in the service for deterministic gap-filling.
- [ ] Service tests cover zero-filling (an empty week appears as zero) and correct weekly bucketing.

---

## Phase 4: Per-course lesson-completion funnel

**User stories**: 19, 20, 26

### What to build

A lesson-completion funnel listing the course's lessons in module-then-lesson order, each showing the share of enrolled students who completed it. The lesson with the largest decrease versus the previous lesson is flagged as the biggest drop-off. When the course has no lessons, the funnel is suppressed with an explanation instead of showing a meaningless chart. Introduce the reusable inline-SVG bar chart component. (Non-monotonic funnels from out-of-order/optional lessons are an accepted caveat; the biggest-drop highlight is a heuristic.)

### Acceptance criteria

- [x] The funnel lists lessons in module→lesson order with each lesson's completion share across enrolled students.
- [x] The single largest drop from the previous lesson is visually flagged as the biggest drop-off.
- [x] A course with no lessons suppresses the funnel and shows an explanation.
- [x] Completion shares are computed with set-based aggregate queries (no per-lesson or per-student loop).
- [x] Service tests cover ordering, the biggest-drop computation, and the zero-lessons suppression.

---

## Phase 5: Per-course quiz score distributions

**User stories**: 21, 22, 23, 27

### What to build

A per-quiz score distribution section: for each quiz in the course, a histogram of students' best attempts bucketed into fixed bands (0–50 / 50–70 / 70–90 / 90–100), with the quiz's passing threshold marked on the histogram, plus the quiz's pass rate and average score. When the course has no quizzes, the entire section is hidden.

### Acceptance criteria

- [x] Each quiz shows a histogram of students' best attempts in the fixed 0–50 / 50–70 / 70–90 / 90–100 buckets.
- [x] The passing threshold is marked on each histogram.
- [x] Each quiz shows its pass rate and average score.
- [x] A course with no quizzes hides the quiz section entirely.
- [x] "Best attempt" per student per quiz and the bucket counts are computed with set-based aggregate queries (no per-student loop).
- [x] Service tests cover bucketing, best-attempt selection, pass rate / average, and the no-quizzes case.

---

## Phase 6: Portfolio overview

**User stories**: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12

### What to build

The cross-course portfolio page at `/instructor/analytics`, plus a new instructor-gated "Analytics" item in the sidebar pointing at it. The analytics service exposes its portfolio function (scoped to the current user's authored courses). The page shows aggregate tiles — total earnings, total enrollments, distinct learners (each person counted once across the instructor's courses), and average completion across courses — a "last 7 days" headline delta on enrollments and revenue, and weekly revenue and enrollment trend charts (reusing the Phase 3 line component, zero-filled). Below that, a per-course comparison table with each course's enrollments, earnings, completion rate, and average quiz score, sortable by any column, with each row linking to that course's deep-dive analytics. A new instructor with no courses sees a friendly empty state guiding them to create their first course.

### Acceptance criteria

- [x] `/instructor/analytics` renders for an instructor and is scoped to courses they authored (an admin sees only their own authored courses).
- [x] A new instructor-gated "Analytics" sidebar item links to `/instructor/analytics`.
- [x] Tiles show total earnings, total enrollments, distinct learners (deduped across the instructor's courses), and average completion.
- [x] A "last 7 days" delta is shown for enrollments and revenue.
- [x] Weekly revenue and enrollment trend charts render, zero-filled, reusing the line component.
- [x] The comparison table shows per-course enrollments, earnings, completion rate, and average quiz score; is sortable by any column; and each row links to `/instructor/:courseId/analytics`.
- [x] An instructor with no courses sees a friendly empty state pointing to course creation.
- [x] The portfolio service function uses set-based aggregate queries (no per-course/per-student loop) and has accompanying tests, including the distinct-learners dedup and the no-courses case.
