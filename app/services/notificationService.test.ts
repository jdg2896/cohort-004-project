import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { NotificationType } from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the module picks up our test db
import {
  createNotification,
  getNotifications,
  getNotificationById,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
} from "./notificationService";

// Creates an enrollment-style notification for the given recipient. Title/message
// are stable so order assertions can rely on the returned rows, not the text.
function seedNotification(recipientUserId: number, message: string) {
  return createNotification({
    recipientUserId,
    type: NotificationType.Enrollment,
    title: "New Enrollment",
    message,
    linkUrl: `/instructor/${base.course.id}/students`,
  });
}

// A second instructor, so user-scoping tests have a distinct recipient.
function seedOtherUser() {
  return testDb
    .insert(schema.users)
    .values({
      name: "Other Instructor",
      email: "other-instructor@example.com",
      role: schema.UserRole.Instructor,
    })
    .returning()
    .get();
}

describe("notificationService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("createNotification", () => {
    it("creates a notification with all fields", () => {
      const created = createNotification({
        recipientUserId: base.instructor.id,
        type: NotificationType.Enrollment,
        title: "New Enrollment",
        message: "Test User enrolled in Test Course",
        linkUrl: `/instructor/${base.course.id}/students`,
      });

      expect(created).toBeDefined();
      expect(created.recipientUserId).toBe(base.instructor.id);
      expect(created.type).toBe(NotificationType.Enrollment);
      expect(created.title).toBe("New Enrollment");
      expect(created.message).toBe("Test User enrolled in Test Course");
      expect(created.linkUrl).toBe(`/instructor/${base.course.id}/students`);
      expect(created.isRead).toBe(false);
      expect(created.createdAt).toBeDefined();
    });

    it("allows a null linkUrl", () => {
      const created = createNotification({
        recipientUserId: base.instructor.id,
        type: NotificationType.Enrollment,
        title: "New Enrollment",
        message: "Someone enrolled",
        linkUrl: null,
      });

      expect(created.linkUrl).toBeNull();
    });
  });

  describe("getNotifications", () => {
    it("returns notifications newest first", () => {
      const first = seedNotification(base.instructor.id, "first");
      const second = seedNotification(base.instructor.id, "second");
      const third = seedNotification(base.instructor.id, "third");

      const result = getNotifications({
        userId: base.instructor.id,
        limit: 10,
        offset: 0,
      });

      expect(result.map((n) => n.id)).toEqual([third.id, second.id, first.id]);
    });

    it("respects limit", () => {
      seedNotification(base.instructor.id, "first");
      const second = seedNotification(base.instructor.id, "second");
      const third = seedNotification(base.instructor.id, "third");

      const result = getNotifications({
        userId: base.instructor.id,
        limit: 2,
        offset: 0,
      });

      expect(result.map((n) => n.id)).toEqual([third.id, second.id]);
    });

    it("respects offset", () => {
      const first = seedNotification(base.instructor.id, "first");
      const second = seedNotification(base.instructor.id, "second");
      seedNotification(base.instructor.id, "third");

      const result = getNotifications({
        userId: base.instructor.id,
        limit: 10,
        offset: 1,
      });

      expect(result.map((n) => n.id)).toEqual([second.id, first.id]);
    });

    it("returns an empty array when the user has no notifications", () => {
      expect(
        getNotifications({ userId: base.instructor.id, limit: 10, offset: 0 })
      ).toHaveLength(0);
    });

    it("only returns notifications for the given user", () => {
      const other = seedOtherUser();
      seedNotification(base.instructor.id, "for instructor");
      seedNotification(other.id, "for other");

      const result = getNotifications({
        userId: base.instructor.id,
        limit: 10,
        offset: 0,
      });

      expect(result).toHaveLength(1);
      expect(result[0].message).toBe("for instructor");
    });
  });

  describe("getNotificationById", () => {
    it("returns the notification when it exists", () => {
      const created = seedNotification(base.instructor.id, "hello");

      const found = getNotificationById(created.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
    });

    it("returns undefined for a non-existent id", () => {
      expect(getNotificationById(9999)).toBeUndefined();
    });
  });

  describe("getUnreadCount", () => {
    it("counts only unread notifications for the user", () => {
      const a = seedNotification(base.instructor.id, "a");
      seedNotification(base.instructor.id, "b");
      markAsRead(a.id);

      expect(getUnreadCount(base.instructor.id)).toBe(1);
    });

    it("returns 0 when there are no notifications", () => {
      expect(getUnreadCount(base.instructor.id)).toBe(0);
    });

    it("does not count another user's unread notifications", () => {
      const other = seedOtherUser();
      seedNotification(other.id, "for other");

      expect(getUnreadCount(base.instructor.id)).toBe(0);
    });
  });

  describe("markAsRead", () => {
    it("marks a single notification as read", () => {
      const created = seedNotification(base.instructor.id, "a");

      const updated = markAsRead(created.id);
      expect(updated!.isRead).toBe(true);
      expect(getUnreadCount(base.instructor.id)).toBe(0);
    });

    it("leaves other notifications untouched", () => {
      const a = seedNotification(base.instructor.id, "a");
      seedNotification(base.instructor.id, "b");

      markAsRead(a.id);

      expect(getUnreadCount(base.instructor.id)).toBe(1);
    });
  });

  describe("markAllAsRead", () => {
    it("marks all of a user's notifications as read", () => {
      seedNotification(base.instructor.id, "a");
      seedNotification(base.instructor.id, "b");

      markAllAsRead(base.instructor.id);

      expect(getUnreadCount(base.instructor.id)).toBe(0);
    });

    it("does not affect another user's notifications", () => {
      const other = seedOtherUser();
      seedNotification(base.instructor.id, "for instructor");
      seedNotification(other.id, "for other");

      markAllAsRead(base.instructor.id);

      expect(getUnreadCount(base.instructor.id)).toBe(0);
      expect(getUnreadCount(other.id)).toBe(1);
    });
  });
});
