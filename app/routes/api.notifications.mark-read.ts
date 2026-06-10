import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/api.notifications.mark-read";
import { getCurrentUserId } from "~/lib/session";
import { parseJsonBody } from "~/lib/validation";
import {
  getNotificationById,
  markAsRead,
} from "~/services/notificationService";

const markReadSchema = z.object({
  notificationId: z.number().int().positive(),
});

export async function action({ request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);
  if (!currentUserId) {
    throw data("Unauthorized", { status: 401 });
  }

  const parsed = await parseJsonBody(request, markReadSchema);
  if (!parsed.success) {
    throw data("Invalid parameters", { status: 400 });
  }

  // Only the recipient may mark their own notification read.
  const notification = getNotificationById(parsed.data.notificationId);
  if (!notification || notification.recipientUserId !== currentUserId) {
    throw data("Notification not found", { status: 404 });
  }

  markAsRead(notification.id);

  return { success: true };
}
