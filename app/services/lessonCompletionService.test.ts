import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the module (and every service it composes) picks up our
// test db. Because all services share the single mocked connection, a
// completeLesson() call is a true boundary test against real rows.
import { completeLesson } from "./lessonCompletionService";
import { getTotalXp } from "./gamificationService";
import { getStreakStats } from "./streakService";
import { isLessonCompleted } from "./progressService";
import { enrollUser, findEnrollment } from "./enrollmentService";

// Builds a module with `lessonCount` lessons under the given course.
function createModuleWithLessons(
  courseId: number,
  title: string,
  position: number,
  lessonCount: number
) {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId, title, position })
    .returning()
    .get();

  const createdLessons = [];
  for (let i = 0; i < lessonCount; i++) {
    const lesson = testDb
      .insert(schema.lessons)
      .values({ moduleId: mod.id, title: `Lesson ${i + 1}`, position: i + 1 })
      .returning()
      .get();
    createdLessons.push(lesson);
  }

  return { module: mod, lessons: createdLessons };
}

// Count of a user's streak-activity rows — the streak is recorded once per UTC
// day, so re-completion must never add a second row.
function streakActivityCount(userId: number): number {
  return testDb
    .select()
    .from(schema.streakActivities)
    .where(eq(schema.streakActivities.userId, userId))
    .all().length;
}

describe("lessonCompletionService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("student completion", () => {
    it("writes progress, awards XP, and records a streak day on first completion", () => {
      const { lessons } = createModuleWithLessons(base.course.id, "M1", 1, 3);
      enrollUser(base.user.id, base.course.id, false, false);

      const result = completeLesson({
        userId: base.user.id,
        lessonId: lessons[0].id,
        courseId: base.course.id,
      });

      expect(result).toEqual({ ok: true, moduleCompletion: null });
      expect(isLessonCompleted(base.user.id, lessons[0].id)).toBe(true);
      expect(getTotalXp(base.user.id)).toBe(10);
      expect(getStreakStats({ userId: base.user.id }).currentStreak).toBe(1);
    });

    it("returns a module-completion toast only when the final lesson finishes the module", () => {
      const { module, lessons } = createModuleWithLessons(
        base.course.id,
        "Getting Started",
        1,
        3
      );
      enrollUser(base.user.id, base.course.id, false, false);

      // First two lessons: no toast yet.
      for (const lesson of [lessons[0], lessons[1]]) {
        const r = completeLesson({
          userId: base.user.id,
          lessonId: lesson.id,
          courseId: base.course.id,
        });
        expect(r).toEqual({ ok: true, moduleCompletion: null });
      }

      // Final lesson tips the module over.
      const final = completeLesson({
        userId: base.user.id,
        lessonId: lessons[2].id,
        courseId: base.course.id,
      });

      expect(final).toEqual({
        ok: true,
        moduleCompletion: {
          moduleId: module.id,
          moduleTitle: "Getting Started",
          xpEarned: 30,
        },
      });
    });

    it("is fully inert when re-completing an already-complete lesson", () => {
      const { lessons } = createModuleWithLessons(base.course.id, "M1", 1, 2);
      enrollUser(base.user.id, base.course.id, false, false);

      completeLesson({
        userId: base.user.id,
        lessonId: lessons[0].id,
        courseId: base.course.id,
      });

      const xpAfterFirst = getTotalXp(base.user.id);
      const streakAfterFirst = getStreakStats({
        userId: base.user.id,
      }).currentStreak;

      const again = completeLesson({
        userId: base.user.id,
        lessonId: lessons[0].id,
        courseId: base.course.id,
      });

      expect(again).toEqual({ ok: true, moduleCompletion: null });
      // XP unchanged, exactly one streak activity row, streak unchanged.
      expect(getTotalXp(base.user.id)).toBe(xpAfterFirst);
      expect(streakActivityCount(base.user.id)).toBe(1);
      expect(getStreakStats({ userId: base.user.id }).currentStreak).toBe(
        streakAfterFirst
      );
    });
  });

  describe("non-student completion", () => {
    it("writes progress but awards no XP, streak, or toast, and survives a missing enrollment", () => {
      // The instructor is the final lesson of the module, with no enrollment row.
      const { lessons } = createModuleWithLessons(base.course.id, "M1", 1, 1);

      const result = completeLesson({
        userId: base.instructor.id,
        lessonId: lessons[0].id,
        courseId: base.course.id,
      });

      expect(result).toEqual({ ok: true, moduleCompletion: null });
      expect(isLessonCompleted(base.instructor.id, lessons[0].id)).toBe(true);
      expect(getTotalXp(base.instructor.id)).toBe(0);
      expect(streakActivityCount(base.instructor.id)).toBe(0);
      expect(
        findEnrollment(base.instructor.id, base.course.id)
      ).toBeUndefined();
    });
  });

  describe("enrollment promotion", () => {
    it("stamps enrollment completedAt exactly once when the course's final lesson is completed", () => {
      const { lessons } = createModuleWithLessons(base.course.id, "Only", 1, 2);
      enrollUser(base.user.id, base.course.id, false, false);

      completeLesson({
        userId: base.user.id,
        lessonId: lessons[0].id,
        courseId: base.course.id,
      });
      // Course not finished yet.
      expect(
        findEnrollment(base.user.id, base.course.id)?.completedAt
      ).toBeNull();

      completeLesson({
        userId: base.user.id,
        lessonId: lessons[1].id,
        courseId: base.course.id,
      });
      const stamped = findEnrollment(base.user.id, base.course.id)?.completedAt;
      expect(stamped).toBeTruthy();

      // Re-completing the final lesson must not move the set-once timestamp.
      completeLesson({
        userId: base.user.id,
        lessonId: lessons[1].id,
        courseId: base.course.id,
      });
      expect(findEnrollment(base.user.id, base.course.id)?.completedAt).toBe(
        stamped
      );
    });
  });

  describe("lesson not in course", () => {
    it("returns a typed failure and writes nothing when the lesson belongs to another course", () => {
      const otherCourse = testDb
        .insert(schema.courses)
        .values({
          title: "Other Course",
          slug: "other-course",
          description: "Another course",
          instructorId: base.instructor.id,
          categoryId: base.category.id,
          status: schema.CourseStatus.Published,
        })
        .returning()
        .get();
      const { lessons } = createModuleWithLessons(otherCourse.id, "M1", 1, 1);
      enrollUser(base.user.id, base.course.id, false, false);

      const result = completeLesson({
        userId: base.user.id,
        lessonId: lessons[0].id,
        courseId: base.course.id,
      });

      expect(result).toEqual({ ok: false, error: "lesson-not-in-course" });
      // No writes to any table for this user.
      expect(isLessonCompleted(base.user.id, lessons[0].id)).toBe(false);
      expect(getTotalXp(base.user.id)).toBe(0);
      expect(streakActivityCount(base.user.id)).toBe(0);
    });
  });
});
