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

// Import after the mock so the module picks up our test db.
import { getCourseAnalytics } from "./analyticsService";

describe("analyticsService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  // ─── Fixture helpers ───

  // Adds one module of `count` lessons to a course; returns the lesson ids.
  function addLessons(courseId: number, count: number): number[] {
    const mod = testDb
      .insert(schema.modules)
      .values({ courseId, title: "Module 1", position: 1 })
      .returning()
      .get();

    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      const lesson = testDb
        .insert(schema.lessons)
        .values({ moduleId: mod.id, title: `Lesson ${i + 1}`, position: i + 1 })
        .returning()
        .get();
      ids.push(lesson.id);
    }
    return ids;
  }

  let studentSeq = 0;
  function makeStudent(): number {
    studentSeq += 1;
    return testDb
      .insert(schema.users)
      .values({
        name: `Student ${studentSeq}`,
        email: `student-${studentSeq}@example.com`,
        role: schema.UserRole.Student,
      })
      .returning()
      .get().id;
  }

  // Enrolls a (new) student in a course, optionally pre-stamped as complete.
  function enroll(courseId: number, completedAt?: string): number {
    const userId = makeStudent();
    testDb
      .insert(schema.enrollments)
      .values({ userId, courseId, completedAt: completedAt ?? null })
      .run();
    return userId;
  }

  function completeLessons(userId: number, lessonIds: number[]) {
    for (const lessonId of lessonIds) {
      testDb
        .insert(schema.lessonProgress)
        .values({
          userId,
          lessonId,
          status: schema.LessonProgressStatus.Completed,
          completedAt: new Date().toISOString(),
        })
        .run();
    }
  }

  function purchase(courseId: number, pricePaid: number) {
    testDb
      .insert(schema.purchases)
      .values({ userId: makeStudent(), courseId, pricePaid, country: null })
      .run();
  }

  // ─── Empty / neutral states ───

  describe("with no enrollments and no purchases", () => {
    it("returns neutral values without dividing by zero", () => {
      const result = getCourseAnalytics(base.course.id);

      expect(result.enrollmentCount).toBe(0);
      expect(result.totalEarnings).toBe(0);
      expect(result.completionRate).toBeNull();
      expect(result.averageProgress).toBeNull();
    });
  });

  it("reports $0.00 of earnings (0 cents) when enrolled students have no purchases", () => {
    addLessons(base.course.id, 2);
    enroll(base.course.id);

    const result = getCourseAnalytics(base.course.id);

    expect(result.enrollmentCount).toBe(1);
    expect(result.totalEarnings).toBe(0);
  });

  // ─── Enrollment count ───

  it("counts enrollments for the course", () => {
    enroll(base.course.id);
    enroll(base.course.id);
    enroll(base.course.id);

    expect(getCourseAnalytics(base.course.id).enrollmentCount).toBe(3);
  });

  // ─── Earnings ───

  it("sums gross pricePaid across all of the course's purchases, including extra/seat purchases", () => {
    purchase(base.course.id, 5000);
    purchase(base.course.id, 2500); // e.g. a second seat/team purchase
    purchase(base.course.id, 999);

    expect(getCourseAnalytics(base.course.id).totalEarnings).toBe(8499);
  });

  it("excludes purchases from other courses", () => {
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

    purchase(base.course.id, 5000);
    purchase(otherCourse.id, 9999);

    expect(getCourseAnalytics(base.course.id).totalEarnings).toBe(5000);
  });

  // ─── Completion rate (from the completedAt flag) ───

  it("derives completion rate from enrollments.completedAt", () => {
    enroll(base.course.id, new Date().toISOString()); // complete
    enroll(base.course.id); // not complete
    enroll(base.course.id); // not complete
    enroll(base.course.id); // not complete

    // 1 of 4 enrollments complete.
    expect(getCourseAnalytics(base.course.id).completionRate).toBe(0.25);
  });

  it("reports a completion rate of 1 when every enrollment is complete", () => {
    const now = new Date().toISOString();
    enroll(base.course.id, now);
    enroll(base.course.id, now);

    expect(getCourseAnalytics(base.course.id).completionRate).toBe(1);
  });

  // ─── Average progress (lessons-only mean) ───

  it("averages each enrolled student's lessons-only progress percentage", () => {
    const lessonIds = addLessons(base.course.id, 4);

    const studentA = enroll(base.course.id);
    const studentB = enroll(base.course.id);

    completeLessons(studentA, lessonIds); // 4/4 → 100%
    completeLessons(studentB, lessonIds.slice(0, 1)); // 1/4 → 25%

    // mean(100, 25) = 62.5 → 63
    expect(getCourseAnalytics(base.course.id).averageProgress).toBe(63);
  });

  it("counts an enrolled student with no completed lessons as 0% in the average", () => {
    const lessonIds = addLessons(base.course.id, 4);

    const studentA = enroll(base.course.id);
    enroll(base.course.id); // no progress at all

    completeLessons(studentA, lessonIds); // 100%

    // mean(100, 0) = 50
    expect(getCourseAnalytics(base.course.id).averageProgress).toBe(50);
  });

  it("reports 0% average progress for a zero-lesson course with enrolled students (no divide-by-zero)", () => {
    enroll(base.course.id);
    enroll(base.course.id);

    const result = getCourseAnalytics(base.course.id);
    expect(result.averageProgress).toBe(0);
    expect(result.completionRate).toBe(0);
  });
});
