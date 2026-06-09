import { eq, and, gte, inArray, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { db } from "~/db";
import {
  enrollments,
  purchases,
  lessons,
  modules,
  lessonProgress,
  LessonProgressStatus,
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
  const windowStartMs = now.getTime() - TREND_WEEKS * DAYS_PER_WEEK * MS_PER_DAY;
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
 * Weekly revenue and enrollment trends for a course over the last ~12 weeks,
 * zero-filled. Two set-based date-grouped queries (one per table) feed a
 * pre-built zero-filled window, so weeks with no activity are 0 rather than
 * absent.
 */
export function getCourseTrends(courseId: number): CourseTrends {
  const { windowStartIso, weekStarts } = computeWeekWindow(new Date());

  const revenueWeek = weekIndexExpr(purchases.createdAt, windowStartIso);
  const revenueRows = db
    .select({
      week: revenueWeek,
      total: sql<number>`coalesce(sum(${purchases.pricePaid}), 0)`,
    })
    .from(purchases)
    .where(
      and(
        eq(purchases.courseId, courseId),
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
        eq(enrollments.courseId, courseId),
        gte(enrollments.enrolledAt, windowStartIso)
      )
    )
    .groupBy(enrollmentWeek)
    .all();

  const weeks: WeeklyTrendPoint[] = weekStarts.map((weekStart) => ({
    weekStart,
    revenue: 0,
    enrollments: 0,
  }));

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
