import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "~/db";
import { notifications, type NotificationType } from "~/db/schema";

// ─── Notification Service ───
// Generic in-app notifications, scoped per recipient. Direct Drizzle queries,
// matching existing service conventions. Functions with multiple same-typed
// parameters take an `opts` object to avoid argument-order mistakes.

export function createNotification(opts: {
  recipientUserId: number;
  type: NotificationType;
  title: string;
  message: string;
  linkUrl: string | null;
}) {
  const { recipientUserId, type, title, message, linkUrl } = opts;

  return db
    .insert(notifications)
    .values({ recipientUserId, type, title, message, linkUrl })
    .returning()
    .get();
}

// Newest first. id is the tiebreaker so rows sharing a createdAt timestamp
// (common when several are written in the same millisecond) still order
// deterministically by insertion order.
export function getNotifications(opts: {
  userId: number;
  limit: number;
  offset: number;
}) {
  const { userId, limit, offset } = opts;

  return db
    .select()
    .from(notifications)
    .where(eq(notifications.recipientUserId, userId))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit)
    .offset(offset)
    .all();
}

export function getNotificationById(id: number) {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.id, id))
    .get();
}

export function getUnreadCount(userId: number) {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(notifications)
    .where(
      and(
        eq(notifications.recipientUserId, userId),
        eq(notifications.isRead, false)
      )
    )
    .get();

  return result?.count ?? 0;
}

export function markAsRead(notificationId: number) {
  return db
    .update(notifications)
    .set({ isRead: true })
    .where(eq(notifications.id, notificationId))
    .returning()
    .get();
}

export function markAllAsRead(userId: number) {
  return db
    .update(notifications)
    .set({ isRead: true })
    .where(eq(notifications.recipientUserId, userId))
    .returning()
    .all();
}
