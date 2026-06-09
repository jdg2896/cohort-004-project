import { useState } from "react";
import { Link, data, isRouteErrorResponse } from "react-router";
import type { Route } from "./+types/instructor.analytics";
import {
  getPortfolioAnalytics,
  getPortfolioTrends,
} from "~/services/analyticsService";
import { getUserById } from "~/services/userService";
import { getCurrentUserId } from "~/lib/session";
import { UserRole } from "~/db/schema";
import { cn, formatMoney } from "~/lib/utils";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { TrendChart } from "~/components/trend-chart";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  DollarSign,
  GraduationCap,
  Plus,
  TrendingDown,
  TrendingUp,
  Users,
  UsersRound,
} from "lucide-react";

export function meta() {
  return [
    { title: "Analytics — Cadence" },
    {
      name: "description",
      content: "Performance analytics across all your courses",
    },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to view your analytics.", {
      status: 401,
    });
  }

  const user = getUserById(currentUserId);

  if (
    !user ||
    (user.role !== UserRole.Instructor && user.role !== UserRole.Admin)
  ) {
    throw data("Only instructors and admins can access this page.", {
      status: 403,
    });
  }

  // Scoped to the current user's own authored courses (an admin sees only the
  // courses they authored, often none).
  const analytics = getPortfolioAnalytics(currentUserId);
  const trends = getPortfolioTrends(currentUserId);

  return { analytics, trends };
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

/** Signed "last 7 days" momentum badge, colored up/down (or neutral at zero). */
function DeltaBadge({
  delta,
  formatValue,
}: {
  delta: number;
  formatValue: (value: number) => string;
}) {
  if (delta === 0) {
    return <span className="text-xs text-muted-foreground">no change</span>;
  }
  const positive = delta > 0;
  const Icon = positive ? TrendingUp : TrendingDown;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-xs font-medium",
        positive
          ? "text-emerald-600 dark:text-emerald-500"
          : "text-rose-600 dark:text-rose-500"
      )}
    >
      <Icon className="size-3" />
      {positive ? "+" : "−"}
      {formatValue(Math.abs(delta))}
    </span>
  );
}

