import { eq, and, isNull, inArray, desc, asc, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  lessonComments,
  commentModerationActions,
  users,
  UserRole,
  CommentModerationAction,
} from "~/db/schema";

// ─── Comment Service ───
// Threaded lesson Q&A, one level deep. Top-level comments have parentId = null;
// replies point at a top-level comment. Depth is enforced here (not the DB).
// Uses positional parameters (project convention).

const MAX_BODY_LENGTH = 5000;

// Author info joined onto each comment row. Badges are derived at render time
// from authorId (vs. the course instructor) and authorRole (admin).
export type CommentRow = {
  id: number;
  lessonId: number;
  parentId: number | null;
  authorId: number;
  authorName: string;
  authorAvatarUrl: string | null;
  authorRole: UserRole;
  body: string;
  deletedAt: string | null;
  removalReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CommentThread = CommentRow & { replies: CommentRow[] };

const authorColumns = {
  id: lessonComments.id,
  lessonId: lessonComments.lessonId,
  parentId: lessonComments.parentId,
  authorId: lessonComments.userId,
  authorName: users.name,
  authorAvatarUrl: users.avatarUrl,
  authorRole: sql<UserRole>`${users.role}`,
  body: lessonComments.body,
  deletedAt: lessonComments.deletedAt,
  removalReason: lessonComments.removalReason,
  createdAt: lessonComments.createdAt,
  updatedAt: lessonComments.updatedAt,
};

function validateBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    throw new Error("Comment cannot be empty");
  }
  if (trimmed.length > MAX_BODY_LENGTH) {
    throw new Error(`Comment cannot exceed ${MAX_BODY_LENGTH} characters`);
  }
  return trimmed;
}

export function getComment(commentId: number) {
  return db
    .select()
    .from(lessonComments)
    .where(eq(lessonComments.id, commentId))
    .get();
}

// Count of top-level threads only — this is the N in "Discussion (N)".
// Tombstoned top-level comments still render (as "[deleted]"), so they count.
export function countTopLevelComments(lessonId: number): number {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonComments)
    .where(
      and(
        eq(lessonComments.lessonId, lessonId),
        isNull(lessonComments.parentId)
      )
    )
    .get();
  return result?.count ?? 0;
}

// One page of top-level threads, newest-first, with replies eager-loaded
// oldest-first within each thread.
export function getCommentThreads(
  lessonId: number,
  limit: number,
  offset: number
): CommentThread[] {
  const tops = db
    .select(authorColumns)
    .from(lessonComments)
    .innerJoin(users, eq(lessonComments.userId, users.id))
    .where(
      and(
        eq(lessonComments.lessonId, lessonId),
        isNull(lessonComments.parentId)
      )
    )
    .orderBy(desc(lessonComments.createdAt), desc(lessonComments.id))
    .limit(limit)
    .offset(offset)
    .all();

  const topIds = tops.map((t) => t.id);
  const replies =
    topIds.length > 0
      ? db
          .select(authorColumns)
          .from(lessonComments)
          .innerJoin(users, eq(lessonComments.userId, users.id))
          .where(inArray(lessonComments.parentId, topIds))
          .orderBy(asc(lessonComments.createdAt), asc(lessonComments.id))
          .all()
      : [];

  return tops.map((top) => ({
    ...top,
    replies: replies.filter((r) => r.parentId === top.id),
  }));
}

export function createComment(lessonId: number, userId: number, body: string) {
  const trimmed = validateBody(body);
  return db
    .insert(lessonComments)
    .values({ lessonId, userId, parentId: null, body: trimmed })
    .returning()
    .get();
}

// Reply to a top-level comment. Enforces the one-level depth rule: replying to a
// comment that is itself a reply is rejected. lessonId is inherited from the parent.
export function createReply(parentId: number, userId: number, body: string) {
  const parent = getComment(parentId);
  if (!parent) {
    throw new Error("Parent comment not found");
  }
  if (parent.parentId !== null) {
    throw new Error("Replies can only be one level deep");
  }

  const trimmed = validateBody(body);
  return db
    .insert(lessonComments)
    .values({
      lessonId: parent.lessonId,
      userId,
      parentId,
      body: trimmed,
    })
    .returning()
    .get();
}

