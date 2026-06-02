import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/api.course-review";
import { getCurrentUserId } from "~/lib/session";
import { parseJsonBody } from "~/lib/validation";
import { isUserEnrolled } from "~/services/enrollmentService";
import { upsertReview } from "~/services/courseReviewService";

const courseReviewSchema = z.object({
  courseId: z.number().int().positive(),
  rating: z.number().int().min(1).max(5),
});

export async function action({ request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);
  if (!currentUserId) {
    throw data("Unauthorized", { status: 401 });
  }

  const parsed = await parseJsonBody(request, courseReviewSchema);
  if (!parsed.success) {
    throw data("Invalid parameters", { status: 400 });
  }

  const { courseId, rating } = parsed.data;

  // Only enrolled students may rate a course.
  if (!isUserEnrolled(currentUserId, courseId)) {
    throw data("You must be enrolled to rate this course", { status: 403 });
  }

  const review = upsertReview(currentUserId, courseId, rating);

  return { success: true, rating: review.rating };
}
