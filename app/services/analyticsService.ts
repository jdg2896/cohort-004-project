import { eq, and, gte, inArray, sql, desc } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { db } from "~/db";
import {
  courses,
  enrollments,
  purchases,
  lessons,
  modules,
  lessonProgress,
  LessonProgressStatus,
  quizzes,
  quizAttempts,
  users,
} from "~/db/schema";

// ─── Analytics Service ───
// Owns all instructor-dashboard reads. Every query here is set-based (counts,
// sums, group-by, joins) — never a per-student or per-lesson loop — so the
// dashboard stays fast as a course grows (PRD Story 39). Uses positional
// parameters (project convention).

export type CourseAnalytics = {
  enrollmentCount: number;
  /**
   * Gross sum of recorded purchase amounts, in cents. Already PPP-adjusted and
   * already inclusive of team/seat purchases (both are captured at purchase
   * time). There is no net-of-fee or refund concept in the data model.
   */
  totalEarnings: number;
  /**
   * Share of enrolled students whose enrollment is marked complete (0–1), read
   * from the maintained `enrollments.completedAt` flag. `null` when nobody is
   * enrolled, so the caller renders a neutral empty state instead of dividing
   * by zero.
   */
  completionRate: number | null;
  /**
   * Mean of each enrolled student's lessons-only progress percentage (0–100),
   * the companion to completion rate. `null` when nobody is enrolled.
   */
  averageProgress: number | null;
};

/**
 * Per-course snapshot for the deep-dive dashboard: enrollment count, gross
 * earnings, completion rate, and average progress. Built from a handful of
 * set-based aggregate queries rather than per-student loops.
 */
export function getCourseAnalytics(courseId: number): CourseAnalytics {
  // Enrollment count and completed count in a single grouped scan.
  // `count(completedAt)` ignores nulls, so it counts only completed enrollments.
  const enrollmentRow = db
    .select({
      total: sql<number>`count(*)`,
      completed: sql<number>`count(${enrollments.completedAt})`,
    })
    .from(enrollments)
    .where(eq(enrollments.courseId, courseId))
    .get();

  const enrollmentCount = enrollmentRow?.total ?? 0;
  const completedCount = enrollmentRow?.completed ?? 0;

  // Earnings: gross sum of pricePaid (cents); coalesced to 0 when there are no
  // purchases so a brand-new course reads as $0.00 rather than null.
  const earningsRow = db
    .select({ total: sql<number>`coalesce(sum(${purchases.pricePaid}), 0)` })
    .from(purchases)
    .where(eq(purchases.courseId, courseId))
    .get();

  const totalEarnings = earningsRow?.total ?? 0;

  // No enrolled students → completion and progress are undefined, not zero.
  if (enrollmentCount === 0) {
    return {
      enrollmentCount: 0,
      totalEarnings,
      completionRate: null,
      averageProgress: null,
    };
  }

  return {
    enrollmentCount,
    totalEarnings,
    completionRate: completedCount / enrollmentCount,
    averageProgress: getAverageProgress(courseId, enrollmentCount),
  };
}

