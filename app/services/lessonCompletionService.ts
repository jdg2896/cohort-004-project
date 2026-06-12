import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  lessons,
  lessonProgress,
  modules,
  LessonProgressStatus,
  UserRole,
  XpSourceType,
} from "~/db/schema";
import { getUserById } from "~/services/userService";
import { getLessonById } from "~/services/lessonService";
import { getModuleById } from "~/services/moduleService";
import {
  isLessonCompleted,
  markLessonComplete,
} from "~/services/progressService";
import { awardXp, LESSON_COMPLETION_XP } from "~/services/gamificationService";
import { recordStreakActivity } from "~/services/streakService";
import { markEnrollmentCompleteIfFinished } from "~/services/enrollmentService";

// ─── Lesson Completion Service ───
// The one entry point for "a user completed a lesson". It owns the entire
// definition of that event — lesson↔course validation, the ordered write
// cascade (progress → student-only XP + streak → module-completion detection →
// enrollment promotion), and the student-only gamification policy. Callers hand
// it the three identifiers they already have and translate the typed result into
// HTTP; they cannot mis-sequence the cascade or forget a step.
//
// The former moduleCompletionService is absorbed here as private helpers: its
// capture-before-write contract (the `wasAlreadyComplete` footgun) is now
// internal and structural rather than a leaked parameter.

// The toast payload shown when a completion finishes a module. Re-exported as the
// public type so the route renders `xpEarned` without reaching into internals.
export interface ModuleCompletionToast {
  moduleId: number;
  moduleTitle: string;
  // Total XP across the module's lessons (flat LESSON_COMPLETION_XP each).
  xpEarned: number;
}

export type CompleteLessonResult =
  | { ok: true; moduleCompletion: ModuleCompletionToast | null }
  | { ok: false; error: "lesson-not-in-course" };

/**
 * Records that a user completed a lesson, performing every side effect in the
 * required order: progress write, student-only XP + streak, module-completion
 * toast detection, and enrollment promotion. Validates the lesson belongs to the
 * course first, returning a typed failure (callers map it to a 404) so a crafted
 * request can't complete a foreign lesson or hit a raw FK error.
 *
 * Idempotent end-to-end: re-completing an already-complete lesson returns
 * { ok: true, moduleCompletion: null } and changes no XP, streak, or enrollment
 * state — each primitive dedups (unique indexes on xp_events and
 * streak_activities, set-once enrollment completedAt) and the toast is gated on
 * the prior completion state captured before the write.
 *
 * Gamification is student-only: the role is resolved here via getUserById, so
 * callers cannot pass a wrong role and instructors/admins viewing lessons accrue
 * no XP, streak, or toast.
 */
export function completeLesson(opts: {
  userId: number;
  lessonId: number;
  courseId: number;
}): CompleteLessonResult {
  const { userId, lessonId, courseId } = opts;

  // Validate the lesson exists and belongs to this course before any write.
  const lesson = getLessonById(lessonId);
  const mod = lesson ? getModuleById(lesson.moduleId) : null;
  if (!lesson || !mod || mod.courseId !== courseId) {
    return { ok: false, error: "lesson-not-in-course" };
  }

  const user = getUserById(userId);

  // Run the whole write cascade in one transaction so a mid-cascade failure
  // rolls back every prior write instead of stranding partial state (e.g. XP
  // awarded but the enrollment never stamped). better-sqlite3 is synchronous
  // and single-connection, so the inner services' module-level `db` calls
  // execute inside this BEGIN/COMMIT and participate automatically.
  const moduleCompletion = db.transaction(() => {
    // Capture prior completion state before writing, so re-completing a lesson
    // (already complete) doesn't re-fire the module-completion toast below.
    const wasAlreadyComplete = isLessonCompleted(userId, lessonId);
    markLessonComplete(userId, lessonId);

    // Award lesson-completion XP, but only for students — gamification is
    // student-only, and instructors/admins viewing lessons shouldn't accrue XP.
    // awardXp is idempotent per (user, source), so re-completing never dups.
    let toast: ModuleCompletionToast | null = null;
    if (user?.role === UserRole.Student) {
      awardXp({
        userId,
        amount: LESSON_COMPLETION_XP,
        sourceType: XpSourceType.LessonCompletion,
        sourceId: lessonId,
      });
      // Record today's UTC streak activity. Idempotent per UTC day, so multiple
      // completions in a day count once and re-completing never inflates it.
      recordStreakActivity({ userId });
      // If this completion finished the module, signal the client to toast the
      // module's total XP. Null for a non-final lesson or a re-completion.
      toast = getModuleCompletionToast({
        userId,
        lessonId,
        wasAlreadyComplete,
      });
    }

    // Finishing the final lesson promotes the enrollment to "complete"
    // (set-once). No-op for the instructor/admin viewers above with no
    // enrollment.
    markEnrollmentCompleteIfFinished({ userId, courseId });

    return toast;
  });

  return { ok: true, moduleCompletion };
}

// ─── Module-completion detection (private) ───
// Detects when a completion finished the last remaining lesson in a module, so
// the flow can fire a single "Module complete! +N XP" toast. Only module
// completion is celebrated — individual lesson completions show no toast.

function getModuleLessonIds(moduleId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .where(eq(lessons.moduleId, moduleId))
    .all()
    .map((l) => l.id);
}

// Whether every lesson in the module is completed for this user. A module with no
// lessons is never "complete" (there's nothing to celebrate).
function isModuleComplete(opts: { userId: number; moduleId: number }): boolean {
  const lessonIds = getModuleLessonIds(opts.moduleId);
  if (lessonIds.length === 0) return false;

  const completed = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, opts.userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return (completed?.count ?? 0) === lessonIds.length;
}

// Total XP a module is worth across all its lessons. Flat LESSON_COMPLETION_XP
// per lesson, so a 4-lesson module is worth 40 XP regardless of timing.
function getModuleCompletionXp(moduleId: number): number {
  return getModuleLessonIds(moduleId).length * LESSON_COMPLETION_XP;
}

// Returns the toast payload when *this* lesson completion is what finished its
// module — i.e. the module is now fully complete and this lesson wasn't already
// complete before. Null for a non-final lesson, an unfinished module, or a
// re-completion (so the toast fires exactly once per module).
function getModuleCompletionToast(opts: {
  userId: number;
  lessonId: number;
  wasAlreadyComplete: boolean;
}): ModuleCompletionToast | null {
  // Re-completing an already-complete lesson can't be the completion that tipped
  // the module over, so it never re-fires the toast.
  if (opts.wasAlreadyComplete) return null;

  const lesson = db
    .select()
    .from(lessons)
    .where(eq(lessons.id, opts.lessonId))
    .get();
  if (!lesson) return null;

  if (!isModuleComplete({ userId: opts.userId, moduleId: lesson.moduleId })) {
    return null;
  }

  const mod = db
    .select()
    .from(modules)
    .where(eq(modules.id, lesson.moduleId))
    .get();
  if (!mod) return null;

  return {
    moduleId: mod.id,
    moduleTitle: mod.title,
    xpEarned: getModuleCompletionXp(mod.id),
  };
}
