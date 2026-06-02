import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "~/db";
import { courseReviews } from "~/db/schema";

// ─── Course Review Service ───
// Handles student star ratings (1–5) for courses. One rating per (user, course),
// updatable at any time. Uses positional parameters (project convention).

export type RatingSummary = {
  average: number;
  count: number;
};

export function getUserReview(userId: number, courseId: number) {
  return db
    .select()
    .from(courseReviews)
    .where(
      and(
        eq(courseReviews.userId, userId),
        eq(courseReviews.courseId, courseId)
      )
    )
    .get();
}

export function upsertReview(userId: number, courseId: number, rating: number) {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error("Rating must be an integer between 1 and 5");
  }

  return db
    .insert(courseReviews)
    .values({ userId, courseId, rating })
    .onConflictDoUpdate({
      target: [courseReviews.userId, courseReviews.courseId],
      set: { rating, updatedAt: new Date().toISOString() },
    })
    .returning()
    .get();
}

export function getCourseRatingSummary(courseId: number): RatingSummary {
  const result = db
    .select({
      average: sql<number>`avg(${courseReviews.rating})`,
      count: sql<number>`count(*)`,
    })
    .from(courseReviews)
    .where(eq(courseReviews.courseId, courseId))
    .get();

  return {
    average: result?.average ?? 0,
    count: result?.count ?? 0,
  };
}

// Batched lookup to avoid N+1 queries on the course list page.
export function getRatingSummaries(
  courseIds: number[]
): Map<number, RatingSummary> {
  const summaries = new Map<number, RatingSummary>();
  if (courseIds.length === 0) return summaries;

  const rows = db
    .select({
      courseId: courseReviews.courseId,
      average: sql<number>`avg(${courseReviews.rating})`,
      count: sql<number>`count(*)`,
    })
    .from(courseReviews)
    .where(inArray(courseReviews.courseId, courseIds))
    .groupBy(courseReviews.courseId)
    .all();

  for (const row of rows) {
    summaries.set(row.courseId, {
      average: row.average ?? 0,
      count: row.count ?? 0,
    });
  }

  return summaries;
}
