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
  upsertReview,
  getUserReview,
  getCourseRatingSummary,
  getRatingSummaries,
} from "./courseReviewService";

function makeStudent(email: string) {
  return testDb
    .insert(schema.users)
    .values({ name: email, email, role: schema.UserRole.Student })
    .returning()
    .get();
}

describe("courseReviewService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("upsertReview", () => {
    it("creates a review for a course", () => {
      const review = upsertReview(base.user.id, base.course.id, 4);

      expect(review.userId).toBe(base.user.id);
      expect(review.courseId).toBe(base.course.id);
      expect(review.rating).toBe(4);
    });

    it("updates the existing review instead of creating a duplicate", () => {
      upsertReview(base.user.id, base.course.id, 3);
      const updated = upsertReview(base.user.id, base.course.id, 5);

      expect(updated.rating).toBe(5);

      const summary = getCourseRatingSummary(base.course.id);
      expect(summary.count).toBe(1);
      expect(summary.average).toBe(5);
    });

    it("rejects ratings outside the 1–5 range", () => {
      expect(() => upsertReview(base.user.id, base.course.id, 0)).toThrowError();
      expect(() => upsertReview(base.user.id, base.course.id, 6)).toThrowError();
      expect(() =>
        upsertReview(base.user.id, base.course.id, 3.5)
      ).toThrowError();
    });
  });

  describe("getUserReview", () => {
    it("returns the user's review when one exists", () => {
      upsertReview(base.user.id, base.course.id, 4);
      expect(getUserReview(base.user.id, base.course.id)?.rating).toBe(4);
    });

    it("returns undefined when the user has not reviewed", () => {
      expect(getUserReview(base.user.id, base.course.id)).toBeUndefined();
    });
  });

  describe("getCourseRatingSummary", () => {
    it("returns zeroes when there are no reviews", () => {
      expect(getCourseRatingSummary(base.course.id)).toEqual({
        average: 0,
        count: 0,
      });
    });

    it("averages multiple reviews", () => {
      const student2 = makeStudent("s2@example.com");
      const student3 = makeStudent("s3@example.com");
      upsertReview(base.user.id, base.course.id, 5);
      upsertReview(student2.id, base.course.id, 4);
      upsertReview(student3.id, base.course.id, 3);

      const summary = getCourseRatingSummary(base.course.id);
      expect(summary.count).toBe(3);
      expect(summary.average).toBeCloseTo(4);
    });
  });

  describe("getRatingSummaries", () => {
    it("returns an empty map for no course ids", () => {
      expect(getRatingSummaries([]).size).toBe(0);
    });

    it("returns summaries keyed by course id and omits unrated courses", () => {
      const course2 = testDb
        .insert(schema.courses)
        .values({
          title: "Second Course",
          slug: "second-course",
          description: "Another course",
          instructorId: base.instructor.id,
          categoryId: base.category.id,
          status: schema.CourseStatus.Published,
        })
        .returning()
        .get();

      const student2 = makeStudent("s2@example.com");
      upsertReview(base.user.id, base.course.id, 5);
      upsertReview(student2.id, base.course.id, 3);
      upsertReview(base.user.id, course2.id, 4);

      const summaries = getRatingSummaries([base.course.id, course2.id, 9999]);

      expect(summaries.get(base.course.id)).toEqual({ average: 4, count: 2 });
      expect(summaries.get(course2.id)).toEqual({ average: 4, count: 1 });
      expect(summaries.has(9999)).toBe(false);
    });
  });
});
