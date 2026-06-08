# Instructor Analytics Dashboard

## Problem Statement

Instructors on Cadence can author courses and see a flat student roster per course, but they have no way to understand how their courses are actually performing. Today an instructor can see a raw enrollment count on the "My Courses" cards and a per-student progress table on the roster, but they cannot answer the questions that actually drive their decisions:

- How many people are enrolled across everything I teach, and is that growing?
- How much money am I making, and is it trending up or down?
- Are students actually finishing my courses, or stalling partway through?
- How are students doing on my quizzes — are they too hard, too easy, or about right?
- Which specific lesson is the one where students give up?

Without these answers, an instructor is flying blind: they can't tell a healthy course from a struggling one, can't spot the lesson that's bleeding students, and can't see whether their work is paying off financially.

## Solution

Give instructors a two-level analytics experience.

A **portfolio overview** answers "how is my whole teaching business doing?" — total earnings, total enrollments, distinct learners, and average completion across all the instructor's courses, with weekly revenue and enrollment trends, and a sortable per-course comparison table that links into each course.

A **per-course deep dive** answers "how is this specific course doing, and where is it failing?" — its enrollments, earnings, completion rate, and average progress; weekly revenue and enrollment trends; a lesson-by-lesson completion funnel that highlights the single biggest drop-off point; and a per-quiz score distribution with pass rates. From there the instructor can jump to the existing per-student roster for individual detail.

Underpinning the completion metric, course completion becomes a real, maintained signal: when a student finishes the last lesson of a course, their enrollment is automatically marked complete, so "completion rate" reflects reality rather than a flag nothing ever set.

## User Stories

### Portfolio overview

1. As an instructor, I want a single Analytics destination in my sidebar, so that I can reach my numbers without digging through individual courses.
2. As an instructor, I want to see my total earnings across all my courses, so that I know what my teaching is worth in aggregate.
3. As an instructor, I want to see my total number of enrollments across all courses, so that I understand my overall reach.
4. As an instructor, I want to see my number of distinct learners (people, counted once even if enrolled in several of my courses), so that I can tell repeat audience from raw enrollment volume.
5. As an instructor, I want to see my average completion rate across courses, so that I have a one-glance health signal for my catalog.
6. As an instructor, I want a weekly revenue trend chart, so that I can see whether my income is rising or falling over the last few months.
7. As an instructor, I want a weekly enrollment trend chart, so that I can see whether interest in my courses is growing.
8. As an instructor, I want a headline "last 7 days" delta on enrollments and revenue, so that I can gauge very recent momentum at a glance.
9. As an instructor, I want a per-course comparison table showing each course's enrollments, earnings, completion rate, and average quiz score, so that I can rank my courses and spot the weak ones.
10. As an instructor, I want to sort that comparison table by any column, so that I can quickly find my best earner or worst completer.
11. As an instructor, I want each course row to link to that course's deep-dive analytics, so that I can investigate a course that looks off.
12. As a new instructor with no courses yet, I want a friendly empty state on the overview, so that I'm guided to create my first course instead of seeing a broken page.

### Per-course deep dive

