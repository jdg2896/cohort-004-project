import { data } from "react-router";
import type { Route } from "./+types/dev.presence-prototype";
import { getCurrentUserId } from "~/lib/session";
import { getUserById } from "~/services/userService";
import { getAblyRest } from "~/lib/ably.server";
import { LessonPresence } from "~/components/lesson-presence";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";

// THROWAWAY PROTOTYPE — dev-only proving ground for Ably presence.
// See plans/live-presence-indicator-prototype.md. Delete this route when the
// real lesson-page presence ships.

// All prototype tabs join one shared channel inside the lesson:* namespace
// the token capability grants.
const PROTOTYPE_CHANNEL = "lesson:prototype";

export async function loader({ request }: Route.LoaderArgs) {
  if (process.env.NODE_ENV === "production") {
    throw new Response("Not Found", { status: 404 });
  }

  const currentUserId = await getCurrentUserId(request);
  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to view this prototype.", {
      status: 401,
    });
  }
  const user = getUserById(currentUserId);
  if (!user) {
    throw data("User not found.", { status: 401 });
  }

  return {
    user: {
      id: user.id,
      name: user.name,
      avatarUrl: user.avatarUrl ?? null,
    },
    ablyConfigured: getAblyRest() !== null,
  };
}

export default function PresencePrototype({
  loaderData,
}: Route.ComponentProps) {
  const { user, ablyConfigured } = loaderData;

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-8">
      <div>
        <h1 className="text-2xl font-bold">Presence prototype</h1>
        <p className="text-muted-foreground">
          Dev-only proving ground for the lesson-page live presence indicator.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>How to test</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm text-muted-foreground">
          <p>1. Open this page in a second window (normal + incognito).</p>
          <p>2. Use the DevUI panel to log in as a different user there.</p>
          <p>
            3. Avatars should appear below within a second; close a window and
            its avatar should drop off when Ably detects the connection end.
          </p>
          <p>
            4. Open the same user in two tabs — the debug panel shows two raw
            members but one deduped avatar entry.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Currently viewing (as {user.name})</CardTitle>
        </CardHeader>
        <CardContent>
          {ablyConfigured ? (
            <LessonPresence channelName={PROTOTYPE_CHANNEL} user={user} debug />
          ) : (
            <p className="text-sm text-muted-foreground">
              ABLY_API_KEY is not set — presence is disabled. Add it to .env and
              restart the dev server.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
