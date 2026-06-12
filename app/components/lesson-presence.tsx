import { lazy, Suspense, useSyncExternalStore } from "react";

// The Ably SDK must never run during SSR (it touches browser APIs and would
// bloat the server bundle). Lazy-load the client part and render it only
// after hydration.
const LessonPresenceClient = lazy(
  () => import("~/components/lesson-presence-client")
);

export interface PresenceUser {
  id: number;
  name: string;
  avatarUrl: string | null;
}

const emptySubscribe = () => () => {};

function useHydrated() {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
}

/**
 * Live "who else is viewing" strip backed by Ably presence.
 *
 * - `enter`: whether to announce this user (false for "appear invisible" —
 *   note the token endpoint must also withhold the presence capability).
 * - `debug`: render connection state and the raw member list (dev tooling).
 */
export function LessonPresence({
  channelName,
  user,
  enter = true,
  debug = false,
}: {
  channelName: string;
  user: PresenceUser;
  enter?: boolean;
  debug?: boolean;
}) {
  const hydrated = useHydrated();
  if (!hydrated) {
    return null;
  }
  return (
    <Suspense fallback={null}>
      <LessonPresenceClient
        channelName={channelName}
        user={user}
        enter={enter}
        debug={debug}
      />
    </Suspense>
  );
}
