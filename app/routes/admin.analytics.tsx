import { useState } from "react";
import {
  Link,
  data,
  isRouteErrorResponse,
  useSearchParams,
} from "react-router";
import type { Route } from "./+types/admin.analytics";
import {
  getCourseBreakdown,
  getInstructorsWithCourses,
  getPlatformAnalytics,
  getPlatformRevenueTrend,
  type CourseBreakdownRow,
  type TimePeriod,
} from "~/services/analyticsService";
import { getUserById } from "~/services/userService";
import { getCurrentUserId } from "~/lib/session";
import { UserRole } from "~/db/schema";
import { cn, formatMoney, formatPrice } from "~/lib/utils";
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
  Trophy,
  Users,
} from "lucide-react";

const TIME_PERIODS: { value: TimePeriod; label: string }[] = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "12m", label: "12m" },
  { value: "all", label: "All" },
];

const VALID_PERIODS = new Set<string>(TIME_PERIODS.map((p) => p.value));

export function meta() {
  return [
    { title: "Admin Analytics — Cadence" },
    {
      name: "description",
      content: "Platform-wide revenue and enrollment analytics",
    },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to view analytics.", {
      status: 401,
    });
  }

  const currentUser = getUserById(currentUserId);

  if (!currentUser || currentUser.role !== UserRole.Admin) {
    throw data("Only admins can access this page.", {
      status: 403,
    });
  }

  const url = new URL(request.url);
  const periodParam = url.searchParams.get("period") ?? "30d";
  const period: TimePeriod = VALID_PERIODS.has(periodParam)
    ? (periodParam as TimePeriod)
    : "30d";

  const instructorParam = url.searchParams.get("instructor");
  const instructorId = instructorParam ? Number(instructorParam) : undefined;

  const analytics = getPlatformAnalytics(period);
  const revenueTrend = getPlatformRevenueTrend(period);
  const courseBreakdown = getCourseBreakdown(
    period,
    instructorId && !Number.isNaN(instructorId) ? instructorId : undefined
  );
  const instructors = getInstructorsWithCourses();

  return {
    analytics,
    period,
    revenueTrend,
    courseBreakdown,
    instructors,
    selectedInstructorId: instructorId ?? null,
  };
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

function TimePeriodTabs({ current }: { current: TimePeriod }) {
  const [searchParams, setSearchParams] = useSearchParams();

  function selectPeriod(period: TimePeriod) {
    const next = new URLSearchParams(searchParams);
    next.set("period", period);
    setSearchParams(next);
  }

  return (
    <div className="flex gap-1 rounded-lg border p-1">
      {TIME_PERIODS.map((tp) => (
        <button
          key={tp.value}
          type="button"
          onClick={() => selectPeriod(tp.value)}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            tp.value === current
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
        >
          {tp.label}
        </button>
      ))}
    </div>
  );
}

type SortKey = keyof Pick<
  CourseBreakdownRow,
  | "title"
  | "instructorName"
  | "listPrice"
  | "revenue"
  | "sales"
  | "enrollmentCount"
  | "averageRating"
>;

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "title", label: "Course", numeric: false },
  { key: "instructorName", label: "Instructor", numeric: false },
  { key: "listPrice", label: "List Price", numeric: true },
  { key: "revenue", label: "Revenue", numeric: true },
  { key: "sales", label: "Sales", numeric: true },
  { key: "enrollmentCount", label: "Enrollments", numeric: true },
  { key: "averageRating", label: "Rating", numeric: true },
];

const formatRating = (value: number | null) =>
  value === null ? "—" : value.toFixed(1);

function InstructorFilter({
  instructors,
  selectedId,
}: {
  instructors: { id: number; name: string }[];
  selectedId: number | null;
}) {
  const [searchParams, setSearchParams] = useSearchParams();

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = new URLSearchParams(searchParams);
    if (e.target.value === "") {
      next.delete("instructor");
    } else {
      next.set("instructor", e.target.value);
    }
    setSearchParams(next);
  }

  return (
    <select
      value={selectedId ?? ""}
      onChange={onChange}
      className="rounded-md border bg-background px-3 py-1.5 text-sm"
      aria-label="Filter by instructor"
    >
      <option value="">All Instructors</option>
      {instructors.map((i) => (
        <option key={i.id} value={i.id}>
          {i.name}
        </option>
      ))}
    </select>
  );
}

