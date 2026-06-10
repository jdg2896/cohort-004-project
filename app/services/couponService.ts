import { eq, and, isNull } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  purchases,
  enrollments,
  users,
  courses,
  teamMembers,
  NotificationType,
  TeamMemberRole,
} from "~/db/schema";
import { createNotification } from "./notificationService";
import crypto from "crypto";

// ─── Coupon Service ───
// Handles coupon generation, redemption (with validation), and listing.
// Each coupon grants one seat for a specific course within a team.

function generateCode(): string {
  return crypto.randomBytes(12).toString("base64url");
}

export function generateCoupons(
  teamId: number,
  courseId: number,
  purchaseId: number,
  quantity: number
) {
  const created: (typeof coupons.$inferSelect)[] = [];
  for (let i = 0; i < quantity; i++) {
    const coupon = db
      .insert(coupons)
      .values({
        teamId,
        courseId,
        code: generateCode(),
        purchaseId,
      })
      .returning()
      .get();
    created.push(coupon);
  }
  return created;
}

export function getCouponByCode(code: string) {
  return db.select().from(coupons).where(eq(coupons.code, code)).get();
}

export function getCouponsForTeam(teamId: number, courseId?: number) {
  if (courseId !== undefined) {
    return db
      .select()
      .from(coupons)
      .where(and(eq(coupons.teamId, teamId), eq(coupons.courseId, courseId)))
      .all();
  }
  return db.select().from(coupons).where(eq(coupons.teamId, teamId)).all();
}

export type RedeemResult =
  | { ok: true; enrollment: typeof enrollments.$inferSelect }
  | { ok: false; error: string };

export function redeemCoupon(
  code: string,
  userId: number,
  userCountry: string
): RedeemResult {
  // 1. Find the coupon
  const coupon = getCouponByCode(code);
  if (!coupon) {
    return { ok: false, error: "Coupon not found" };
  }

  // 2. Check if already consumed
  if (coupon.redeemedByUserId !== null) {
    return { ok: false, error: "Coupon has already been redeemed" };
  }

  // 3. Check if user is already enrolled
  const existingEnrollment = db
    .select()
    .from(enrollments)
    .where(
      and(
        eq(enrollments.userId, userId),
        eq(enrollments.courseId, coupon.courseId)
      )
    )
    .get();

  if (existingEnrollment) {
    return { ok: false, error: "You are already enrolled in this course" };
  }

  // 4. Country check: match purchaser's country
  const purchase = db
    .select()
    .from(purchases)
    .where(eq(purchases.id, coupon.purchaseId))
    .get();

  if (purchase?.country && purchase.country !== userCountry) {
    return {
      ok: false,
      error:
        "This coupon can only be redeemed from the same country as the purchaser",
    };
  }

  // 5. Redeem: mark coupon consumed + enroll user
  db.update(coupons)
    .set({
      redeemedByUserId: userId,
      redeemedAt: new Date().toISOString(),
    })
    .where(eq(coupons.id, coupon.id))
    .run();

  const enrollment = db
    .insert(enrollments)
    .values({ userId, courseId: coupon.courseId })
    .returning()
    .get();

  // Side effect: let the team's admins know a seat was claimed. Best-effort — a
  // missing user or course is skipped rather than failing the redemption.
  notifyTeamAdminsOfRedemption(coupon, userId);

  return { ok: true, enrollment };
}

// Notifies every admin of the coupon's team that a seat was claimed. The seat
// counts are a snapshot taken after the coupon is marked redeemed, so the
// just-redeemed seat is already excluded from the remaining count.
function notifyTeamAdminsOfRedemption(
  coupon: typeof coupons.$inferSelect,
  redeemerId: number
) {
  const redeemer = db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, redeemerId))
    .get();
  const course = db
    .select({ title: courses.title })
    .from(courses)
    .where(eq(courses.id, coupon.courseId))
    .get();

  if (!redeemer || !course) return;

  const courseCoupons = getCouponsForTeam(coupon.teamId, coupon.courseId);
  const totalSeats = courseCoupons.length;
  const remainingSeats = courseCoupons.filter(
    (c) => c.redeemedByUserId === null
  ).length;

  const admins = db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.teamId, coupon.teamId),
        eq(teamMembers.role, TeamMemberRole.Admin)
      )
    )
    .all();

  for (const admin of admins) {
    createNotification({
      recipientUserId: admin.userId,
      type: NotificationType.CouponRedemption,
      title: "Seat Claimed",
      message: `${redeemer.name} redeemed a coupon for ${course.title} (${remainingSeats} of ${totalSeats} seats remaining)`,
      linkUrl: "/team",
    });
  }
}
