import {
  Link,
  data,
  isRouteErrorResponse,
  useSearchParams,
} from "react-router";
import type { Route } from "./+types/admin.analytics";
import {
  getPlatformAnalytics,
  getPlatformRevenueTrend,
  type TimePeriod,
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

  const analytics = getPlatformAnalytics(period);
  const revenueTrend = getPlatformRevenueTrend(period);

  return { analytics, period, revenueTrend };
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
  const { analytics, period, revenueTrend } = loaderData;

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
