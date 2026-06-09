import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import {
  getCourseAnalytics,
  getCourseTrends,
  getCourseFunnel,
} from "./analyticsService";

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

  // ─── Weekly trends ───

  describe("getCourseTrends", () => {
    // Anchor "now" so week buckets and the window are deterministic.
    const NOW = "2026-06-09T00:00:00.000Z";

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(NOW));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // ISO timestamp `n` whole days before the (faked) current time.
    function daysAgo(n: number): string {
      return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
    }

    function purchaseAt(opts: {
      courseId: number;
      pricePaid: number;
      createdAt: string;
    }) {
      testDb
        .insert(schema.purchases)
        .values({
          userId: makeStudent(),
          courseId: opts.courseId,
          pricePaid: opts.pricePaid,
          country: null,
          createdAt: opts.createdAt,
        })
        .run();
    }

    function enrollAt(opts: { courseId: number; enrolledAt: string }) {
      testDb
        .insert(schema.enrollments)
        .values({
          userId: makeStudent(),
          courseId: opts.courseId,
          enrolledAt: opts.enrolledAt,
          completedAt: null,
        })
        .run();
    }

    it("returns a zero-filled 12-week series when there is no activity", () => {
      const { weeks } = getCourseTrends(base.course.id);

      expect(weeks).toHaveLength(12);
      expect(weeks.every((w) => w.revenue === 0 && w.enrollments === 0)).toBe(
        true
      );

      // Week starts are 12 distinct dates in ascending (oldest → newest) order.
      const starts = weeks.map((w) => w.weekStart);
      expect(new Set(starts).size).toBe(12);
      expect(starts).toEqual([...starts].sort());
    });

    it("buckets revenue into the matching week and zero-fills the rest", () => {
      // daysAgo(3) lands in the most recent 7-day bucket (the last point).
      purchaseAt({
        courseId: base.course.id,
        pricePaid: 5000,
        createdAt: daysAgo(3),
      });

      const { weeks } = getCourseTrends(base.course.id);

      expect(weeks[11].revenue).toBe(5000);
      expect(weeks.slice(0, 11).every((w) => w.revenue === 0)).toBe(true);
    });

    it("places older activity in an earlier bucket than recent activity", () => {
      purchaseAt({
        courseId: base.course.id,
        pricePaid: 5000,
        createdAt: daysAgo(3), // newest week
      });
      purchaseAt({
        courseId: base.course.id,
        pricePaid: 2500,
        createdAt: daysAgo(80), // oldest week
      });

      const { weeks } = getCourseTrends(base.course.id);

      expect(weeks[11].revenue).toBe(5000);
      expect(weeks[0].revenue).toBe(2500);
      expect(weeks.reduce((sum, w) => sum + w.revenue, 0)).toBe(7500);
    });

    it("sums multiple purchases that fall in the same week", () => {
      purchaseAt({
        courseId: base.course.id,
        pricePaid: 5000,
        createdAt: daysAgo(2),
      });
      purchaseAt({
        courseId: base.course.id,
        pricePaid: 1500,
        createdAt: daysAgo(4),
      });

      const { weeks } = getCourseTrends(base.course.id);

      expect(weeks[11].revenue).toBe(6500);
    });

    it("counts new enrollments per week", () => {
      enrollAt({ courseId: base.course.id, enrolledAt: daysAgo(3) });
      enrollAt({ courseId: base.course.id, enrolledAt: daysAgo(3) });
      enrollAt({ courseId: base.course.id, enrolledAt: daysAgo(80) });

      const { weeks } = getCourseTrends(base.course.id);

      expect(weeks[11].enrollments).toBe(2);
      expect(weeks[0].enrollments).toBe(1);
      expect(weeks.reduce((sum, w) => sum + w.enrollments, 0)).toBe(3);
    });

    it("excludes activity older than the 12-week window", () => {
      purchaseAt({
        courseId: base.course.id,
        pricePaid: 9999,
        createdAt: daysAgo(90), // before the window
      });
      purchaseAt({
        courseId: base.course.id,
        pricePaid: 4000,
        createdAt: daysAgo(10), // inside the window
      });

      const { weeks } = getCourseTrends(base.course.id);

      expect(weeks.reduce((sum, w) => sum + w.revenue, 0)).toBe(4000);
      expect(weeks[10].revenue).toBe(4000);
    });

    it("counts activity at exactly 'now' in the most recent bucket", () => {
      purchaseAt({
        courseId: base.course.id,
        pricePaid: 1234,
        createdAt: daysAgo(0),
      });

      const { weeks } = getCourseTrends(base.course.id);

      expect(weeks[11].revenue).toBe(1234);
    });

    it("scopes trends to the given course", () => {
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

      purchaseAt({
        courseId: otherCourse.id,
        pricePaid: 8888,
        createdAt: daysAgo(5),
      });
      purchaseAt({
        courseId: base.course.id,
        pricePaid: 4000,
        createdAt: daysAgo(5),
      });

      const { weeks } = getCourseTrends(base.course.id);

      expect(weeks.reduce((sum, w) => sum + w.revenue, 0)).toBe(4000);
    });
  });

  // ─── Lesson-completion funnel ───

  describe("getCourseFunnel", () => {
    // A module at the given position with `count` lessons (positions 1..count);
    // each lesson titled with `prefix` so order is easy to assert. Returns ids.
    function addModuleWithLessons(
      courseId: number,
      modulePosition: number,
      count: number,
      prefix: string
    ): number[] {
      const mod = testDb
        .insert(schema.modules)
        .values({
          courseId,
          title: `Module ${modulePosition}`,
          position: modulePosition,
        })
        .returning()
        .get();

      const ids: number[] = [];
      for (let i = 0; i < count; i++) {
        const lesson = testDb
          .insert(schema.lessons)
          .values({
            moduleId: mod.id,
            title: `${prefix}${i + 1}`,
            position: i + 1,
          })
          .returning()
          .get();
        ids.push(lesson.id);
      }
      return ids;
    }

    function enrollMany(courseId: number, n: number): number[] {
      return Array.from({ length: n }, () => enroll(courseId));
    }

    it("returns an empty lessons array for a zero-lesson course (suppression)", () => {
      enroll(base.course.id);
      enroll(base.course.id);

      const funnel = getCourseFunnel(base.course.id);

      expect(funnel.lessons).toEqual([]);
      expect(funnel.enrollmentCount).toBe(2);
    });

    it("lists lessons in module→lesson order regardless of insertion order", () => {
      // Insert the later module first to prove ordering is by position, not id.
      addModuleWithLessons(base.course.id, 2, 2, "B");
      addModuleWithLessons(base.course.id, 1, 2, "A");

      const funnel = getCourseFunnel(base.course.id);

      expect(funnel.lessons.map((l) => l.title)).toEqual([
        "A1",
        "A2",
        "B1",
        "B2",
      ]);
    });

    it("reports each lesson's completion share across enrolled students", () => {
      const [l1, l2, l3] = addModuleWithLessons(base.course.id, 1, 3, "L");
      const students = enrollMany(base.course.id, 4);

      students.forEach((s) => completeLessons(s, [l1])); // 4/4
      students.slice(0, 2).forEach((s) => completeLessons(s, [l2])); // 2/4
      completeLessons(students[0], [l3]); // 1/4

      const funnel = getCourseFunnel(base.course.id);

      expect(funnel.enrollmentCount).toBe(4);
      expect(funnel.lessons.map((l) => l.completedCount)).toEqual([4, 2, 1]);
      expect(funnel.lessons.map((l) => l.completionRate)).toEqual([1, 0.5, 0.25]);
    });

    it("counts only enrolled students' completions", () => {
      const [l1] = addModuleWithLessons(base.course.id, 1, 1, "L");
      const enrolled = enroll(base.course.id);
      completeLessons(enrolled, [l1]);

      // A user who completed the lesson but never enrolled must not be counted.
      const nonEnrolled = makeStudent();
      completeLessons(nonEnrolled, [l1]);

      // Nor a student enrolled only in a different course.
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
      const elsewhere = enroll(otherCourse.id);
      completeLessons(elsewhere, [l1]);

      const funnel = getCourseFunnel(base.course.id);

      expect(funnel.enrollmentCount).toBe(1);
      expect(funnel.lessons[0].completedCount).toBe(1);
      expect(funnel.lessons[0].completionRate).toBe(1);
    });

    it("flags the single lesson with the largest drop from the previous lesson", () => {
      const [l1, l2, l3, l4] = addModuleWithLessons(base.course.id, 1, 4, "L");
      const students = enrollMany(base.course.id, 10);

      students.forEach((s) => completeLessons(s, [l1])); // 10
      students.slice(0, 9).forEach((s) => completeLessons(s, [l2])); // 9 (drop 1)
      students.slice(0, 3).forEach((s) => completeLessons(s, [l3])); // 3 (drop 6) ← biggest
      students.slice(0, 2).forEach((s) => completeLessons(s, [l4])); // 2 (drop 1)

      const funnel = getCourseFunnel(base.course.id);

      expect(funnel.lessons.map((l) => l.isBiggestDropOff)).toEqual([
        false,
        false,
        true,
        false,
      ]);
    });

    it("resolves a tie for the biggest drop to the earliest lesson", () => {
      const [l1, l2] = addModuleWithLessons(base.course.id, 1, 3, "L");
      const students = enrollMany(base.course.id, 10);

      students.forEach((s) => completeLessons(s, [l1])); // 10
      students.slice(0, 5).forEach((s) => completeLessons(s, [l2])); // 5 (drop 5)
      // l3 stays at 0 (drop 5 again) — same magnitude, but later.

      const funnel = getCourseFunnel(base.course.id);

      expect(funnel.lessons.map((l) => l.isBiggestDropOff)).toEqual([
        false,
        true,
        false,
      ]);
    });

    it("flags nothing when completion never decreases", () => {
      const [l1, l2, l3] = addModuleWithLessons(base.course.id, 1, 3, "L");
      const students = enrollMany(base.course.id, 3);

      // Non-decreasing (e.g. out-of-order completion): 2 → 3 → 3.
      students.slice(0, 2).forEach((s) => completeLessons(s, [l1]));
      students.forEach((s) => completeLessons(s, [l2]));
      students.forEach((s) => completeLessons(s, [l3]));

      const funnel = getCourseFunnel(base.course.id);

      expect(funnel.lessons.every((l) => !l.isBiggestDropOff)).toBe(true);
    });

    it("reports zero shares without dividing by zero when nobody is enrolled", () => {
      addModuleWithLessons(base.course.id, 1, 2, "L");

      const funnel = getCourseFunnel(base.course.id);

      expect(funnel.enrollmentCount).toBe(0);
      expect(funnel.lessons.map((l) => l.completionRate)).toEqual([0, 0]);
      expect(funnel.lessons.map((l) => l.completedCount)).toEqual([0, 0]);
      expect(funnel.lessons.every((l) => !l.isBiggestDropOff)).toBe(true);
    });
  });
});