// Author-only edit. Sets updatedAt so the UI can show an "edited" indicator
// (updatedAt > createdAt).
export function editComment(commentId: number, userId: number, body: string) {
  const comment = getComment(commentId);
  if (!comment) {
    throw new Error("Comment not found");
  }
  if (comment.userId !== userId) {
    throw new Error("Only the author can edit this comment");
  }
  if (comment.deletedAt !== null) {
    throw new Error("Cannot edit a deleted comment");
  }

  const trimmed = validateBody(body);
  return db
    .update(lessonComments)
    .set({ body: trimmed, updatedAt: new Date().toISOString() })
    .where(eq(lessonComments.id, commentId))
    .returning()
    .get();
}

function hasReplies(commentId: number): boolean {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonComments)
    .where(eq(lessonComments.parentId, commentId))
    .get();
  return (result?.count ?? 0) > 0;
}

// Author deletes their own comment. No reason, no audit. Tombstones (keeps the
// row, shows "[deleted]") when the comment has replies so the thread survives;
// otherwise hard-deletes the childless row.
export function deleteComment(commentId: number, userId: number) {
  const comment = getComment(commentId);
  if (!comment) {
    throw new Error("Comment not found");
  }
  if (comment.userId !== userId) {
    throw new Error("Only the author can delete this comment");
  }

  if (hasReplies(commentId)) {
    return db
      .update(lessonComments)
      .set({
        deletedAt: new Date().toISOString(),
        body: "[deleted]",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(lessonComments.id, commentId))
      .returning()
      .get();
  }

  db.delete(lessonComments).where(eq(lessonComments.id, commentId)).run();
  return null;
}

// Moderation (removing other users' comments) is admin-only. Instructors can
// read/post in their course discussions but cannot remove others' comments.
// lessonId is kept in the signature so this can later be extended to a
// per-course moderator role without changing callers.
export function canModerate(userId: number, _lessonId: number): boolean {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) return false;
  return user.role === UserRole.Admin;
}

// Moderator (course instructor or admin) removes another user's comment. ALWAYS
// writes an append-only audit row, regardless of soft vs. hard delete. The audit
// is inserted before any hard delete, and commentId has no FK, so the record
// survives the comment's removal. Soft-deletes store the (optional) reason on the
// tombstone so it can be shown to the author + admins.
export function moderateDeleteComment(
  commentId: number,
  moderatorId: number,
  reason: string | null
) {
  const comment = getComment(commentId);
  if (!comment) {
    throw new Error("Comment not found");
  }
  if (!canModerate(moderatorId, comment.lessonId)) {
    throw new Error("Not authorized to moderate this comment");
  }

  const trimmedReason = reason?.trim() ? reason.trim() : null;
  const soft = hasReplies(commentId);
  const action = soft
    ? CommentModerationAction.SoftDelete
    : CommentModerationAction.HardDelete;

  db.insert(commentModerationActions)
    .values({ commentId, moderatorId, action, reason: trimmedReason })
    .run();

  if (soft) {
    return db
      .update(lessonComments)
      .set({
        deletedAt: new Date().toISOString(),
        removalReason: trimmedReason,
        body: "[deleted]",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(lessonComments.id, commentId))
      .returning()
      .get();
  }

  db.delete(lessonComments).where(eq(lessonComments.id, commentId)).run();
  return null;
}

export type ModerationLogEntry = {
  id: number;
  commentId: number;
  moderatorId: number;
  moderatorName: string;
  moderatorRole: UserRole;
  action: CommentModerationAction;
  reason: string | null;
  createdAt: string;
};

// Admin moderation log, reverse-chronological. Optionally filtered to a single
// moderator (the admin page exposes this as an instructor filter).
export function getModerationLog(
  moderatorId?: number
): ModerationLogEntry[] {
  return db
    .select({
      id: commentModerationActions.id,
      commentId: commentModerationActions.commentId,
      moderatorId: commentModerationActions.moderatorId,
      moderatorName: users.name,
      moderatorRole: sql<UserRole>`${users.role}`,
      action: sql<CommentModerationAction>`${commentModerationActions.action}`,
      reason: commentModerationActions.reason,
      createdAt: commentModerationActions.createdAt,
    })
    .from(commentModerationActions)
    .innerJoin(users, eq(commentModerationActions.moderatorId, users.id))
    .where(
      moderatorId !== undefined
        ? eq(commentModerationActions.moderatorId, moderatorId)
        : undefined
    )
    .orderBy(
      desc(commentModerationActions.createdAt),
      desc(commentModerationActions.id)
    )
    .all();
}