function TrendCard({
  title,
  icon: Icon,
  windowTotal,
  last7Value,
  delta,
  data,
  formatValue,
  ariaLabel,
  colorClass,
}: {
  title: string;
  icon: typeof Users;
  windowTotal: string;
  last7Value: string;
  delta: number;
  data: { label: string; value: number }[];
  formatValue: (value: number) => string;
  ariaLabel: string;
  colorClass: string;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Icon className="size-4 text-muted-foreground" />
            {title}
          </h2>
          <span className="text-sm text-muted-foreground">
            {windowTotal} · last 12 weeks
          </span>
        </div>
        <div className="mb-3 flex items-baseline gap-2">
          <span className="text-2xl font-bold">{last7Value}</span>
          <DeltaBadge delta={delta} formatValue={formatValue} />
          <span className="text-xs text-muted-foreground">last 7 days</span>
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

type CourseRow = Route.ComponentProps["loaderData"]["analytics"]["courses"][number];
type SortKey = keyof Pick<
  CourseRow,
  "title" | "enrollmentCount" | "totalEarnings" | "completionRate" | "averageQuizScore"
>;

const COLUMNS: {
  key: SortKey;
  label: string;
  numeric: boolean;
}[] = [
  { key: "title", label: "Course", numeric: false },
  { key: "enrollmentCount", label: "Enrollments", numeric: true },
  { key: "totalEarnings", label: "Earnings", numeric: true },
  { key: "completionRate", label: "Completion", numeric: true },
  { key: "averageQuizScore", label: "Avg. quiz", numeric: true },
];

const formatPercentOrDash = (value: number | null) =>
  value === null ? "—" : `${Math.round(value * 100)}%`;

function ComparisonTable({ courses }: { courses: CourseRow[] }) {
  // Default to the service's title order; numeric columns sort high→low first
  // (an instructor scanning for the best earner or worst completer).
  const [sortKey, setSortKey] = useState<SortKey>("title");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "title" ? "asc" : "desc");
    }
  }

  const sorted = [...courses].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    // Null metrics (no enrollments / no quiz attempts) always sort last,
    // regardless of direction, so they don't crowd the interesting rows.
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;

    const cmp =
      typeof av === "string"
        ? av.localeCompare(bv as string)
        : (av as number) - (bv as number);
    return sortDir === "asc" ? cmp : -cmp;
  });

  return (
    <Card className="mt-4">
      <CardContent className="p-5">
        <div className="mb-1 flex items-center gap-2">
          <BarChart3 className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">Course comparison</h2>
        </div>
        <p className="mb-4 text-xs text-muted-foreground">
          Sort by any column to rank your courses. Select a course to open its
          deep-dive analytics.
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-muted-foreground">
                {COLUMNS.map((col) => {
                  const active = col.key === sortKey;
                  const SortIcon = !active
                    ? ArrowUpDown
                    : sortDir === "asc"
                      ? ArrowUp
                      : ArrowDown;
                  return (
                    <th
                      key={col.key}
                      className={cn(
                        "py-2 font-medium",
                        col.numeric ? "text-right" : "text-left"
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort(col.key)}
                        className={cn(
                          "inline-flex items-center gap-1 hover:text-foreground",
                          col.numeric && "flex-row-reverse",
                          active && "text-foreground"
                        )}
                        aria-label={`Sort by ${col.label}`}
                      >
                        <SortIcon
                          className={cn(
                            "size-3.5",
                            !active && "text-muted-foreground/50"
                          )}
                        />
                        {col.label}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.map((course) => (
                <tr
                  key={course.courseId}
                  className="border-b last:border-0 hover:bg-muted/50"
                >
                  <td className="py-2.5">
                    <Link
                      to={`/instructor/${course.courseId}/analytics`}
                      className="font-medium hover:text-primary hover:underline"
                    >
                      {course.title}
                    </Link>
                  </td>
                  <td className="py-2.5 text-right tabular-nums">
                    {course.enrollmentCount}
                  </td>
                  <td className="py-2.5 text-right tabular-nums">
                    {formatMoney(course.totalEarnings)}
                  </td>
                  <td className="py-2.5 text-right tabular-nums">
                    {formatPercentOrDash(course.completionRate)}
                  </td>
                  <td className="py-2.5 text-right tabular-nums">
                    {formatPercentOrDash(course.averageQuizScore)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

export default function InstructorAnalytics({
  loaderData,
}: Route.ComponentProps) {
  const { analytics, trends } = loaderData;

  if (analytics.courses.length === 0) {
    return (
      <div className="mx-auto max-w-7xl p-6 lg:p-8">
        <nav className="mb-6 text-sm text-muted-foreground">
          <Link to="/" className="hover:text-foreground">
            Home
          </Link>
          <span className="mx-2">/</span>
          <span className="text-foreground">Analytics</span>
        </nav>

        <h1 className="text-3xl font-bold">Analytics</h1>

        <div className="mt-8 flex flex-col items-center justify-center py-16 text-center">
          <GraduationCap className="mb-4 size-12 text-muted-foreground/50" />
          <h2 className="text-lg font-medium">No analytics yet</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Once you create a course and students start enrolling, your earnings,
            enrollment, and completion numbers will show up here.
          </p>
          <Link to="/instructor/new" className="mt-4">
            <Button>
              <Plus className="mr-2 size-4" />
              Create Course
            </Button>
          </Link>
        </div>
      </div>
    );
  }

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

  // "Last 7 days" headline: the most recent week bucket, with its delta versus
  // the week before it for an at-a-glance momentum read.
  const lastWeek = trends.weeks[trends.weeks.length - 1];
  const priorWeek = trends.weeks[trends.weeks.length - 2];
  const revenueDelta = lastWeek.revenue - priorWeek.revenue;
  const enrollmentDelta = lastWeek.enrollments - priorWeek.enrollments;

  const completionDisplay =
    analytics.averageCompletion === null
      ? "—"
      : `${Math.round(analytics.averageCompletion * 100)}%`;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Analytics</span>
      </nav>

      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Analytics</h1>
          <p className="mt-1 text-muted-foreground">
            Performance across all your courses
          </p>
        </div>
        <Link to="/instructor">
          <Button variant="outline" size="sm">
            <GraduationCap className="mr-1.5 size-4" />
            My Courses
          </Button>
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Total earnings"
          value={formatMoney(analytics.totalEarnings)}
          icon={DollarSign}
        />
        <StatTile
          label="Total enrollments"
          value={String(analytics.totalEnrollments)}
          icon={Users}
        />
        <StatTile
          label="Distinct learners"
          value={String(analytics.distinctLearners)}
          hint="People, counted once across your courses"
          icon={UsersRound}
        />
        <StatTile
          label="Avg. completion"
          value={completionDisplay}
          hint="Mean completion rate across your courses"
          icon={GraduationCap}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TrendCard
          title="Weekly revenue"
          icon={DollarSign}
          windowTotal={formatMoney(windowRevenue)}
          last7Value={formatMoney(lastWeek.revenue)}
          delta={revenueDelta}
          data={revenueData}
          formatValue={formatMoney}
          ariaLabel="Weekly revenue across all courses over the last 12 weeks"
          colorClass="text-emerald-600 dark:text-emerald-500"
        />
        <TrendCard
          title="Weekly enrollments"
          icon={Users}
          windowTotal={String(windowEnrollments)}
          last7Value={String(lastWeek.enrollments)}
          delta={enrollmentDelta}
          data={enrollmentData}
          formatValue={(value) => String(value)}
          ariaLabel="Weekly new enrollments across all courses over the last 12 weeks"
          colorClass="text-blue-600 dark:text-blue-500"
        />
      </div>

      <ComparisonTable courses={analytics.courses} />
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading your analytics.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
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
