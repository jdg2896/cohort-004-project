import {
  data,
  isRouteErrorResponse,
  Link,
  Form,
  useSubmit,
} from "react-router";
import type { Route } from "./+types/admin.moderation";
import { getCurrentUserId } from "~/lib/session";
import { getUserById, getUsersByRole } from "~/services/userService";
import { getModerationLog } from "~/services/commentService";
import { UserRole, CommentModerationAction } from "~/db/schema";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { AlertTriangle, ShieldCheck } from "lucide-react";

export function meta() {
  return [
    { title: "Comment Moderation — Cadence" },
    { name: "description", content: "Review comment moderation activity" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to view moderation.", {
      status: 401,
    });
  }

  const currentUser = getUserById(currentUserId);
  // Admin-only — instructors never see the moderation log (no self-view).
  if (!currentUser || currentUser.role !== UserRole.Admin) {
    throw data("Only admins can access the moderation log.", { status: 403 });
  }

  const url = new URL(request.url);
  const moderatorParam = url.searchParams.get("moderator");
  const parsedId = moderatorParam ? Number(moderatorParam) : NaN;
  const filterId = Number.isInteger(parsedId) ? parsedId : null;

  const log = getModerationLog(filterId ?? undefined);
  // Moderation is admin-only, so moderators are admins. (Extendable to a
  // dedicated moderator role later.)
  const moderators = getUsersByRole(UserRole.Admin);

  return {
    log,
    moderators: moderators.map((m) => ({ id: m.id, name: m.name })),
    filterId,
  };
}

function actionLabel(action: CommentModerationAction): string {
  switch (action) {
    case CommentModerationAction.SoftDelete:
      return "Soft delete (tombstoned)";
    case CommentModerationAction.HardDelete:
      return "Hard delete";
    default:
      return action;
  }
}

function moderatorRoleBadge(role: UserRole) {
  if (role === UserRole.Admin) {
    return (
      <span className="inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-[11px] font-medium text-purple-800 dark:bg-purple-900/30 dark:text-purple-400">
        Admin
      </span>
    );
  }
  if (role === UserRole.Instructor) {
    return (
      <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
        Instructor
      </span>
    );
  }
  return null;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function AdminModeration({ loaderData }: Route.ComponentProps) {
  const { log, moderators, filterId } = loaderData;
  const submit = useSubmit();

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      {/* Breadcrumb */}
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Comment Moderation</span>
      </nav>

      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Comment Moderation</h1>
          <p className="mt-1 text-muted-foreground">
            Append-only log of comments removed by admins.
          </p>
        </div>

        {/* Filter by moderating instructor */}
        <Form
          method="get"
          onChange={(event) => submit(event.currentTarget)}
          className="flex items-center gap-2"
        >
          <label htmlFor="moderator" className="text-sm text-muted-foreground">
            Filter:
          </label>
          <select
            id="moderator"
            name="moderator"
            defaultValue={filterId ?? ""}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">All moderators</option>
            {moderators.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Form>
      </div>

      <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
        <ShieldCheck className="size-4" />
        <span>
          {log.length} moderation {log.length === 1 ? "action" : "actions"}
        </span>
      </div>

      {log.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <ShieldCheck className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            <p className="text-muted-foreground">
              No moderation activity to show.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      When
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Moderator
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Action
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Comment
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Reason
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {log.map((entry) => (
                    <tr
                      key={entry.id}
                      className="border-b border-border last:border-0"
                    >
                      <td className="whitespace-nowrap px-4 py-3 text-sm text-muted-foreground">
                        {formatDate(entry.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">
                            {entry.moderatorName}
                          </span>
                          {moderatorRoleBadge(entry.moderatorRole)}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {actionLabel(entry.action)}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        #{entry.commentId}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {entry.reason ?? (
                          <span className="italic">No reason given</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading the moderation log.";

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
          : "Only admins can access this page.";
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
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
