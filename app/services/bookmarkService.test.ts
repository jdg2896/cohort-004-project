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
  isLessonBookmarked,
  toggleBookmark,
  getBookmarkedLessonIds,
} from "./bookmarkService";

// Creates a module under the given course with `lessonCount` lessons and
// returns the created lesson rows (in position order).
function createModuleWithLessons(opts: {
  courseId: number;
  title: string;
  position: number;
  lessonCount: number;
}) {
  const mod = testDb
    .insert(schema.modules)
    .values({
      courseId: opts.courseId,
      title: opts.title,
      position: opts.position,
    })
    .returning()
    .get();

  const lessons = [];
  for (let i = 0; i < opts.lessonCount; i++) {
    lessons.push(
      testDb
        .insert(schema.lessons)
        .values({
          moduleId: mod.id,
          title: `${opts.title} — Lesson ${i + 1}`,
          position: i + 1,
        })
        .returning()
        .get()
    );
  }
  return { module: mod, lessons };
}

function makeStudent(email: string) {
  return testDb
    .insert(schema.users)
    .values({ name: email, email, role: schema.UserRole.Student })
    .returning()
    .get();
}

describe("bookmarkService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("toggleBookmark", () => {
    it("creates a bookmark when none exists", () => {
      const { lessons } = createModuleWithLessons({
        courseId: base.course.id,
        title: "Intro",
        position: 1,
        lessonCount: 1,
      });

      const result = toggleBookmark({
        userId: base.user.id,
        lessonId: lessons[0].id,
      });

      expect(result.bookmarked).toBe(true);
      expect(
        isLessonBookmarked({ userId: base.user.id, lessonId: lessons[0].id })
      ).toBe(true);
    });

    it("removes the bookmark when one already exists", () => {
      const { lessons } = createModuleWithLessons({
        courseId: base.course.id,
        title: "Intro",
        position: 1,
        lessonCount: 1,
      });

      toggleBookmark({ userId: base.user.id, lessonId: lessons[0].id });
      const result = toggleBookmark({
        userId: base.user.id,
        lessonId: lessons[0].id,
      });

      expect(result.bookmarked).toBe(false);
      expect(
        isLessonBookmarked({ userId: base.user.id, lessonId: lessons[0].id })
      ).toBe(false);
    });

    it("toggling twice leaves no rows behind", () => {
      const { lessons } = createModuleWithLessons({
        courseId: base.course.id,
        title: "Intro",
        position: 1,
        lessonCount: 1,
      });

      toggleBookmark({ userId: base.user.id, lessonId: lessons[0].id });
      toggleBookmark({ userId: base.user.id, lessonId: lessons[0].id });

      const rows = testDb.select().from(schema.lessonBookmarks).all();
      expect(rows).toHaveLength(0);
    });

    it("keeps a single row across the create/delete/create cycle", () => {
      const { lessons } = createModuleWithLessons({
        courseId: base.course.id,
        title: "Intro",
        position: 1,
        lessonCount: 1,
      });
      const lessonId = lessons[0].id;

      toggleBookmark({ userId: base.user.id, lessonId });
      toggleBookmark({ userId: base.user.id, lessonId });
      toggleBookmark({ userId: base.user.id, lessonId });

      const rows = testDb.select().from(schema.lessonBookmarks).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].lessonId).toBe(lessonId);
    });
  });

  describe("isLessonBookmarked", () => {
    it("returns false when the lesson is not bookmarked", () => {
      const { lessons } = createModuleWithLessons({
        courseId: base.course.id,
        title: "Intro",
        position: 1,
        lessonCount: 1,
      });

      expect(
        isLessonBookmarked({ userId: base.user.id, lessonId: lessons[0].id })
      ).toBe(false);
    });

    it("is scoped per user — one student's bookmark is invisible to another", () => {
      const { lessons } = createModuleWithLessons({
        courseId: base.course.id,
        title: "Intro",
        position: 1,
        lessonCount: 1,
      });
      const other = makeStudent("other@example.com");

      toggleBookmark({ userId: base.user.id, lessonId: lessons[0].id });

      expect(
        isLessonBookmarked({ userId: base.user.id, lessonId: lessons[0].id })
      ).toBe(true);
      expect(
        isLessonBookmarked({ userId: other.id, lessonId: lessons[0].id })
      ).toBe(false);
    });
  });

  describe("getBookmarkedLessonIds", () => {
    it("returns an empty array when the user has no bookmarks", () => {
      createModuleWithLessons({
        courseId: base.course.id,
        title: "Intro",
        position: 1,
        lessonCount: 2,
      });

      expect(
        getBookmarkedLessonIds({
          userId: base.user.id,
          courseId: base.course.id,
        })
      ).toEqual([]);
    });

    it("returns only the bookmarked lesson IDs within the course", () => {
      const { lessons } = createModuleWithLessons({
        courseId: base.course.id,
        title: "Intro",
        position: 1,
        lessonCount: 3,
      });

      toggleBookmark({ userId: base.user.id, lessonId: lessons[0].id });
      toggleBookmark({ userId: base.user.id, lessonId: lessons[2].id });

      const ids = getBookmarkedLessonIds({
        userId: base.user.id,
        courseId: base.course.id,
      });

      expect(ids.sort()).toEqual([lessons[0].id, lessons[2].id].sort());
    });

    it("excludes bookmarks belonging to other courses", () => {
      const courseA = createModuleWithLessons({
        courseId: base.course.id,
        title: "Course A Module",
        position: 1,
        lessonCount: 1,
      });

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
      const courseB = createModuleWithLessons({
        courseId: otherCourse.id,
        title: "Course B Module",
        position: 1,
        lessonCount: 1,
      });

      toggleBookmark({ userId: base.user.id, lessonId: courseA.lessons[0].id });
      toggleBookmark({ userId: base.user.id, lessonId: courseB.lessons[0].id });

      expect(
        getBookmarkedLessonIds({
          userId: base.user.id,
          courseId: base.course.id,
        })
      ).toEqual([courseA.lessons[0].id]);
      expect(
        getBookmarkedLessonIds({
          userId: base.user.id,
          courseId: otherCourse.id,
        })
      ).toEqual([courseB.lessons[0].id]);
    });

    it("excludes other users' bookmarks within the same course", () => {
      const { lessons } = createModuleWithLessons({
        courseId: base.course.id,
        title: "Intro",
        position: 1,
        lessonCount: 2,
      });
      const other = makeStudent("other@example.com");

      toggleBookmark({ userId: base.user.id, lessonId: lessons[0].id });
      toggleBookmark({ userId: other.id, lessonId: lessons[1].id });

      expect(
        getBookmarkedLessonIds({
          userId: base.user.id,
          courseId: base.course.id,
        })
      ).toEqual([lessons[0].id]);
    });
  });

  describe("unique (user, lesson) constraint", () => {
    it("rejects a duplicate bookmark for the same user and lesson", () => {
      const { lessons } = createModuleWithLessons({
        courseId: base.course.id,
        title: "Intro",
        position: 1,
        lessonCount: 1,
      });

      testDb
        .insert(schema.lessonBookmarks)
        .values({ userId: base.user.id, lessonId: lessons[0].id })
        .run();

      expect(() =>
        testDb
          .insert(schema.lessonBookmarks)
          .values({ userId: base.user.id, lessonId: lessons[0].id })
          .run()
      ).toThrow();
    });
  });
});