/** Lesson ids for a course, across all of its modules. */
function getCourseLessonIds(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

/**
 * Mean lessons-only progress across enrolled students, matching the per-student
 * percentage the roster shows (`round(completed / total * 100)`), then averaged.
 * One grouped scan yields a completed-lesson count per enrolled student, so
 * there is no per-student query. A course with no lessons reads as 0%, exactly
 * like `calculateProgress`.
 */
function getAverageProgress(courseId: number, enrollmentCount: number): number {
  const lessonIds = getCourseLessonIds(courseId);
  if (lessonIds.length === 0) return 0;

  // One row per enrollment. The completion filters live in the LEFT JOIN's ON
  // clause so students with zero completed lessons still produce a row (count 0)
  // rather than being dropped.
  const rows = db
    .select({ completed: sql<number>`count(${lessonProgress.id})` })
    .from(enrollments)
    .leftJoin(
      lessonProgress,
      and(
        eq(lessonProgress.userId, enrollments.userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .where(eq(enrollments.courseId, courseId))
    .groupBy(enrollments.id)
    .all();

  const totalLessons = lessonIds.length;
  const sumOfPercentages = rows.reduce(
    (acc, row) => acc + Math.round((row.completed / totalLessons) * 100),
    0
  );

  return Math.round(sumOfPercentages / enrollmentCount);
}

// ─── Weekly trends ───
// Revenue and enrollment bucketed into weekly points over a fixed ~12-week
// window. The window is computed here (in the service) so the series can be
// zero-filled deterministically — empty weeks render as 0 rather than being
// skipped (PRD Story 38). Bucketing itself is a single set-based date-grouped
// query per series (no per-week or per-row loop).

const TREND_WEEKS = 12;
const DAYS_PER_WEEK = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type WeeklyTrendPoint = {
  /** ISO date (YYYY-MM-DD) marking the start of this week's bucket. */
  weekStart: string;
  /** Gross earnings recorded in this week, in cents. */
  revenue: number;
  /** New enrollments recorded in this week. */
  enrollments: number;
};

export type CourseTrends = {
  /**
   * Weekly points oldest → newest, always `TREND_WEEKS` long and zero-filled
   * across the full window. The last point is the most recent 7 days.
   */
  weeks: WeeklyTrendPoint[];
};

/**
 * The trend window: the ISO timestamp at which the oldest bucket starts (used
 * both to filter rows and as the reference point for in-SQL bucketing) and the
 * per-week start-date labels, oldest → newest.
 */
function computeWeekWindow(now: Date): {
  windowStartIso: string;
  weekStarts: string[];
} {
  const windowStartMs =
    now.getTime() - TREND_WEEKS * DAYS_PER_WEEK * MS_PER_DAY;
  const weekStarts: string[] = [];
  for (let i = 0; i < TREND_WEEKS; i++) {
    const start = new Date(windowStartMs + i * DAYS_PER_WEEK * MS_PER_DAY);
    weekStarts.push(start.toISOString().slice(0, 10));
  }
  return { windowStartIso: new Date(windowStartMs).toISOString(), weekStarts };
}

/**
 * A 0-based week-bucket index for a timestamp column, measured from
 * `windowStartIso`. The day difference is rounded to a whole day before the
 * weekly division so float jitter at exact week boundaries can't push a row
 * into the wrong bucket. Rows older than the window are excluded by the
 * caller's `gte` filter; a row at "now" lands at index `TREND_WEEKS`, which the
 * caller clamps into the most recent bucket.
 */
function weekIndexExpr(column: AnySQLiteColumn, windowStartIso: string) {
  // The outer cast truncates the division to a whole week index, so the bucket
  // is always an integer regardless of SQLite's int-vs-real division rules.
  return sql<number>`cast(round(julianday(${column}) - julianday(${windowStartIso})) / ${DAYS_PER_WEEK} as integer)`;
}

/**
 * Weekly revenue and enrollment trends across the given courses over the last
 * ~12 weeks, zero-filled. Two set-based date-grouped queries (one per table)
 * feed a pre-built zero-filled window, so weeks with no activity are 0 rather
 * than absent. Shared by the per-course deep dive (a single course) and the
 * portfolio overview (all of an instructor's courses); an empty `courseIds`
 * yields the bare zero-filled window without touching the database.
 */
function buildWeeklyTrends(courseIds: number[], now: Date): CourseTrends {
  const { windowStartIso, weekStarts } = computeWeekWindow(now);

  const weeks: WeeklyTrendPoint[] = weekStarts.map((weekStart) => ({
    weekStart,
    revenue: 0,
    enrollments: 0,
  }));

  // No courses → an all-zero window. Returning early also avoids `inArray` with
  // an empty list.
  if (courseIds.length === 0) return { weeks };

  const revenueWeek = weekIndexExpr(purchases.createdAt, windowStartIso);
  const revenueRows = db
    .select({
      week: revenueWeek,
      total: sql<number>`coalesce(sum(${purchases.pricePaid}), 0)`,
    })
    .from(purchases)
    .where(
      and(
        inArray(purchases.courseId, courseIds),
        gte(purchases.createdAt, windowStartIso)
      )
    )
    .groupBy(revenueWeek)
    .all();

  const enrollmentWeek = weekIndexExpr(enrollments.enrolledAt, windowStartIso);
  const enrollmentRows = db
    .select({
      week: enrollmentWeek,
      total: sql<number>`count(*)`,
    })
    .from(enrollments)
    .where(
      and(
        inArray(enrollments.courseId, courseIds),
        gte(enrollments.enrolledAt, windowStartIso)
      )
    )
    .groupBy(enrollmentWeek)
    .all();

  // Clamp the open upper edge: a row at exactly "now" computes to index
  // TREND_WEEKS, which belongs in the most recent bucket.
  const bucketOf = (week: number) => Math.min(week, TREND_WEEKS - 1);

  for (const row of revenueRows) {
    weeks[bucketOf(row.week)].revenue += row.total;
  }
  for (const row of enrollmentRows) {
    weeks[bucketOf(row.week)].enrollments += row.total;
  }

  return { weeks };
}

/** Weekly revenue and enrollment trends for a single course. */
export function getCourseTrends(courseId: number): CourseTrends {
  return buildWeeklyTrends([courseId], new Date());
}

// ─── Lesson-completion funnel ───
// The course's lessons in module→lesson order, each with the share of enrolled
// students who completed it, and a flag on the single lesson with the largest
// drop from the previous one (PRD Stories 19, 20, 26). Completion shares come
// from one set-based grouped scan — no per-lesson or per-student loop — and the
// drop-off is found in a single linear pass over those aggregated rows. A
// non-monotonic funnel (out-of-order or optional lessons) is an accepted caveat;
// the biggest-drop highlight is a heuristic, not a guarantee.

export type FunnelLesson = {
  lessonId: number;
  title: string;
  /** Enrolled students who completed this lesson. */
  completedCount: number;
  /**
   * Share of enrolled students who completed this lesson (0–1). 0 when nobody is
   * enrolled, so the caller never divides by zero.
   */
  completionRate: number;
  /**
   * True for the single lesson with the largest decrease in completers versus
   * the previous lesson. At most one lesson is flagged; ties resolve to the
   * earliest lesson, and a never-decreasing funnel flags nothing.
   */
  isBiggestDropOff: boolean;
};

export type CourseFunnel = {
  /** The denominator for every completion share: total enrolled students. */
  enrollmentCount: number;
  /** Lessons in module→lesson order. Empty when the course has no lessons. */
  lessons: FunnelLesson[];
};

/**
 * Lesson-completion funnel for a course. Returns lessons in module→lesson order
 * with each lesson's completion share across enrolled students and the
 * biggest-drop-off flag. A zero-lesson course yields an empty `lessons` array so
 * the caller can suppress the chart with an explanation.
 */
export function getCourseFunnel(courseId: number): CourseFunnel {
  const enrollmentRow = db
    .select({ total: sql<number>`count(*)` })
    .from(enrollments)
    .where(eq(enrollments.courseId, courseId))
    .get();
  const enrollmentCount = enrollmentRow?.total ?? 0;

  // One grouped scan yields a completed-by-enrolled-students count per lesson.
  // The completion filter lives in the LEFT JOIN so lessons nobody finished
  // still produce a row (count 0). The second LEFT JOIN keeps only completers
  // who are actually enrolled in this course; `count(distinct enrollments.userId)`
  // then ignores the nulls left by non-enrolled completers and unfinished lessons.
  const rows = db
    .select({
      lessonId: lessons.id,
      title: lessons.title,
      completedCount: sql<number>`count(distinct ${enrollments.userId})`,
    })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .leftJoin(
      lessonProgress,
      and(
        eq(lessonProgress.lessonId, lessons.id),
        eq(lessonProgress.status, LessonProgressStatus.Completed)
      )
    )
    .leftJoin(
      enrollments,
      and(
        eq(enrollments.userId, lessonProgress.userId),
        eq(enrollments.courseId, courseId)
      )
    )
    .where(eq(modules.courseId, courseId))
    .groupBy(lessons.id)
    .orderBy(modules.position, lessons.position)
    .all();

  const funnelLessons: FunnelLesson[] = rows.map((row) => ({
    lessonId: row.lessonId,
    title: row.title,
    completedCount: row.completedCount,
    completionRate:
      enrollmentCount === 0 ? 0 : row.completedCount / enrollmentCount,
    isBiggestDropOff: false,
  }));

  // Flag the lesson with the largest fall in completers from the lesson before
  // it. The denominator is constant across lessons, so comparing raw counts is
  // equivalent to comparing shares; a non-decreasing funnel flags nothing.
  let dropIndex = -1;
  let biggestDrop = 0;
  for (let i = 1; i < funnelLessons.length; i++) {
    const drop =
      funnelLessons[i - 1].completedCount - funnelLessons[i].completedCount;
    if (drop > biggestDrop) {
      biggestDrop = drop;
      dropIndex = i;
    }
  }
  if (dropIndex >= 0) {
    funnelLessons[dropIndex].isBiggestDropOff = true;
  }

  return { enrollmentCount, lessons: funnelLessons };
}

// ─── Quiz score distributions ───
// Per-quiz histogram of students' best attempts in fixed score bands, plus each
// quiz's pass rate and average score (PRD Stories 21, 22, 23, 27). The "best
// attempt per student per quiz" comes from one set-based grouped scan across
// every quiz in the course (`max(score)` grouped by quiz + user) — never a
// per-student loop — and the bucketing, pass rate, and average are a single
// linear pass over those aggregated rows, mirroring the funnel's
// grouped-scan-then-reduce shape. A course with no quizzes yields an empty array
// so the caller can hide the section entirely.

// Fixed score bands as percentages, low → high. The top band is inclusive of
// 100; every other band is inclusive of its lower bound and exclusive of its
// upper bound (see `scoreBucketIndex`).
const QUIZ_SCORE_BUCKETS = [
  { min: 0, max: 50 },
  { min: 50, max: 70 },
  { min: 70, max: 90 },
  { min: 90, max: 100 },
] as const;

export type QuizScoreBucket = {
  /** Inclusive lower bound of the band, as a percentage. */
  min: number;
  /** Upper bound as a percentage; inclusive only for the top (90–100) band. */
  max: number;
  /** Students whose best attempt falls in this band. */
  count: number;
};

export type QuizDistribution = {
  quizId: number;
  title: string;
  /** The lesson the quiz belongs to, shown for context in the UI. */
  lessonTitle: string;
  /** Passing threshold (0–1), marked on the histogram. */
  passingScore: number;
  /** Distinct students who have attempted this quiz (the histogram denominator). */
  studentCount: number;
  /**
   * Share of attempting students whose best attempt met the passing threshold
   * (0–1). `null` when nobody has attempted, so the caller renders a neutral
   * placeholder instead of dividing by zero. Computed against `passingScore`
   * (not the stored per-attempt `passed` flag) so it always agrees with the
   * threshold drawn on the histogram.
   */
  passRate: number | null;
  /** Mean of attempting students' best-attempt scores (0–1). `null` when none. */
  averageScore: number | null;
  /** Best-attempt counts in the fixed bands, low → high. */
  buckets: QuizScoreBucket[];
};

/** The 0-based band index for a score (0–1): [0,.5) [.5,.7) [.7,.9) [.9,1]. */
function scoreBucketIndex(score: number): number {
  if (score < 0.5) return 0;
  if (score < 0.7) return 1;
  if (score < 0.9) return 2;
  return 3;
}

/**
 * Per-quiz score distributions for a course: for each quiz (in module→lesson
 * order) a histogram of students' best attempts in fixed bands, plus pass rate
 * and average score. Quizzes hang off lessons, which hang off modules, so the
 * funnel's ordering join applies here too. An empty array means the course has
 * no quizzes and the caller should hide the section.
 */
export function getCourseQuizDistributions(
  courseId: number
): QuizDistribution[] {
  const quizRows = db
    .select({
      quizId: quizzes.id,
      title: quizzes.title,
      lessonTitle: lessons.title,
      passingScore: quizzes.passingScore,
    })
    .from(quizzes)
    .innerJoin(lessons, eq(quizzes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .orderBy(modules.position, lessons.position)
    .all();

  if (quizRows.length === 0) return [];

  // One grouped scan for the best (max) score per student per quiz across every
  // quiz in the course. Not filtered by enrollment — in practice only enrolled
  // students attempt, and the PRD defines the histogram over "each student's
  // best attempt". Bucketing, pass rate, and average are a single linear pass
  // over these rows below, so there is no per-student or per-quiz query.
  const quizIds = quizRows.map((q) => q.quizId);
  const bestRows = db
    .select({
      quizId: quizAttempts.quizId,
      best: sql<number>`max(${quizAttempts.score})`,
    })
    .from(quizAttempts)
    .where(inArray(quizAttempts.quizId, quizIds))
    .groupBy(quizAttempts.quizId, quizAttempts.userId)
    .all();

  // Per-quiz accumulators, pre-seeded so quizzes with no attempts still appear.
  const passingByQuiz = new Map(
    quizRows.map((q) => [q.quizId, q.passingScore])
  );
  const stats = new Map(
    quizRows.map((q) => [
      q.quizId,
      { buckets: [0, 0, 0, 0], sum: 0, passing: 0, students: 0 },
    ])
  );

  for (const row of bestRows) {
    const s = stats.get(row.quizId);
    if (!s) continue; // defensive; bestRows are already filtered to course quizzes
    s.students += 1;
    s.sum += row.best;
    s.buckets[scoreBucketIndex(row.best)] += 1;
    if (row.best >= (passingByQuiz.get(row.quizId) ?? 1)) s.passing += 1;
  }

  return quizRows.map((q) => {
    const s = stats.get(q.quizId)!;
    return {
      quizId: q.quizId,
      title: q.title,
      lessonTitle: q.lessonTitle,
      passingScore: q.passingScore,
      studentCount: s.students,
      passRate: s.students === 0 ? null : s.passing / s.students,
      averageScore: s.students === 0 ? null : s.sum / s.students,
      buckets: QUIZ_SCORE_BUCKETS.map((band, i) => ({
        min: band.min,
        max: band.max,
        count: s.buckets[i],
      })),
    };
  });
}

// ─── Portfolio overview ───
// Cross-course aggregates for an instructor's whole catalog (PRD Stories 1–12).
// Everything is computed from a handful of set-based grouped queries scoped to
// the instructor's courses with `inArray` — never a per-course or per-student
// loop — then stitched together in memory, so the page stays fast as the
// catalog grows (Story 39).

export type PortfolioCourseRow = {
  courseId: number;
  title: string;
  /** Enrollment rows for this course. */
  enrollmentCount: number;
  /** Gross sum of this course's purchase amounts, in cents. */
  totalEarnings: number;
  /**
   * Share of this course's enrolled students marked complete (0–1), or `null`
   * when the course has no enrollments, so the caller renders a placeholder.
   */
  completionRate: number | null;
  /**
   * Mean of students' best-attempt scores across this course's quizzes (0–1),
   * or `null` when the course has no quiz attempts.
   */
  averageQuizScore: number | null;
};

export type PortfolioAnalytics = {
  /** Gross earnings across all the instructor's courses, in cents. */
  totalEarnings: number;
  /** Sum of enrollment rows across all the instructor's courses. */
  totalEnrollments: number;
  /**
   * Distinct users across all the instructor's enrollments — a learner taking
   * several of the instructor's courses is counted once, so this differs from
   * `totalEnrollments` whenever learners overlap.
   */
  distinctLearners: number;
  /**
   * Mean of the per-course completion rates, over courses that have at least one
   * enrollment (the average of the comparison table's completion column).
   * `null` when no course has any enrollment, so the caller renders a neutral
   * placeholder.
   */
  averageCompletion: number | null;
  /** Per-course comparison rows, ordered by title. */
  courses: PortfolioCourseRow[];
};

/** Course ids authored by an instructor. */
function getInstructorCourseIds(instructorId: number): number[] {
  return db
    .select({ id: courses.id })
    .from(courses)
    .where(eq(courses.instructorId, instructorId))
    .all()
    .map((row) => row.id);
}

/**
 * Portfolio snapshot for an instructor: catalog totals, distinct learners,
 * average completion, and the per-course comparison rows. Scoped to the courses
 * the instructor authored; a user with no courses gets all-zero totals and an
 * empty `courses` array so the caller can show a friendly empty state.
 */
export function getPortfolioAnalytics(
  instructorId: number
): PortfolioAnalytics {
  const courseRows = db
    .select({ id: courses.id, title: courses.title })
    .from(courses)
    .where(eq(courses.instructorId, instructorId))
    .orderBy(courses.title)
    .all();

  if (courseRows.length === 0) {
    return {
      totalEarnings: 0,
      totalEnrollments: 0,
      distinctLearners: 0,
      averageCompletion: null,
      courses: [],
    };
  }

  const courseIds = courseRows.map((c) => c.id);

  // Enrollment count + completed count per course, in one grouped scan.
  // `count(completedAt)` ignores nulls, so it counts only completed enrollments.
  const enrollmentRows = db
    .select({
      courseId: enrollments.courseId,
      total: sql<number>`count(*)`,
      completed: sql<number>`count(${enrollments.completedAt})`,
    })
    .from(enrollments)
    .where(inArray(enrollments.courseId, courseIds))
    .groupBy(enrollments.courseId)
    .all();

  // Gross earnings per course, in one grouped scan.
  const earningsRows = db
    .select({
      courseId: purchases.courseId,
      total: sql<number>`coalesce(sum(${purchases.pricePaid}), 0)`,
    })
    .from(purchases)
    .where(inArray(purchases.courseId, courseIds))
    .groupBy(purchases.courseId)
    .all();

  // Distinct learners across the whole catalog, deduped by user in SQL.
  const learnerRow = db
    .select({ count: sql<number>`count(distinct ${enrollments.userId})` })
    .from(enrollments)
    .where(inArray(enrollments.courseId, courseIds))
    .get();
  const distinctLearners = learnerRow?.count ?? 0;

  // Average quiz score per course: the best attempt per student per quiz (one
  // grouped subquery), joined up to its course and averaged. A single set-based
  // query — no per-quiz or per-student loop.
  const best = db
    .select({
      quizId: quizAttempts.quizId,
      best: sql<number>`max(${quizAttempts.score})`.as("best"),
    })
    .from(quizAttempts)
    .groupBy(quizAttempts.quizId, quizAttempts.userId)
    .as("best");

  const quizScoreRows = db
    .select({
      courseId: modules.courseId,
      average: sql<number>`avg(${best.best})`,
    })
    .from(best)
    .innerJoin(quizzes, eq(best.quizId, quizzes.id))
    .innerJoin(lessons, eq(quizzes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(inArray(modules.courseId, courseIds))
    .groupBy(modules.courseId)
    .all();

  const enrollmentByCourse = new Map(
    enrollmentRows.map((row) => [row.courseId, row])
  );
  const earningsByCourse = new Map(
    earningsRows.map((row) => [row.courseId, row.total])
  );
  const quizScoreByCourse = new Map(
    quizScoreRows.map((row) => [row.courseId, row.average])
  );

  const rows: PortfolioCourseRow[] = courseRows.map((course) => {
    const enrollment = enrollmentByCourse.get(course.id);
    const total = enrollment?.total ?? 0;
    const completed = enrollment?.completed ?? 0;
    return {
      courseId: course.id,
      title: course.title,
      enrollmentCount: total,
      totalEarnings: earningsByCourse.get(course.id) ?? 0,
      completionRate: total === 0 ? null : completed / total,
      averageQuizScore: quizScoreByCourse.get(course.id) ?? null,
    };
  });

  const totalEnrollments = rows.reduce((sum, c) => sum + c.enrollmentCount, 0);
  const totalEarnings = rows.reduce((sum, c) => sum + c.totalEarnings, 0);

  const ratedCourses = rows.filter((c) => c.completionRate !== null);
  const averageCompletion =
    ratedCourses.length === 0
      ? null
      : ratedCourses.reduce((sum, c) => sum + (c.completionRate ?? 0), 0) /
        ratedCourses.length;

  return {
    totalEarnings,
    totalEnrollments,
    distinctLearners,
    averageCompletion,
    courses: rows,
  };
}

/**
 * Weekly revenue and enrollment trends across all of an instructor's courses,
 * zero-filled over the ~12-week window. Reuses the per-course trend builder with
 * the instructor's full course set.
 */
export function getPortfolioTrends(instructorId: number): CourseTrends {
  return buildWeeklyTrends(getInstructorCourseIds(instructorId), new Date());
}

// ─── Platform-wide admin analytics ───
// Cross-instructor aggregates for the admin dashboard (all courses, all
// instructors). Time-period-aware: the caller picks 7d, 30d, 12m, or all, and
// only purchases/enrollments in that window are counted. Every query is
// set-based — no per-course or per-instructor loop.

export type TimePeriod = "7d" | "30d" | "12m" | "all";

export type PlatformAnalytics = {
  totalRevenue: number;
  totalEnrollments: number;
  topCourse: { title: string; revenue: number } | null;
};

function timePeriodCutoff(period: TimePeriod, now: Date): string | null {
  if (period === "all") return null;
  const ms = now.getTime();
  switch (period) {
    case "7d":
      return new Date(ms - 7 * 24 * 60 * 60 * 1000).toISOString();
    case "30d":
      return new Date(ms - 30 * 24 * 60 * 60 * 1000).toISOString();
    case "12m":
      return new Date(ms - 365 * 24 * 60 * 60 * 1000).toISOString();
  }
}

export type RevenueTimePoint = {
  /** "YYYY-MM-DD" for daily granularity, "YYYY-MM" for monthly. */
  date: string;
  /** Gross revenue in cents for this bucket. */
  revenue: number;
};

/**
 * Platform-wide revenue time series for the admin chart. Daily granularity for
 * 7d/30d, monthly for 12m/all. Zero-filled across the full window so gaps
 * render as $0 rather than being skipped. For "all" with no purchases, returns
 * an empty array (the caller hides the chart).
 */
export function getPlatformRevenueTrend(
  period: TimePeriod
): RevenueTimePoint[] {
  const now = new Date();
  const cutoff = timePeriodCutoff(period, now);

  if (period === "7d" || period === "30d") {
    return buildDailyRevenueTrend(cutoff!, now);
  }
  return buildMonthlyRevenueTrend(cutoff, now);
}

function buildDailyRevenueTrend(cutoff: string, now: Date): RevenueTimePoint[] {
  const startDate = cutoff.slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);

  const points: RevenueTimePoint[] = [];
  const current = new Date(startDate + "T00:00:00.000Z");
  const end = new Date(endDate + "T00:00:00.000Z");
  while (current <= end) {
    points.push({ date: current.toISOString().slice(0, 10), revenue: 0 });
    current.setUTCDate(current.getUTCDate() + 1);
  }

  const rows = db
    .select({
      day: sql<string>`date(${purchases.createdAt})`,
      total: sql<number>`coalesce(sum(${purchases.pricePaid}), 0)`,
    })
    .from(purchases)
    .where(gte(purchases.createdAt, cutoff))
    .groupBy(sql`date(${purchases.createdAt})`)
    .all();

  const byDay = new Map(rows.map((r) => [r.day, r.total]));
  for (const p of points) {
    p.revenue = byDay.get(p.date) ?? 0;
  }

  return points;
}

function buildMonthlyRevenueTrend(
  cutoff: string | null,
  now: Date
): RevenueTimePoint[] {
  let startYear: number, startMonth: number;

  if (cutoff) {
    const d = new Date(cutoff);
    startYear = d.getUTCFullYear();
    startMonth = d.getUTCMonth();
  } else {
    const earliest = db
      .select({ min: sql<string | null>`min(${purchases.createdAt})` })
      .from(purchases)
      .get();

    if (!earliest?.min) return [];

    const d = new Date(earliest.min);
    startYear = d.getUTCFullYear();
    startMonth = d.getUTCMonth();
  }

  const endYear = now.getUTCFullYear();
  const endMonth = now.getUTCMonth();

  const points: RevenueTimePoint[] = [];
  let y = startYear,
    m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    points.push({
      date: `${y}-${String(m + 1).padStart(2, "0")}`,
      revenue: 0,
    });
    m++;
    if (m > 11) {
      m = 0;
      y++;
    }
  }

  const rows = db
    .select({
      month: sql<string>`strftime('%Y-%m', ${purchases.createdAt})`,
      total: sql<number>`coalesce(sum(${purchases.pricePaid}), 0)`,
    })
    .from(purchases)
    .where(cutoff ? gte(purchases.createdAt, cutoff) : undefined)
    .groupBy(sql`strftime('%Y-%m', ${purchases.createdAt})`)
    .all();

  const byMonth = new Map(rows.map((r) => [r.month, r.total]));
  for (const p of points) {
    p.revenue = byMonth.get(p.date) ?? 0;
  }

  return points;
}

export function getPlatformAnalytics(period: TimePeriod): PlatformAnalytics {
  const now = new Date();
  const cutoff = timePeriodCutoff(period, now);

  const revenueRow = db
    .select({ total: sql<number>`coalesce(sum(${purchases.pricePaid}), 0)` })
    .from(purchases)
    .where(cutoff ? gte(purchases.createdAt, cutoff) : undefined)
    .get();
  const totalRevenue = revenueRow?.total ?? 0;

  const enrollmentRow = db
    .select({ total: sql<number>`count(*)` })
    .from(enrollments)
    .where(cutoff ? gte(enrollments.enrolledAt, cutoff) : undefined)
    .get();
  const totalEnrollments = enrollmentRow?.total ?? 0;

  const topRow = db
    .select({
      title: courses.title,
      revenue: sql<number>`coalesce(sum(${purchases.pricePaid}), 0)`,
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(cutoff ? gte(purchases.createdAt, cutoff) : undefined)
    .groupBy(purchases.courseId)
    .orderBy(desc(sql`coalesce(sum(${purchases.pricePaid}), 0)`))
    .limit(1)
    .get();

  return {
    totalRevenue,
    totalEnrollments,
    topCourse: topRow ? { title: topRow.title, revenue: topRow.revenue } : null,
  };
}
