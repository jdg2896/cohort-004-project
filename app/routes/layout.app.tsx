import { Outlet } from "react-router";
import type { Route } from "./+types/layout.app";
import { Sidebar } from "~/components/sidebar";
import { DevUI } from "~/components/dev-ui";
import { Toaster } from "sonner";
import { getAllUsers, getUserById } from "~/services/userService";
import { getCurrentUserId, getDevCountry } from "~/lib/session";
import {
  getRecentlyProgressedCourses,
  calculateProgress,
  getCompletedLessonCount,
  getTotalLessonCount,
} from "~/services/progressService";
import { getCountryTierInfo, COUNTRIES } from "~/lib/ppp";
import { isTeamAdmin } from "~/services/teamService";
import {
  getNotifications,
  getUnreadCount,
} from "~/services/notificationService";
import { getGamificationStats } from "~/services/gamificationService";
import { UserRole } from "~/db/schema";

// How many recent notifications the bell dropdown shows.
const NOTIFICATION_PREVIEW_LIMIT = 5;

export async function loader({ request }: Route.LoaderArgs) {
  const users = getAllUsers();
  const currentUserId = await getCurrentUserId(request);
  const currentUser = currentUserId ? getUserById(currentUserId) : null;
  const devCountry = await getDevCountry(request);
  const countryTierInfo = getCountryTierInfo(devCountry);

  const recentCourses = currentUserId
    ? getRecentlyProgressedCourses(currentUserId).map((course) => {
        const completedLessons = getCompletedLessonCount(
          currentUserId,
          course.courseId
        );
        const totalLessons = getTotalLessonCount(course.courseId);
        const progress = calculateProgress(
          currentUserId,
          course.courseId,
          false,
          false
        );
        return {
          courseId: course.courseId,
          title: course.courseTitle,
          slug: course.courseSlug,
          coverImageUrl: course.coverImageUrl,
          completedLessons,
          totalLessons,
          progress,
        };
      })
    : [];

  // Notifications are shown to instructors (enrollments) and team admins (coupon
  // redemptions), so fetch them for either role.
  const isInstructor = currentUser?.role === UserRole.Instructor;
  const userIsTeamAdmin = currentUserId ? isTeamAdmin(currentUserId) : false;
  const showNotifications = isInstructor || userIsTeamAdmin;
  const notifications =
    showNotifications && currentUser
      ? getNotifications({
          userId: currentUser.id,
          limit: NOTIFICATION_PREVIEW_LIMIT,
          offset: 0,
        })
      : [];
  const unreadNotificationCount =
    showNotifications && currentUser ? getUnreadCount(currentUser.id) : 0;

  // Gamification (XP/level) is student-only. Other roles get no stats so the
  // sidebar section stays hidden for them.
  const gamificationStats =
    currentUser?.role === UserRole.Student
      ? getGamificationStats(currentUser.id)
      : null;

  return {
    users: users.map((u) => ({ id: u.id, name: u.name, role: u.role })),
    currentUser: currentUser
      ? {
          id: currentUser.id,
          name: currentUser.name,
          role: currentUser.role,
          avatarUrl: currentUser.avatarUrl ?? null,
        }
      : null,
    recentCourses,
    notifications: notifications.map((n) => ({
      id: n.id,
      title: n.title,
      message: n.message,
      linkUrl: n.linkUrl,
      isRead: n.isRead,
      createdAt: n.createdAt,
    })),
    unreadNotificationCount,
    gamificationStats,
    devCountry,
    countryTierInfo,
    countries: COUNTRIES,
    isTeamAdmin: userIsTeamAdmin,
  };
}

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const {
    users,
    currentUser,
    recentCourses,
    notifications,
    unreadNotificationCount,
    gamificationStats,
    devCountry,
    countryTierInfo,
    countries,
    isTeamAdmin: userIsTeamAdmin,
  } = loaderData;

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        currentUser={currentUser}
        recentCourses={recentCourses}
        notifications={notifications}
        unreadNotificationCount={unreadNotificationCount}
        gamificationStats={gamificationStats}
        isTeamAdmin={userIsTeamAdmin}
      />
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
      <DevUI
        users={users}
        currentUser={currentUser}
        devCountry={devCountry}
        countryTierInfo={countryTierInfo}
        countries={countries}
      />
      <Toaster position="bottom-right" richColors closeButton />
    </div>
  );
}
