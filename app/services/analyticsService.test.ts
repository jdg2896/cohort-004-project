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
  getCourseQuizDistributions,
  getPortfolioAnalytics,
  getPortfolioTrends,
  getPlatformAnalytics,
  getPlatformRevenueTrend,
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
      expect(funnel.lessons.map((l) => l.completionRate)).toEqual([
        1, 0.5, 0.25,
      ]);
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

  // ─── Quiz score distributions ───

  describe("getCourseQuizDistributions", () => {
    // A module at `modulePosition` with `count` lessons (positions 1..count),
    // titled with `prefix` so order is easy to assert. Returns the lesson ids.
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

    function addQuiz(
      lessonId: number,
      passingScore: number,
      title = "Quiz"
    ): number {
      return testDb
        .insert(schema.quizzes)
        .values({ lessonId, title, passingScore })
        .returning()
        .get().id;
    }

    // Records one attempt; `passed` mirrors the seed's score >= 0.7 rule, but the
    // service derives pass rate from the quiz threshold, not this flag.
    function attempt(userId: number, quizId: number, score: number) {
      testDb
        .insert(schema.quizAttempts)
        .values({ userId, quizId, score, passed: score >= 0.7 })
        .run();
    }

    it("returns an empty array for a course with no quizzes (suppression)", () => {
      addLessons(base.course.id, 2); // lessons but no quizzes
      expect(getCourseQuizDistributions(base.course.id)).toEqual([]);
    });

    it("returns an empty array for a course with no lessons", () => {
      expect(getCourseQuizDistributions(base.course.id)).toEqual([]);
    });

    it("lists quizzes in module→lesson order regardless of insertion order", () => {
      // Insert the later module first to prove ordering is by position, not id.
      const [b1] = addModuleWithLessons(base.course.id, 2, 1, "B");
      const [a1, a2] = addModuleWithLessons(base.course.id, 1, 2, "A");

      addQuiz(b1, 0.7, "Quiz B1");
      addQuiz(a2, 0.7, "Quiz A2");
      addQuiz(a1, 0.7, "Quiz A1");

      const result = getCourseQuizDistributions(base.course.id);

      expect(result.map((q) => q.title)).toEqual([
        "Quiz A1",
        "Quiz A2",
        "Quiz B1",
      ]);
    });

    it("buckets each student's best attempt into the fixed bands", () => {
      const [lesson] = addLessons(base.course.id, 1);
      const quizId = addQuiz(lesson, 0.7);

      // One student per boundary-ish score: 40 → 0–50, 50 → 50–70, 70 → 70–90,
      // 90 and 100 → 90–100.
      [0.4, 0.5, 0.7, 0.9, 1.0].forEach((score) => {
        attempt(makeStudent(), quizId, score);
      });

      const [quiz] = getCourseQuizDistributions(base.course.id);

      expect(quiz.buckets.map((b) => [b.min, b.max])).toEqual([
        [0, 50],
        [50, 70],
        [70, 90],
        [90, 100],
      ]);
      expect(quiz.buckets.map((b) => b.count)).toEqual([1, 1, 1, 2]);
      expect(quiz.studentCount).toBe(5);
    });

    it("uses each student's best (max) attempt, counting the student once", () => {
      const [lesson] = addLessons(base.course.id, 1);
      const quizId = addQuiz(lesson, 0.7);
      const student = makeStudent();

      attempt(student, quizId, 0.4); // first try, would land in 0–50
      attempt(student, quizId, 0.95); // retake, the best → 90–100

      const [quiz] = getCourseQuizDistributions(base.course.id);

      expect(quiz.studentCount).toBe(1);
      expect(quiz.buckets.map((b) => b.count)).toEqual([0, 0, 0, 1]);
    });

    it("derives pass rate from the quiz threshold and averages best attempts", () => {
      const [lesson] = addLessons(base.course.id, 1);
      const quizId = addQuiz(lesson, 0.7);

      attempt(makeStudent(), quizId, 0.6); // below threshold
      attempt(makeStudent(), quizId, 0.7); // exactly at threshold → pass
      attempt(makeStudent(), quizId, 0.95); // above threshold

      const [quiz] = getCourseQuizDistributions(base.course.id);

      // 2 of 3 best attempts meet the 0.7 threshold.
      expect(quiz.passRate).toBeCloseTo(2 / 3);
      // mean(0.6, 0.7, 0.95) = 0.75
      expect(quiz.averageScore).toBeCloseTo(0.75);
    });

    it("counts a student as passing only on their best attempt", () => {
      const [lesson] = addLessons(base.course.id, 1);
      const quizId = addQuiz(lesson, 0.7);
      const student = makeStudent();

      attempt(student, quizId, 0.5); // fail
      attempt(student, quizId, 0.8); // best → pass

      const [quiz] = getCourseQuizDistributions(base.course.id);

      expect(quiz.passRate).toBe(1);
    });

    it("reports a quiz with no attempts as a neutral empty distribution", () => {
      const [lesson] = addLessons(base.course.id, 1);
      addQuiz(lesson, 0.7);

      const [quiz] = getCourseQuizDistributions(base.course.id);

      expect(quiz.studentCount).toBe(0);
      expect(quiz.passRate).toBeNull();
      expect(quiz.averageScore).toBeNull();
      expect(quiz.buckets.map((b) => b.count)).toEqual([0, 0, 0, 0]);
    });

    it("scopes quizzes and attempts to the course", () => {
      const [lesson] = addLessons(base.course.id, 1);
      const quizId = addQuiz(lesson, 0.7);
      attempt(makeStudent(), quizId, 0.8);

      // Another instructor's course with its own quiz and attempts.
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
      const otherMod = testDb
        .insert(schema.modules)
        .values({ courseId: otherCourse.id, title: "M", position: 1 })
        .returning()
        .get();
      const otherLesson = testDb
        .insert(schema.lessons)
        .values({ moduleId: otherMod.id, title: "L", position: 1 })
        .returning()
        .get();
      const otherQuiz = addQuiz(otherLesson.id, 0.7, "Other Quiz");
      attempt(makeStudent(), otherQuiz, 0.4);

      const result = getCourseQuizDistributions(base.course.id);

      expect(result).toHaveLength(1);
      expect(result[0].quizId).toBe(quizId);
      expect(result[0].studentCount).toBe(1);
    });

    it("reflects the quiz's own passing threshold in pass rate", () => {
      const [lesson] = addLessons(base.course.id, 1);
      const quizId = addQuiz(lesson, 0.6); // lower threshold than the seed's 0.7

      attempt(makeStudent(), quizId, 0.65); // passes at 0.6, would fail at 0.7

      const [quiz] = getCourseQuizDistributions(base.course.id);

      expect(quiz.passingScore).toBe(0.6);
      expect(quiz.passRate).toBe(1);
    });
  });

  // ─── Portfolio overview ───

  describe("portfolio overview", () => {
    let courseSeq = 0;

    // A second instructor (distinct from base.instructor) with no courses.
    function makeInstructor(): number {
      studentSeq += 1;
      return testDb
        .insert(schema.users)
        .values({
          name: `Instructor ${studentSeq}`,
          email: `instructor-${studentSeq}@example.com`,
          role: schema.UserRole.Instructor,
        })
        .returning()
        .get().id;
    }

    // A published course owned by `instructorId`; slug is auto-unique.
    function makeCourse(instructorId: number, title: string) {
      courseSeq += 1;
      return testDb
        .insert(schema.courses)
        .values({
          title,
          slug: `portfolio-course-${courseSeq}`,
          description: "A portfolio course",
          instructorId,
          categoryId: base.category.id,
          status: schema.CourseStatus.Published,
        })
        .returning()
        .get();
    }

    // Enrolls an existing user (unlike top-level `enroll`, which makes a new one).
    function enrollUser(
      userId: number,
      courseId: number,
      completedAt?: string
    ) {
      testDb
        .insert(schema.enrollments)
        .values({ userId, courseId, completedAt: completedAt ?? null })
        .run();
    }

    function addQuiz(lessonId: number, passingScore: number): number {
      return testDb
        .insert(schema.quizzes)
        .values({ lessonId, title: "Quiz", passingScore })
        .returning()
        .get().id;
    }

    function attempt(userId: number, quizId: number, score: number) {
      testDb
        .insert(schema.quizAttempts)
        .values({ userId, quizId, score, passed: score >= 0.7 })
        .run();
    }

    describe("getPortfolioAnalytics", () => {
      it("returns all-zero totals and an empty course list for an instructor with no courses", () => {
        const lonely = makeInstructor();

        const result = getPortfolioAnalytics(lonely);

        expect(result.totalEarnings).toBe(0);
        expect(result.totalEnrollments).toBe(0);
        expect(result.distinctLearners).toBe(0);
        expect(result.averageCompletion).toBeNull();
        expect(result.courses).toEqual([]);
      });

      it("sums enrollments and earnings across the instructor's courses", () => {
        const course2 = makeCourse(base.instructor.id, "Second Course");

        enroll(base.course.id);
        enroll(base.course.id);
        enroll(course2.id);
        purchase(base.course.id, 5000);
        purchase(course2.id, 2500);

        const result = getPortfolioAnalytics(base.instructor.id);

        expect(result.totalEnrollments).toBe(3);
        expect(result.totalEarnings).toBe(7500);
        expect(result.courses).toHaveLength(2);
      });

      it("counts a learner enrolled in multiple of the instructor's courses once", () => {
        const course2 = makeCourse(base.instructor.id, "Second Course");
        const shared = makeStudent();

        enrollUser(shared, base.course.id);
        enrollUser(shared, course2.id);
        enroll(base.course.id); // a different, single-course learner

        const result = getPortfolioAnalytics(base.instructor.id);

        // 3 enrollment rows, but only 2 distinct people.
        expect(result.totalEnrollments).toBe(3);
        expect(result.distinctLearners).toBe(2);
      });

      it("reports per-course completion and averages it across enrolled courses", () => {
        const now = new Date().toISOString();
        const course2 = makeCourse(base.instructor.id, "Second Course");

        enroll(base.course.id, now); // 2 enrolled, 1 complete → 0.5
        enroll(base.course.id);
        enroll(course2.id, now); // 1 enrolled, 1 complete → 1.0

        const result = getPortfolioAnalytics(base.instructor.id);
        const byId = new Map(result.courses.map((c) => [c.courseId, c]));

        expect(byId.get(base.course.id)?.completionRate).toBe(0.5);
        expect(byId.get(course2.id)?.completionRate).toBe(1);
        // mean(0.5, 1) = 0.75
        expect(result.averageCompletion).toBe(0.75);
      });

      it("excludes courses with no enrollments from the average completion", () => {
        const empty = makeCourse(base.instructor.id, "Empty Course");
        enroll(base.course.id); // 1 enrolled, 0 complete → rate 0

        const result = getPortfolioAnalytics(base.instructor.id);
        const byId = new Map(result.courses.map((c) => [c.courseId, c]));

        // The empty course is null and ignored; the average is just the enrolled
        // course's rate, not pulled toward null.
        expect(byId.get(empty.id)?.completionRate).toBeNull();
        expect(result.averageCompletion).toBe(0);
      });

      it("reports null average completion when no course has any enrollment", () => {
        makeCourse(base.instructor.id, "Another Empty Course");

        const result = getPortfolioAnalytics(base.instructor.id);

        expect(result.averageCompletion).toBeNull();
      });

      it("averages each course's best quiz attempts into the comparison row", () => {
        const [lesson] = addLessons(base.course.id, 1);
        const quizId = addQuiz(lesson, 0.7);

        attempt(makeStudent(), quizId, 0.6);
        attempt(makeStudent(), quizId, 0.8);

        const result = getPortfolioAnalytics(base.instructor.id);
        const row = result.courses.find((c) => c.courseId === base.course.id);

        // mean(0.6, 0.8) = 0.7
        expect(row?.averageQuizScore).toBeCloseTo(0.7);
      });

      it("uses each student's best attempt for the course's average quiz score", () => {
        const [lesson] = addLessons(base.course.id, 1);
        const quizId = addQuiz(lesson, 0.7);
        const retaker = makeStudent();

        attempt(retaker, quizId, 0.4);
        attempt(retaker, quizId, 0.9); // best for this student
        attempt(makeStudent(), quizId, 0.7);

        const result = getPortfolioAnalytics(base.instructor.id);
        const row = result.courses.find((c) => c.courseId === base.course.id);

        // best-per-student: mean(0.9, 0.7) = 0.8
        expect(row?.averageQuizScore).toBeCloseTo(0.8);
      });

      it("reports a null average quiz score for a course with no quiz attempts", () => {
        const result = getPortfolioAnalytics(base.instructor.id);
        const row = result.courses.find((c) => c.courseId === base.course.id);

        expect(row?.averageQuizScore).toBeNull();
      });

      it("scopes totals and rows to the instructor's own courses", () => {
        const other = makeInstructor();
        const otherCourse = makeCourse(other, "Other Instructor's Course");

        enroll(otherCourse.id);
        purchase(otherCourse.id, 9999);
        enroll(base.course.id);
        purchase(base.course.id, 1000);

        const result = getPortfolioAnalytics(base.instructor.id);

        expect(result.courses).toHaveLength(1);
        expect(result.courses[0].courseId).toBe(base.course.id);
        expect(result.totalEnrollments).toBe(1);
        expect(result.totalEarnings).toBe(1000);
      });

      it("orders comparison rows by course title", () => {
        makeCourse(base.instructor.id, "Zebra");
        makeCourse(base.instructor.id, "Apple");

        const result = getPortfolioAnalytics(base.instructor.id);

        // base.course is titled "Test Course".
        expect(result.courses.map((c) => c.title)).toEqual([
          "Apple",
          "Test Course",
          "Zebra",
        ]);
      });
    });

    describe("getPortfolioTrends", () => {
      // Anchor "now" so week buckets and the window are deterministic.
      const NOW = "2026-06-09T00:00:00.000Z";

      beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(NOW));
      });

      afterEach(() => {
        vi.useRealTimers();
      });

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
        const { weeks } = getPortfolioTrends(base.instructor.id);

        expect(weeks).toHaveLength(12);
        expect(weeks.every((w) => w.revenue === 0 && w.enrollments === 0)).toBe(
          true
        );
      });

      it("returns a zero-filled window for an instructor with no courses", () => {
        const lonely = makeInstructor();

        const { weeks } = getPortfolioTrends(lonely);

        expect(weeks).toHaveLength(12);
        expect(weeks.every((w) => w.revenue === 0 && w.enrollments === 0)).toBe(
          true
        );
      });

      it("aggregates revenue and enrollments across the instructor's courses into weekly buckets", () => {
        const course2 = makeCourse(base.instructor.id, "Second Course");

        purchaseAt({
          courseId: base.course.id,
          pricePaid: 5000,
          createdAt: daysAgo(3),
        });
        purchaseAt({
          courseId: course2.id,
          pricePaid: 2500,
          createdAt: daysAgo(2),
        });
        enrollAt({ courseId: base.course.id, enrolledAt: daysAgo(3) }); // newest week
        enrollAt({ courseId: course2.id, enrolledAt: daysAgo(80) }); // oldest week

        const { weeks } = getPortfolioTrends(base.instructor.id);

        // Both courses' recent purchases land in the most recent bucket.
        expect(weeks[11].revenue).toBe(7500);
        expect(weeks[11].enrollments).toBe(1);
        expect(weeks[0].enrollments).toBe(1);
        expect(weeks.reduce((sum, w) => sum + w.revenue, 0)).toBe(7500);
      });

      it("excludes other instructors' courses from the portfolio trends", () => {
        const other = makeInstructor();
        const otherCourse = makeCourse(other, "Other Instructor's Course");

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

        const { weeks } = getPortfolioTrends(base.instructor.id);

        expect(weeks.reduce((sum, w) => sum + w.revenue, 0)).toBe(4000);
      });
    });
  });

  // ─── Platform-wide admin analytics ───

  describe("getPlatformAnalytics", () => {
    const NOW = "2026-06-09T00:00:00.000Z";

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(NOW));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function daysAgo(n: number): string {
      return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
    }

    let courseSeq = 0;

    function makeInstructor(): number {
      studentSeq += 1;
      return testDb
        .insert(schema.users)
        .values({
          name: `Instructor ${studentSeq}`,
          email: `platform-instructor-${studentSeq}@example.com`,
          role: schema.UserRole.Instructor,
        })
        .returning()
        .get().id;
    }

    function makeCourse(instructorId: number, title: string) {
      courseSeq += 1;
      return testDb
        .insert(schema.courses)
        .values({
          title,
          slug: `platform-course-${courseSeq}`,
          description: "A platform course",
          instructorId,
          categoryId: base.category.id,
          status: schema.CourseStatus.Published,
        })
        .returning()
        .get();
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

    it("returns zeros and null top course when there is no data", () => {
      const result = getPlatformAnalytics("all");

      expect(result.totalRevenue).toBe(0);
      expect(result.totalEnrollments).toBe(0);
      expect(result.topCourse).toBeNull();
    });

    it("sums revenue and enrollments across all instructors and courses", () => {
      const other = makeInstructor();
      const otherCourse = makeCourse(other, "Other Course");

      purchaseAt({
        courseId: base.course.id,
        pricePaid: 5000,
        createdAt: daysAgo(3),
      });
      purchaseAt({
        courseId: otherCourse.id,
        pricePaid: 2500,
        createdAt: daysAgo(3),
      });
      enrollAt({ courseId: base.course.id, enrolledAt: daysAgo(3) });
      enrollAt({ courseId: otherCourse.id, enrolledAt: daysAgo(3) });

      const result = getPlatformAnalytics("all");

      expect(result.totalRevenue).toBe(7500);
      expect(result.totalEnrollments).toBe(2);
    });

    it("identifies the top earning course", () => {
      const other = makeInstructor();
      const otherCourse = makeCourse(other, "Big Earner");

      purchaseAt({
        courseId: base.course.id,
        pricePaid: 1000,
        createdAt: daysAgo(3),
      });
      purchaseAt({
        courseId: otherCourse.id,
        pricePaid: 9999,
        createdAt: daysAgo(3),
      });

      const result = getPlatformAnalytics("all");

      expect(result.topCourse).toEqual({
        title: "Big Earner",
        revenue: 9999,
      });
    });

    it("filters to the 7d window", () => {
      purchaseAt({
        courseId: base.course.id,
        pricePaid: 5000,
        createdAt: daysAgo(3),
      });
      purchaseAt({
        courseId: base.course.id,
        pricePaid: 2000,
        createdAt: daysAgo(10),
      });
      enrollAt({ courseId: base.course.id, enrolledAt: daysAgo(3) });
      enrollAt({ courseId: base.course.id, enrolledAt: daysAgo(10) });

      const result = getPlatformAnalytics("7d");

      expect(result.totalRevenue).toBe(5000);
      expect(result.totalEnrollments).toBe(1);
    });

    it("filters to the 30d window", () => {
      purchaseAt({
        courseId: base.course.id,
        pricePaid: 5000,
        createdAt: daysAgo(15),
      });
      purchaseAt({
        courseId: base.course.id,
        pricePaid: 2000,
        createdAt: daysAgo(60),
      });

      const result = getPlatformAnalytics("30d");

      expect(result.totalRevenue).toBe(5000);
    });

    it("filters to the 12m window", () => {
      purchaseAt({
        courseId: base.course.id,
        pricePaid: 5000,
        createdAt: daysAgo(100),
      });
      purchaseAt({
        courseId: base.course.id,
        pricePaid: 2000,
        createdAt: daysAgo(400),
      });

      const result = getPlatformAnalytics("12m");

      expect(result.totalRevenue).toBe(5000);
    });

    it("includes all data with the 'all' period", () => {
      purchaseAt({
        courseId: base.course.id,
        pricePaid: 5000,
        createdAt: daysAgo(3),
      });
      purchaseAt({
        courseId: base.course.id,
        pricePaid: 2000,
        createdAt: daysAgo(400),
      });

      const result = getPlatformAnalytics("all");

      expect(result.totalRevenue).toBe(7000);
    });

    it("scopes the top course to the selected time period", () => {
      const other = makeInstructor();
      const otherCourse = makeCourse(other, "Recent Winner");

      purchaseAt({
        courseId: base.course.id,
        pricePaid: 9000,
        createdAt: daysAgo(60),
      });
      purchaseAt({
        courseId: otherCourse.id,
        pricePaid: 3000,
        createdAt: daysAgo(3),
      });

      const result = getPlatformAnalytics("30d");

      expect(result.topCourse?.title).toBe("Recent Winner");
      expect(result.topCourse?.revenue).toBe(3000);
    });
  });

  // ─── Platform revenue trend ───

  describe("getPlatformRevenueTrend", () => {
    const NOW = "2026-06-09T00:00:00.000Z";

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(NOW));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function daysAgo(n: number): string {
      return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
    }

    let courseSeq = 0;

    function makeInstructor(): number {
      studentSeq += 1;
      return testDb
        .insert(schema.users)
        .values({
          name: `Instructor ${studentSeq}`,
          email: `trend-instructor-${studentSeq}@example.com`,
          role: schema.UserRole.Instructor,
        })
        .returning()
        .get().id;
    }

    function makeCourse(instructorId: number, title: string) {
      courseSeq += 1;
      return testDb
        .insert(schema.courses)
        .values({
          title,
          slug: `trend-course-${courseSeq}`,
          description: "A trend course",
          instructorId,
          categoryId: base.category.id,
          status: schema.CourseStatus.Published,
        })
        .returning()
        .get();
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

    describe("daily granularity (7d, 30d)", () => {
      it("returns a zero-filled daily series for 7d when there are no purchases", () => {
        const points = getPlatformRevenueTrend("7d");

        expect(points.length).toBe(8); // 7 days ago through today
        expect(points.every((p) => p.revenue === 0)).toBe(true);
        expect(points[0].date).toBe("2026-06-02");
        expect(points[points.length - 1].date).toBe("2026-06-09");
      });

      it("returns a zero-filled daily series for 30d", () => {
        const points = getPlatformRevenueTrend("30d");

        expect(points.length).toBe(31); // 30 days ago through today
        expect(points[0].date).toBe("2026-05-10");
        expect(points[points.length - 1].date).toBe("2026-06-09");
      });

      it("buckets revenue into the correct day", () => {
        purchaseAt({
          courseId: base.course.id,
          pricePaid: 5000,
          createdAt: "2026-06-07T12:00:00.000Z",
        });

        const points = getPlatformRevenueTrend("7d");
        const june7 = points.find((p) => p.date === "2026-06-07");

        expect(june7?.revenue).toBe(5000);
        expect(
          points
            .filter((p) => p.date !== "2026-06-07")
            .every((p) => p.revenue === 0)
        ).toBe(true);
      });

      it("sums multiple purchases on the same day", () => {
        purchaseAt({
          courseId: base.course.id,
          pricePaid: 3000,
          createdAt: "2026-06-08T10:00:00.000Z",
        });
        purchaseAt({
          courseId: base.course.id,
          pricePaid: 2000,
          createdAt: "2026-06-08T18:00:00.000Z",
        });

        const points = getPlatformRevenueTrend("7d");
        const june8 = points.find((p) => p.date === "2026-06-08");

        expect(june8?.revenue).toBe(5000);
      });

      it("excludes purchases outside the time window", () => {
        purchaseAt({
          courseId: base.course.id,
          pricePaid: 9999,
          createdAt: daysAgo(10),
        });
        purchaseAt({
          courseId: base.course.id,
          pricePaid: 4000,
          createdAt: daysAgo(3),
        });

        const points = getPlatformRevenueTrend("7d");
        const total = points.reduce((sum, p) => sum + p.revenue, 0);

        expect(total).toBe(4000);
      });

      it("aggregates revenue across all instructors and courses", () => {
        const other = makeInstructor();
        const otherCourse = makeCourse(other, "Other Course");

        purchaseAt({
          courseId: base.course.id,
          pricePaid: 3000,
          createdAt: "2026-06-08T10:00:00.000Z",
        });
        purchaseAt({
          courseId: otherCourse.id,
          pricePaid: 2000,
          createdAt: "2026-06-08T14:00:00.000Z",
        });

        const points = getPlatformRevenueTrend("7d");
        const june8 = points.find((p) => p.date === "2026-06-08");

        expect(june8?.revenue).toBe(5000);
      });
    });

    describe("monthly granularity (12m, all)", () => {
      it("returns a zero-filled monthly series for 12m", () => {
        const points = getPlatformRevenueTrend("12m");

        expect(points[0].date).toBe("2025-06");
        expect(points[points.length - 1].date).toBe("2026-06");
        expect(points.length).toBe(13); // Jun 2025 through Jun 2026
        expect(points.every((p) => p.revenue === 0)).toBe(true);
      });

      it("buckets revenue into the correct month for 12m", () => {
        purchaseAt({
          courseId: base.course.id,
          pricePaid: 7500,
          createdAt: "2026-03-15T12:00:00.000Z",
        });

        const points = getPlatformRevenueTrend("12m");
        const march = points.find((p) => p.date === "2026-03");

        expect(march?.revenue).toBe(7500);
      });

      it("returns an empty array for 'all' when there are no purchases", () => {
        const points = getPlatformRevenueTrend("all");

        expect(points).toEqual([]);
      });

      it("spans from earliest purchase month to current month for 'all'", () => {
        purchaseAt({
          courseId: base.course.id,
          pricePaid: 1000,
          createdAt: "2025-11-20T10:00:00.000Z",
        });
        purchaseAt({
          courseId: base.course.id,
          pricePaid: 2000,
          createdAt: "2026-04-10T10:00:00.000Z",
        });

        const points = getPlatformRevenueTrend("all");

        expect(points[0].date).toBe("2025-11");
        expect(points[points.length - 1].date).toBe("2026-06");
        expect(points.length).toBe(8); // Nov 2025 through Jun 2026

        expect(points.find((p) => p.date === "2025-11")?.revenue).toBe(1000);
        expect(points.find((p) => p.date === "2026-04")?.revenue).toBe(2000);
        expect(points.find((p) => p.date === "2026-01")?.revenue).toBe(0);
      });

      it("sums revenue from all instructors into monthly buckets", () => {
        const other = makeInstructor();
        const otherCourse = makeCourse(other, "Other Course");

        purchaseAt({
          courseId: base.course.id,
          pricePaid: 3000,
          createdAt: "2026-03-10T10:00:00.000Z",
        });
        purchaseAt({
          courseId: otherCourse.id,
          pricePaid: 4000,
          createdAt: "2026-03-20T10:00:00.000Z",
        });

        const points = getPlatformRevenueTrend("12m");
        const march = points.find((p) => p.date === "2026-03");

        expect(march?.revenue).toBe(7000);
      });
    });
  });
});
