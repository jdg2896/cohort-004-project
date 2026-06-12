import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the module picks up our test db
import {
  isModuleComplete,
  getModuleCompletionXp,
  getModuleCompletionToast,
} from "./moduleCompletionService";
import { markLessonComplete, markLessonInProgress } from "./progressService";

// Helper to create a module with lessons in the test db
function createModuleWithLessons(
  courseId: number,
  moduleTitle: string,
  position: number,
  lessonCount: number
) {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId, title: moduleTitle, position })
    .returning()
    .get();

  const createdLessons = [];
  for (let i = 0; i < lessonCount; i++) {
    const lesson = testDb
      .insert(schema.lessons)
      .values({
        moduleId: mod.id,
        title: `Lesson ${i + 1}`,
        position: i + 1,
      })
      .returning()
      .get();
    createdLessons.push(lesson);
  }

  return { module: mod, lessons: createdLessons };
}

describe("moduleCompletionService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("isModuleComplete", () => {
    it("returns false when no lessons are completed", () => {
      const { module } = createModuleWithLessons(base.course.id, "M1", 1, 3);

      expect(
        isModuleComplete({ userId: base.user.id, moduleId: module.id })
      ).toBe(false);
    });

    it("returns false when only some lessons are completed", () => {
      const { module, lessons } = createModuleWithLessons(
        base.course.id,
        "M1",
        1,
        3
      );

      markLessonComplete(base.user.id, lessons[0].id);
      markLessonComplete(base.user.id, lessons[1].id);

      expect(
        isModuleComplete({ userId: base.user.id, moduleId: module.id })
      ).toBe(false);
    });

    it("returns true when every lesson is completed", () => {
      const { module, lessons } = createModuleWithLessons(
        base.course.id,
        "M1",
        1,
        3
      );

      for (const lesson of lessons) {
        markLessonComplete(base.user.id, lesson.id);
      }

      expect(
        isModuleComplete({ userId: base.user.id, moduleId: module.id })
      ).toBe(true);
    });

    it("does not count in-progress lessons as complete", () => {
      const { module, lessons } = createModuleWithLessons(
        base.course.id,
        "M1",
        1,
        2
      );

      markLessonComplete(base.user.id, lessons[0].id);
      markLessonInProgress(base.user.id, lessons[1].id);

      expect(
        isModuleComplete({ userId: base.user.id, moduleId: module.id })
      ).toBe(false);
    });

    it("returns false for a module with no lessons", () => {
      const mod = testDb
        .insert(schema.modules)
        .values({ courseId: base.course.id, title: "Empty", position: 1 })
        .returning()
        .get();

      expect(isModuleComplete({ userId: base.user.id, moduleId: mod.id })).toBe(
        false
      );
    });

    it("scopes completion to the given user", () => {
      const { module, lessons } = createModuleWithLessons(
        base.course.id,
        "M1",
        1,
        2
      );

      const other = testDb
        .insert(schema.users)
        .values({
          name: "Other Student",
          email: "other@example.com",
          role: schema.UserRole.Student,
        })
        .returning()
        .get();

      // Other user completes everything; base user has not.
      for (const lesson of lessons) {
        markLessonComplete(other.id, lesson.id);
      }

      expect(
        isModuleComplete({ userId: base.user.id, moduleId: module.id })
      ).toBe(false);
      expect(isModuleComplete({ userId: other.id, moduleId: module.id })).toBe(
        true
      );
    });
  });

  describe("getModuleCompletionXp", () => {
    it("is 10 XP per lesson in the module", () => {
      const { module } = createModuleWithLessons(base.course.id, "M1", 1, 4);

      expect(getModuleCompletionXp(module.id)).toBe(40);
    });

    it("is 0 for a module with no lessons", () => {
      const mod = testDb
        .insert(schema.modules)
        .values({ courseId: base.course.id, title: "Empty", position: 1 })
        .returning()
        .get();

      expect(getModuleCompletionXp(mod.id)).toBe(0);
    });
  });

  describe("getModuleCompletionToast", () => {
    it("returns the toast payload when the final lesson finishes the module", () => {
      const { module, lessons } = createModuleWithLessons(
        base.course.id,
        "Getting Started",
        1,
        3
      );

      // Complete the first two, then the last one tips the module over.
      markLessonComplete(base.user.id, lessons[0].id);
      markLessonComplete(base.user.id, lessons[1].id);
      markLessonComplete(base.user.id, lessons[2].id);

      const toast = getModuleCompletionToast({
        userId: base.user.id,
        lessonId: lessons[2].id,
        wasAlreadyComplete: false,
      });

      expect(toast).toEqual({
        moduleId: module.id,
        moduleTitle: "Getting Started",
        xpEarned: 30,
      });
    });

    it("returns null when a non-final lesson is completed", () => {
      const { lessons } = createModuleWithLessons(base.course.id, "M1", 1, 3);

      markLessonComplete(base.user.id, lessons[0].id);

      const toast = getModuleCompletionToast({
        userId: base.user.id,
        lessonId: lessons[0].id,
        wasAlreadyComplete: false,
      });

      expect(toast).toBeNull();
    });

    it("returns null when re-completing an already-complete lesson", () => {
      const { lessons } = createModuleWithLessons(base.course.id, "M1", 1, 2);

      for (const lesson of lessons) {
        markLessonComplete(base.user.id, lesson.id);
      }

      // The module is fully complete, but this lesson was already complete, so
      // re-completing it must not re-fire the toast.
      const toast = getModuleCompletionToast({
        userId: base.user.id,
        lessonId: lessons[1].id,
        wasAlreadyComplete: true,
      });

      expect(toast).toBeNull();
    });

    it("returns null for a missing lesson", () => {
      const toast = getModuleCompletionToast({
        userId: base.user.id,
        lessonId: 999999,
        wasAlreadyComplete: false,
      });

      expect(toast).toBeNull();
    });
  });
});
