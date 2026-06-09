import { eq, and, inArray, sql } from "drizzle-orm";
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
