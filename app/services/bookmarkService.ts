import { eq, and } from "drizzle-orm";
import { db } from "~/db";
import { lessonBookmarks, lessons, modules } from "~/db/schema";

// ─── Bookmark Service ───
// Handles private per-student lesson bookmarks. Bookmarks persist until the
// student manually removes them (even after lesson completion). One bookmark
// per (user, lesson). Functions take an object parameter because their IDs
// share the same type (per AGENTS.md), guarding against transposed arguments.

export function isLessonBookmarked(opts: {
  userId: number;
  lessonId: number;
}): boolean {
  const { userId, lessonId } = opts;
  const row = db
    .select({ id: lessonBookmarks.id })
    .from(lessonBookmarks)
    .where(
      and(
        eq(lessonBookmarks.userId, userId),
        eq(lessonBookmarks.lessonId, lessonId)
      )
    )
    .get();

  return !!row;
}

// Toggles the bookmark: removes it if it exists, otherwise creates it.
// Returns the resulting state so the caller can update the UI.
export function toggleBookmark(opts: {
  userId: number;
  lessonId: number;
}): { bookmarked: boolean } {
  const { userId, lessonId } = opts;
  const existing = db
    .select({ id: lessonBookmarks.id })
    .from(lessonBookmarks)
    .where(
      and(
        eq(lessonBookmarks.userId, userId),
        eq(lessonBookmarks.lessonId, lessonId)
      )
    )
    .get();

  if (existing) {
    db.delete(lessonBookmarks)
      .where(eq(lessonBookmarks.id, existing.id))
      .run();
    return { bookmarked: false };
  }

  db.insert(lessonBookmarks).values({ userId, lessonId }).run();
  return { bookmarked: true };
}

// Batched lookup of every bookmarked lesson ID in a course, so loaders can
// avoid N+1 queries. Joins bookmarks → lessons → modules to scope by course.
export function getBookmarkedLessonIds(opts: {
  userId: number;
  courseId: number;
}): number[] {
  const { userId, courseId } = opts;
  const rows = db
    .select({ lessonId: lessonBookmarks.lessonId })
    .from(lessonBookmarks)
    .innerJoin(lessons, eq(lessonBookmarks.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(
      and(
        eq(lessonBookmarks.userId, userId),
        eq(modules.courseId, courseId)
      )
    )
    .all();

  return rows.map((r) => r.lessonId);
}
