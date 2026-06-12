import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  lessons,
  lessonProgress,
  modules,
  LessonProgressStatus,
} from "~/db/schema";
import { LESSON_COMPLETION_XP } from "./gamificationService";

// ─── Module Completion Service ───
// Detects when a student finishes the last remaining lesson in a module, so the
// lesson-complete flow can fire a single "Module complete! +N XP" toast. Only
// module completion is celebrated — individual lesson completions show no toast.
// The detection is guarded so re-completing an already-complete lesson never
// re-fires the toast.

export interface ModuleCompletionToast {
  moduleId: number;
  moduleTitle: string;
  // Total XP across the module's lessons (flat LESSON_COMPLETION_XP each).
  xpEarned: number;
}

function getModuleLessonIds(moduleId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .where(eq(lessons.moduleId, moduleId))
    .all()
    .map((l) => l.id);
}

// Whether every lesson in the module is completed for this student. A module with
// no lessons is never "complete" (there's nothing to celebrate).
export function isModuleComplete(opts: {
  userId: number;
  moduleId: number;
}): boolean {
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

// Total XP a module is worth across all its lessons. Flat 10 XP per lesson, so a
// 4-lesson module is worth 40 XP regardless of which lessons earned XP when.
export function getModuleCompletionXp(moduleId: number): number {
  return getModuleLessonIds(moduleId).length * LESSON_COMPLETION_XP;
}

// Returns the toast payload when *this* lesson completion is what finished its
// module — i.e. the module is now fully complete and this lesson wasn't already
// complete before. Returns null for a non-final lesson, an unfinished module, or
// a re-completion (so the toast fires exactly once per module).
export function getModuleCompletionToast(opts: {
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
