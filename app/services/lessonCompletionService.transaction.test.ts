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

// Force a mid-cascade failure: the streak write (third of four writes) throws,
// after progress + XP have already been written. Everything else stays real, so
// this is a true boundary test of the transaction's rollback. Scoped to this
// file because the mock would otherwise break the real-streak boundary tests.
vi.mock("~/services/streakService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./streakService")>();
  return {
    ...actual,
    recordStreakActivity: () => {
      throw new Error("simulated mid-cascade failure");
    },
  };
});

// Import after mocks so the service (and everything it composes) picks up the
// test db and the throwing streak write.
import { completeLesson } from "./lessonCompletionService";
import { getTotalXp } from "./gamificationService";
import { isLessonCompleted } from "./progressService";
import { enrollUser, findEnrollment } from "./enrollmentService";

function createModuleWithLessons(courseId: number, lessonCount: number) {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId, title: "M1", position: 1 })
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

function streakActivityCount(userId: number): number {
  return testDb
    .select()
    .from(schema.streakActivities)
    .where(eq(schema.streakActivities.userId, userId))
    .all().length;
}

describe("lessonCompletionService — transaction atomicity", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  it("rolls back every prior write when a mid-cascade step fails", () => {
    const { lessons } = createModuleWithLessons(base.course.id, 2);
    enrollUser(base.user.id, base.course.id, false, false);

    // The streak write throws mid-cascade; completeLesson propagates it after
    // the transaction rolls back.
    expect(() =>
      completeLesson({
        userId: base.user.id,
        lessonId: lessons[0].id,
        courseId: base.course.id,
      })
    ).toThrow("simulated mid-cascade failure");

    // Progress write (first in the cascade) rolled back.
    expect(isLessonCompleted(base.user.id, lessons[0].id)).toBe(false);
    // XP write (second, before the throw) rolled back.
    expect(getTotalXp(base.user.id)).toBe(0);
    // Streak never recorded.
    expect(streakActivityCount(base.user.id)).toBe(0);
    // Enrollment never stamped (and the row itself untouched).
    expect(
      findEnrollment(base.user.id, base.course.id)?.completedAt
    ).toBeNull();
  });
});