function CourseBreakdownTable({
  courses,
  instructors,
  selectedInstructorId,
}: {
  courses: CourseBreakdownRow[];
  instructors: { id: number; name: string }[];
  selectedInstructorId: number | null;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("title");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "title" || key === "instructorName" ? "asc" : "desc");
    }
  }

  const sorted = [...courses].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
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
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <BarChart3 className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-medium">Course breakdown</h2>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Per-course revenue, sales, enrollments, and ratings
            </p>
          </div>
          <InstructorFilter
            instructors={instructors}
            selectedId={selectedInstructorId}
          />
        </div>

        {sorted.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No courses found for the selected filter.
          </p>
        ) : (
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
                    <td className="py-2.5 font-medium">{course.title}</td>
                    <td className="py-2.5">{course.instructorName}</td>
                    <td className="py-2.5 text-right tabular-nums">
                      {formatPrice(course.listPrice)}
                    </td>
                    <td className="py-2.5 text-right tabular-nums">
                      {formatMoney(course.revenue)}
                    </td>
                    <td className="py-2.5 text-right tabular-nums">
                      {course.sales}
                    </td>
                    <td className="py-2.5 text-right tabular-nums">
                      {course.enrollmentCount}
                    </td>
                    <td className="py-2.5 text-right tabular-nums">
                      {formatRating(course.averageRating)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function formatDateLabel(date: string, period: TimePeriod): string {
  if (period === "7d" || period === "30d") {
    const [, month, day] = date.split("-");
    return `${parseInt(month, 10)}/${parseInt(day, 10)}`;
  }
  const [year, month] = date.split("-");
  return `${SHORT_MONTHS[parseInt(month, 10) - 1]} '${year.slice(2)}`;
}

export default function AdminAnalytics({ loaderData }: Route.ComponentProps) {
  const {
    analytics,
    period,
    revenueTrend,
    courseBreakdown,
    instructors,
    selectedInstructorId,
  } = loaderData;

  const isEmpty =
    analytics.totalRevenue === 0 && analytics.totalEnrollments === 0;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Admin Analytics</span>
      </nav>

      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Platform Analytics</h1>
          <p className="mt-1 text-muted-foreground">
            Revenue and enrollment data across all courses
          </p>
        </div>
        <TimePeriodTabs current={period} />
      </div>

      {isEmpty ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <BarChart3 className="mb-4 size-12 text-muted-foreground/50" />
          <h2 className="text-lg font-medium">No analytics data yet</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Revenue and enrollment metrics will appear here once students start
            purchasing and enrolling in courses.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatTile
              label="Total Revenue"
              value={formatMoney(analytics.totalRevenue)}
              icon={DollarSign}
            />
            <StatTile
              label="Total Enrollments"
              value={String(analytics.totalEnrollments)}
              icon={Users}
            />
            <StatTile
              label="Top Earning Course"
              value={analytics.topCourse?.title ?? "—"}
              hint={
                analytics.topCourse
                  ? formatMoney(analytics.topCourse.revenue)
                  : undefined
              }
              icon={Trophy}
            />
          </div>

          {revenueTrend.length > 0 && (
            <Card className="mt-4">
              <CardContent className="p-5">
                <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
                  <DollarSign className="size-4 text-muted-foreground" />
                  Revenue over time
                </h2>
                <TrendChart
                  data={revenueTrend.map((p) => ({
                    label: formatDateLabel(p.date, period),
                    value: p.revenue,
                  }))}
                  formatValue={formatMoney}
                  ariaLabel="Combined revenue over time across all courses"
                  className="text-emerald-600 dark:text-emerald-500"
                />
              </CardContent>
            </Card>
          )}

          <CourseBreakdownTable
            courses={courseBreakdown}
            instructors={instructors}
            selectedInstructorId={selectedInstructorId}
          />
        </>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading analytics.";

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
          <Link to="/admin/users">
            <Button variant="outline">Manage Users</Button>
          </Link>
          <Link to="/">
            <Button>Go Home</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