13. As an instructor, I want a dedicated analytics page for each of my courses, so that I can focus on one course's performance at a time.
14. As an instructor, I want to see the enrollment count for a course, so that I know how many students it has reached.
15. As an instructor, I want to see total earnings for a course, so that I know which course is paying off.
16. As an instructor, I want to see the completion rate for a course (share of enrolled students who finished every lesson), so that I know if students reach the end.
17. As an instructor, I want to see the average progress across enrolled students as a companion to completion rate, so that I can tell "nobody finishes but everyone gets 80% through" from "students drop almost immediately."
18. As an instructor, I want weekly revenue and enrollment trend charts for the course, so that I can see its trajectory rather than just a snapshot.
19. As an instructor, I want a lesson-completion funnel that lists my lessons in course order with the share of students who completed each, so that I can see where students fall off.
20. As an instructor, I want the funnel to highlight the lesson with the single biggest drop from the previous lesson, so that I immediately know which lesson to fix first.
21. As an instructor, I want a score distribution for each quiz in the course (a histogram of students' best attempts), so that I can see whether the quiz is well-calibrated.
22. As an instructor, I want each quiz's pass rate and average score, so that I can judge difficulty at a glance.
23. As an instructor, I want the quiz histogram to mark the passing threshold, so that I can see how many students land below it.
24. As an instructor, I want a link from the analytics page to the existing student roster, so that I can drop into per-student detail when a number raises a question.
25. As an instructor viewing a course with no enrolled students, I want a clear empty state, so that I don't misread an empty dashboard as broken.
26. As an instructor viewing a course with no lessons, I want the funnel to be suppressed with an explanation, so that I'm not shown a meaningless chart.
27. As an instructor viewing a course with no quizzes, I want the quiz section hidden, so that the page stays relevant.
28. As an instructor with a brand-new course that has no purchases, I want earnings to read as $0.00 rather than an error, so that the page is trustworthy.

### Completion tracking (enabling the completion metric)

29. As a student, I want my enrollment to be automatically marked complete when I finish the last lesson of a course, so that my completion is recognized without any manual step.
30. As an instructor, I want completion to be recorded the first time a student reaches 100% of lessons and then stay fixed, so that completion reads as a stable historical milestone.
31. As an instructor, I want completion rate to be based on this maintained completion signal, so that the number I see reflects real student behavior.

### Access control

32. As an instructor, I want to see analytics only for the courses I authored, so that I'm not exposed to other instructors' data.
33. As an instructor, I want to be blocked from another instructor's per-course analytics, so that course data stays private to its owner.
34. As an admin, I want to be able to open any course's per-course analytics, so that I can support and oversee instructors, consistent with how the roster already works.
35. As a logged-out or non-instructor user, I want to be denied access to the instructor analytics pages with a clear message, so that the boundary is obvious.

### Trust and correctness

36. As an instructor, I want earnings to reflect the actual amounts students paid (after purchasing-power-parity adjustment) and to include team/seat purchases, so that the figure matches reality.
37. As an instructor, I want money displayed in proper currency formatting, so that the numbers are readable.
38. As an instructor, I want trend charts to show empty weeks as zero rather than skipping them, so that gaps in activity are visible instead of hidden.
39. As an instructor, I want analytics pages to load quickly even with many students and lessons, so that the dashboard stays usable as a course grows.

## Implementation Decisions

### Surfaces and navigation

- Two new pages: a cross-course portfolio overview and a per-course deep dive, each as its own route under the instructor area.
- A new instructor-gated "Analytics" item is added to the sidebar, pointing at the portfolio overview.
- The portfolio comparison table and the course editor both link into the per-course analytics page.
- The existing per-student roster is kept as-is and serves as the per-student drill-down; the per-course analytics links to it. The roster is not merged or replaced.

### Metric definitions

- **Enrollments:** count of enrollment rows for the course; portfolio total is the sum across the instructor's courses.
- **Distinct learners (portfolio):** count of distinct users across all the instructor's enrollments, so a learner enrolled in multiple of the instructor's courses is counted once.
- **Earnings:** gross sum of recorded purchase amounts (stored in cents, displayed as currency). This already reflects purchasing-power-parity-adjusted prices and already captures team/seat purchases at purchase time. There is no net-of-fee or refund concept, because none exists in the data model.
- **Completion rate:** share of enrolled students whose enrollment is marked complete, over all enrolled students. Average progress (mean of the existing lessons-only progress calculation across enrolled students) is shown as a companion.
- **Drop-off funnel:** the course's lessons in module-then-lesson order; for each lesson, the share of enrolled students who completed it; the lesson with the largest decrease versus the previous lesson is flagged as the biggest drop-off. Robust to out-of-order completion as a known caveat.
- **Quiz score distribution:** per quiz, a bucketed histogram of each student's best attempt, plus pass rate and average score. Buckets are fixed at 0–50 / 50–70 / 70–90 / 90–100, with the quiz's passing threshold marked.

### Time and trends

- The dashboard shows all-time totals plus trend charts.
- Trends are bucketed weekly over roughly the last twelve weeks, with a "last 7 days" headline delta.
- Trend series are zero-filled across the full window so empty weeks render as zero.
- Weekly grouping is done in the data layer using date-based grouping on the existing timestamp columns; the week window is computed in the service so gaps can be filled deterministically.

### Charting

- Charts are hand-rolled inline SVG components (a sparkline/line for trends and a bar style for the funnel and quiz histograms), rendered server-side from loader data with no new charting dependency. Interactivity is limited to lightweight hover tooltips.

### Data access (service layer)

- A new analytics service owns all dashboard data access, with set-based aggregate queries (grouping and joins) rather than per-student/per-lesson loops, so loaders stay thin and the existing roster's N+1 pattern is not repeated.
- It exposes one function for the portfolio overview (totals, distinct learners, weekly revenue and enrollment series, and the per-course comparison rows) and one for the per-course deep dive (course totals, average progress, weekly series, the ordered funnel with the biggest-drop flag, and per-quiz histograms with pass rate and average).
- The new service has accompanying tests, per the repo convention that service files are tested.

### Completion wiring

- The lesson-completion primitive stays pure (it only sets a lesson's status).
- A new function in the existing enrollment service, given a user and course, checks whether the user has completed all of the course's lessons and, if so and the enrollment is not already complete, marks the enrollment complete with a timestamp. It is a one-way, set-once milestone: it never moves or clears an existing completion timestamp, and it does nothing for courses with zero lessons or for users without an enrollment.
- The lesson "mark complete" action calls this function immediately after marking the lesson, where the course is already in scope.
- The completion rate metric reads the maintained completion flag.
- This adds a one-way dependency from the enrollment service to the progress service (for the lesson counts); the completion primitive does not gain new side effects.

### Seed data

- No backfill or migration tooling is built, because the app is not in production and the database is always regenerated from the seed.
- The seed continues to set demo completion timestamps directly for students who should be complete. Seed hygiene requirement: any student marked complete in the seed must also have their lesson progress seeded to 100%, so the completion tile (from the flag) and the funnel/average-progress (from lesson progress) agree on the demo data.

### Access control

- Per-course analytics mirror the existing roster rule: accessible to the course owner or an admin, with a forbidden response otherwise.
- The portfolio overview is scoped to the current user's own authored courses; an admin sees only courses they authored (often none). There is no platform-wide admin super-view in this scope.

### Edge cases

- Zero enrolled students: completion and quiz numbers render as a neutral placeholder with an empty state rather than dividing by zero.
- Zero lessons: the funnel is suppressed with an explanation.
- No quizzes: the quiz section is hidden.
- No purchases: earnings render as zero currency, not an error.

## Out of Scope

- An interactive date-range picker that recomputes every metric (the dashboard ships with fixed all-time totals plus weekly trends).
- Within-video drop-off analysis using watch-position events (the drop-off signal is the lesson-completion funnel only).
- Per-question quiz difficulty analysis (which questions are most missed).
- Course ratings/reviews analytics.
- A platform-wide admin analytics super-view spanning all instructors.
- Net-of-fee or refund-aware earnings (no fee or refund concept exists in the data model).
- Quizzes gating course completion (completion is lessons-only).
- Bidirectional completion sync that clears completion when a student or instructor pushes progress back below 100% (completion is set-once).
- Any backfill/migration tooling for existing enrollment completion (not applicable outside production).
- Email or other notifications driven by completion.

## Further Notes

- The lesson-completion funnel can be non-monotonic if students complete lessons out of order or if a course contains an optional/bonus lesson that most students skip, which could surface as a false "cliff." This is accepted for the first version; the biggest-drop highlight is a heuristic, not a guarantee.
- Because completion is set-once and the funnel/average-progress are computed live from lesson progress, the completion tile and the lesson-level views can diverge if an instructor adds lessons to a course after some students already finished it. This is an accepted trade-off of treating completion as a historical milestone.
- The portfolio "distinct learners" figure and the sum of per-course enrollments will differ whenever learners take more than one of the instructor's courses; both are shown intentionally.
- The existing roster's per-student computations remain unchanged; this work does not refactor the roster, only links to it.
- A future iteration could layer in within-video drop-off, per-question difficulty, and an interactive date range on top of the same analytics service without changing these metric definitions.
