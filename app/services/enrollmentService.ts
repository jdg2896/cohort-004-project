import { eq, and, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  enrollments,
  courses,
  users,
  modules,
  lessons,
  lessonProgress,
  LessonProgressStatus,
  NotificationType,
} from "~/db/schema";
import {
  getTotalLessonCount,
  getCompletedLessonCount,
} from "~/services/progressService";
import { createNotification } from "~/services/notificationService";

// ─── Enrollment Service ───
// Handles enrollment, unenrollment, duplicate prevention, and enrollment validation.
// Uses positional parameters (project convention).

export function getEnrollmentById(id: number) {
  return db.select().from(enrollments).where(eq(enrollments.id, id)).get();
}

export function getEnrollmentsByUser(userId: number) {
  return db
    .select()
    .from(enrollments)
    .where(eq(enrollments.userId, userId))
    .all();
}

export function getEnrollmentsByCourse(courseId: number) {
  return db
    .select()
    .from(enrollments)
    .where(eq(enrollments.courseId, courseId))
    .all();
}

export function getEnrollmentCountForCourse(courseId: number) {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(enrollments)
    .where(eq(enrollments.courseId, courseId))
    .get();

  return result?.count ?? 0;
}

export function findEnrollment(userId: number, courseId: number) {
  return db
    .select()
    .from(enrollments)
    .where(
      and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
    )
    .get();
}

export function isUserEnrolled(userId: number, courseId: number) {
  return !!findEnrollment(userId, courseId);
}

export function enrollUser(
  userId: number,
  courseId: number,
  sendEmail: boolean,
  skipValidation: boolean
) {
  if (!skipValidation) {
    // Check if already enrolled
    const existing = findEnrollment(userId, courseId);
    if (existing) {
      throw new Error("User is already enrolled in this course");
    }

    // Check that the course exists
    const course = db
      .select()
      .from(courses)
      .where(eq(courses.id, courseId))
      .get();
    if (!course) {
      throw new Error("Course not found");
    }
  }

  const enrollment = db
    .insert(enrollments)
    .values({ userId, courseId })
    .returning()
    .get();

  // Side effect: let the course's instructor know a student enrolled. Best-effort
  // — a missing course or student (only reachable via skipValidation) is skipped
  // rather than failing the enrollment.
  notifyInstructorOfEnrollment(userId, courseId);

  // sendEmail parameter accepted but not implemented (no email service — PRD out of scope)
  if (sendEmail) {
    // Would send welcome email here
  }

  return enrollment;
}

function notifyInstructorOfEnrollment(userId: number, courseId: number) {
  const course = db
    .select({ instructorId: courses.instructorId, title: courses.title })
    .from(courses)
    .where(eq(courses.id, courseId))
    .get();
  const student = db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .get();

  if (!course || !student) return;

  createNotification({
    recipientUserId: course.instructorId,
    type: NotificationType.Enrollment,
    title: "New Enrollment",
    message: `${student.name} enrolled in ${course.title}`,
    linkUrl: `/instructor/${courseId}/students`,
  });
}

export function unenrollUser(userId: number, courseId: number) {
  const existing = findEnrollment(userId, courseId);
  if (!existing) {
    throw new Error("User is not enrolled in this course");
  }

  return db
    .delete(enrollments)
    .where(
      and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
    )
    .returning()
    .get();
}

export function markEnrollmentComplete(userId: number, courseId: number) {
  return db
    .update(enrollments)
    .set({ completedAt: new Date().toISOString() })
    .where(
      and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
    )
    .returning()
    .get();
}

/**
 * Marks the user's enrollment complete the first time they finish every lesson
 * in the course. A one-way, set-once milestone: it never moves or clears an
 * existing completion timestamp, and it is a no-op for a course with zero
 * lessons or a user without an enrollment.
 *
 * Returns the enrollment — freshly stamped when it just completed, otherwise
 * unchanged — or undefined when there is no enrollment to act on. Depends on the
 * progress service for lesson counts (one-way); the lesson-completion primitive
 * gains no side effects from this.
 */
export function markEnrollmentCompleteIfFinished(opts: {
  userId: number;
  courseId: number;
}) {
  const { userId, courseId } = opts;

  const enrollment = findEnrollment(userId, courseId);
  if (!enrollment) return undefined;

  // Set-once: an existing completion is a historical milestone, never re-stamped.
  if (enrollment.completedAt) return enrollment;

  const totalLessons = getTotalLessonCount(courseId);
  if (totalLessons === 0) return enrollment;

  if (getCompletedLessonCount(userId, courseId) < totalLessons) {
    return enrollment;
  }

  return markEnrollmentComplete(userId, courseId);
}

export function getUserEnrolledCourses(userId: number) {
  return db
    .select({
      enrollmentId: enrollments.id,
      courseId: enrollments.courseId,
      enrolledAt: enrollments.enrolledAt,
      completedAt: enrollments.completedAt,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      courseDescription: courses.description,
      coverImageUrl: courses.coverImageUrl,
    })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(eq(enrollments.userId, userId))
    .all();
}

export function getCourseEnrolledStudents(courseId: number) {
  return db
    .select({
      enrollmentId: enrollments.id,
      userId: enrollments.userId,
      enrolledAt: enrollments.enrolledAt,
      completedAt: enrollments.completedAt,
    })
    .from(enrollments)
    .where(eq(enrollments.courseId, courseId))
    .all();
}
