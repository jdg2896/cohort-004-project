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
  createComment,
  createReply,
  editComment,
  deleteComment,
  moderateDeleteComment,
  getComment,
  getCommentThreads,
  countTopLevelComments,
  getModerationLog,
} from "./commentService";

function makeUser(email: string, role: schema.UserRole) {
  return testDb
    .insert(schema.users)
    .values({ name: email, email, role })
    .returning()
    .get();
}

// seedBaseData gives us a student (base.user), instructor (base.instructor),
// and course (base.course, owned by base.instructor). We add a module + lesson
// so comments have somewhere to live.
function makeLesson() {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Module 1", position: 1 })
    .returning()
    .get();
  return testDb
    .insert(schema.lessons)
    .values({ moduleId: mod.id, title: "Lesson 1", position: 1 })
    .returning()
    .get();
}

describe("commentService", () => {
  let lessonId: number;

  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
    lessonId = makeLesson().id;
  });

  describe("createComment / createReply", () => {
    it("creates a top-level comment", () => {
      const c = createComment(lessonId, base.user.id, "  Hello there  ");
      expect(c.parentId).toBeNull();
      expect(c.body).toBe("Hello there"); // trimmed
      expect(countTopLevelComments(lessonId)).toBe(1);
    });

    it("rejects empty or whitespace-only bodies", () => {
      expect(() => createComment(lessonId, base.user.id, "   ")).toThrowError();
    });

    it("creates a reply to a top-level comment", () => {
      const top = createComment(lessonId, base.user.id, "Question?");
      const reply = createReply(top.id, base.instructor.id, "Answer.");
      expect(reply.parentId).toBe(top.id);
      expect(reply.lessonId).toBe(lessonId); // inherited from parent
      // Replies are not top-level threads.
      expect(countTopLevelComments(lessonId)).toBe(1);
    });

    it("enforces one-level depth: cannot reply to a reply", () => {
      const top = createComment(lessonId, base.user.id, "Question?");
      const reply = createReply(top.id, base.instructor.id, "Answer.");
      expect(() =>
        createReply(reply.id, base.user.id, "Follow-up")
      ).toThrowError(/one level/i);
    });
  });

  describe("getCommentThreads", () => {
    it("returns threads newest-first with replies oldest-first", () => {
      const first = createComment(lessonId, base.user.id, "First");
      const second = createComment(lessonId, base.user.id, "Second");
      createReply(first.id, base.instructor.id, "Reply A");
      createReply(first.id, base.user.id, "Reply B");

      const threads = getCommentThreads(lessonId, 10, 0);
      expect(threads.map((t) => t.id)).toEqual([second.id, first.id]); // newest-first
      const firstThread = threads.find((t) => t.id === first.id)!;
      expect(firstThread.replies.map((r) => r.body)).toEqual([
        "Reply A",
        "Reply B",
      ]); // oldest-first
      expect(firstThread.authorName).toBe(base.user.name);
    });

    it("paginates top-level threads via limit/offset", () => {
      createComment(lessonId, base.user.id, "One");
      createComment(lessonId, base.user.id, "Two");
      createComment(lessonId, base.user.id, "Three");

      expect(getCommentThreads(lessonId, 2, 0)).toHaveLength(2);
      expect(getCommentThreads(lessonId, 2, 2)).toHaveLength(1);
    });
  });

  describe("editComment", () => {
    it("lets the author edit and bumps updatedAt", () => {
      const c = createComment(lessonId, base.user.id, "Original");
      const updated = editComment(c.id, base.user.id, "Edited");
      expect(updated?.body).toBe("Edited");
      expect(
        new Date(updated!.updatedAt).getTime()
      ).toBeGreaterThanOrEqual(new Date(updated!.createdAt).getTime());
    });

    it("rejects edits from non-authors", () => {
      const c = createComment(lessonId, base.user.id, "Original");
      expect(() =>
        editComment(c.id, base.instructor.id, "Hacked")
      ).toThrowError();
    });
  });

  describe("deleteComment (author self-delete)", () => {
    it("hard-deletes a childless comment", () => {
      const c = createComment(lessonId, base.user.id, "Delete me");
      deleteComment(c.id, base.user.id);
      expect(getComment(c.id)).toBeUndefined();
    });

    it("soft-deletes (tombstones) a comment that has replies", () => {
      const top = createComment(lessonId, base.user.id, "Has replies");
      createReply(top.id, base.instructor.id, "A reply");

      deleteComment(top.id, base.user.id);

      const tombstone = getComment(top.id);
      expect(tombstone).toBeDefined();
      expect(tombstone!.deletedAt).not.toBeNull();
      expect(tombstone!.body).toBe("[deleted]");
      // The thread (and its reply) survives.
      expect(countTopLevelComments(lessonId)).toBe(1);
    });

    it("rejects deletes from non-authors", () => {
      const c = createComment(lessonId, base.user.id, "Mine");
      expect(() =>
        deleteComment(c.id, base.instructor.id)
      ).toThrowError();
    });
  });

  describe("moderateDeleteComment (permissions + audit)", () => {
    // Moderation is admin-only. Instructors can read/post in their course but
    // cannot remove other users' comments. (Extendable to a moderator role.)
    let admin: ReturnType<typeof makeUser>;
    let admin2: ReturnType<typeof makeUser>;

    beforeEach(() => {
      admin = makeUser("admin@example.com", schema.UserRole.Admin);
      admin2 = makeUser("admin2@example.com", schema.UserRole.Admin);
    });

    it("rejects moderation by a regular student", () => {
      const otherStudent = makeUser("s2@example.com", schema.UserRole.Student);
      const c = createComment(lessonId, base.user.id, "Spam");
      expect(() =>
        moderateDeleteComment(c.id, otherStudent.id, "spam")
      ).toThrowError(/not authorized/i);
      // No audit row written on a rejected attempt.
      expect(getModerationLog()).toHaveLength(0);
    });

    it("rejects moderation by the course instructor (admin-only)", () => {
      const c = createComment(lessonId, base.user.id, "Off-topic");
      expect(() =>
        moderateDeleteComment(c.id, base.instructor.id, "Off topic")
      ).toThrowError(/not authorized/i);
      expect(getModerationLog()).toHaveLength(0);
    });

    it("allows an admin to moderate and writes an audit row", () => {
      const c = createComment(lessonId, base.user.id, "Off-topic");
      moderateDeleteComment(c.id, admin.id, "Off topic");

      const log = getModerationLog();
      expect(log).toHaveLength(1);
      expect(log[0].commentId).toBe(c.id);
      expect(log[0].moderatorId).toBe(admin.id);
      expect(log[0].reason).toBe("Off topic");
      expect(log[0].action).toBe(schema.CommentModerationAction.HardDelete);
    });

    it("hard-deletes a childless comment but keeps the audit row", () => {
      const c = createComment(lessonId, base.user.id, "Off-topic");
      moderateDeleteComment(c.id, admin.id, "gone");

      expect(getComment(c.id)).toBeUndefined(); // comment hard-deleted
      expect(getModerationLog()).toHaveLength(1); // audit survives
      expect(getModerationLog()[0].action).toBe(
        schema.CommentModerationAction.HardDelete
      );
    });

    it("soft-deletes (tombstones) a comment with replies and records the reason", () => {
      const top = createComment(lessonId, base.user.id, "Has a reply");
      createReply(top.id, base.user.id, "child");

      moderateDeleteComment(top.id, admin.id, "Inappropriate");

      const tombstone = getComment(top.id);
      expect(tombstone!.deletedAt).not.toBeNull();
      expect(tombstone!.removalReason).toBe("Inappropriate");

      const log = getModerationLog();
      expect(log[0].action).toBe(schema.CommentModerationAction.SoftDelete);
    });

    it("filters the moderation log by moderator", () => {
      const c1 = createComment(lessonId, base.user.id, "one");
      const c2 = createComment(lessonId, base.user.id, "two");
      moderateDeleteComment(c1.id, admin.id, null);
      moderateDeleteComment(c2.id, admin2.id, null);

      expect(getModerationLog(admin.id)).toHaveLength(1);
      expect(getModerationLog(admin2.id)).toHaveLength(1);
      expect(getModerationLog()).toHaveLength(2);
    });
  });
});
