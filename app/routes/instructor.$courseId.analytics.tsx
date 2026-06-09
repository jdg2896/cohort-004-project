import { Link, data, isRouteErrorResponse } from "react-router";
import type { Route } from "./+types/instructor.$courseId.analytics";
import { getCourseById } from "~/services/courseService";
import { getCourseAnalytics, getCourseTrends } from "~/services/analyticsService";
import { getUserById } from "~/services/userService";
import { getCurrentUserId } from "~/lib/session";
import { UserRole } from "~/db/schema";
import { formatMoney } from "~/lib/utils";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { TrendChart } from "~/components/trend-chart";
import {
  AlertTriangle,
  ArrowLeft,
  Users,
  DollarSign,
  GraduationCap,
  Activity,
  TrendingUp,
} from "lucide-react";

export function meta({ data: loaderData }: Route.MetaArgs) {
  const title = loaderData?.course?.title ?? "Course Analytics";
  return [
    { title: `Analytics: ${title} — Cadence` },
    { name: "description", content: `Performance analytics for ${title}` },
  ];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to view course analytics.", {
      status: 401,
    });
  }

  const user = getUserById(currentUserId);

  if (!user || (user.role !== UserRole.Instructor && user.role !== UserRole.Admin)) {
    throw data("Only instructors and admins can access this page.", {
      status: 403,
    });
  }

  const courseId = parseInt(params.courseId, 10);
  if (isNaN(courseId)) {
    throw data("Invalid course ID.", { status: 400 });
  }

  const course = getCourseById(courseId);

  if (!course) {
    throw data("Course not found.", { status: 404 });
  }

  if (course.instructorId !== currentUserId && user.role !== UserRole.Admin) {
    throw data("You can only view analytics for your own courses.", {
      status: 403,
    });
  }

  const analytics = getCourseAnalytics(courseId);
  const trends = getCourseTrends(courseId);

  return { course, analytics, trends };
}

/** "2026-06-09" → "6/9" for compact axis labels. */
function weekLabel(weekStart: string): string {
  const [, month, day] = weekStart.split("-");
  return `${parseInt(month, 10)}/${parseInt(day, 10)}`;
}

function StatTile({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: typeof Users;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Icon className="size-4" />
          {label}
        </div>
        <p className="mt-2 text-3xl font-bold">{value}</p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function TrendCard({
  title,
  total,
  data,
  formatValue,
  ariaLabel,
  colorClass,
}: {
  title: string;
  total: string;
  data: { label: string; value: number }[];
  formatValue?: (value: number) => string;
  ariaLabel: string;
  colorClass: string;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <TrendingUp className="size-4 text-muted-foreground" />
            {title}
          </h2>
          <span className="text-sm text-muted-foreground">
            {total} · last 12 weeks
          </span>
        </div>
        <TrendChart
          data={data}
          formatValue={formatValue}
          ariaLabel={ariaLabel}
          className={colorClass}
        />
      </CardContent>
    </Card>
  );
}

export default function InstructorCourseAnalytics({
  loaderData,
}: Route.ComponentProps) {
  const { course, analytics, trends } = loaderData;
  const hasStudents = analytics.enrollmentCount > 0;

  const revenueData = trends.weeks.map((week) => ({
    label: weekLabel(week.weekStart),
    value: week.revenue,
  }));
  const enrollmentData = trends.weeks.map((week) => ({
    label: weekLabel(week.weekStart),
    value: week.enrollments,
  }));
  const windowRevenue = trends.weeks.reduce((sum, w) => sum + w.revenue, 0);
  const windowEnrollments = trends.weeks.reduce(
    (sum, w) => sum + w.enrollments,
    0
  );

  // Neutral placeholder for metrics that are undefined with no enrolled students.
  const completionDisplay =
    analytics.completionRate === null
      ? "—"
      : `${Math.round(analytics.completionRate * 100)}%`;
  const progressDisplay =
    analytics.averageProgress === null ? "—" : `${analytics.averageProgress}%`;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      {/* Breadcrumb */}
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/instructor" className="hover:text-foreground">
          My Courses
        </Link>
        <span className="mx-2">/</span>
        <Link to={`/instructor/${course.id}`} className="hover:text-foreground">
          {course.title}
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Analytics</span>
      </nav>

      <Link
        to={`/instructor/${course.id}`}
        className="mb-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="mr-1 size-4" />
        Back to Course Editor
      </Link>

      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Analytics</h1>
          <p className="mt-1 text-muted-foreground">{course.title}</p>
        </div>
        <Link to={`/instructor/${course.id}/students`}>
          <Button variant="outline" size="sm">
            <Users className="mr-1.5 size-4" />
            View Student Roster
          </Button>
        </Link>
      </div>

      {!hasStudents && (
        <Card className="mb-6 border-dashed">
          <CardContent className="py-8 text-center">
            <Users className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            <p className="font-medium">No students enrolled yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Completion and progress metrics will appear once students enroll
              in this course.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Enrollments"
          value={String(analytics.enrollmentCount)}
          icon={Users}
        />
        <StatTile
          label="Earnings"
          value={formatMoney(analytics.totalEarnings)}
          icon={DollarSign}
        />
        <StatTile
          label="Completion rate"
          value={completionDisplay}
          hint="Students who finished every lesson"
          icon={GraduationCap}
        />
        <StatTile
          label="Avg. progress"
          value={progressDisplay}
          hint="Mean lessons completed across students"
          icon={Activity}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TrendCard
          title="Weekly revenue"
          total={formatMoney(windowRevenue)}
          data={revenueData}
          formatValue={formatMoney}
          ariaLabel="Weekly revenue over the last 12 weeks"
          colorClass="text-emerald-600 dark:text-emerald-500"
        />
        <TrendCard
          title="Weekly enrollments"
          total={String(windowEnrollments)}
          data={enrollmentData}
          ariaLabel="Weekly new enrollments over the last 12 weeks"
          colorClass="text-blue-600 dark:text-blue-500"
        />
      </div>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading course analytics.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      title = "Course not found";
      message =
        "The course you're looking for doesn't exist or may have been removed.";
    } else if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message =
        typeof error.data === "string"
          ? error.data
          : "You don't have permission to view these analytics.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/instructor">
            <Button variant="outline">My Courses</Button>
          </Link>
          <Link to="/">
            <Button>Go Home</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
