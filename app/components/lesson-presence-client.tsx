import { useState } from "react";
import * as Ably from "ably";
import {
  AblyProvider,
  ChannelProvider,
  useConnectionStateListener,
  usePresence,
  usePresenceListener,
} from "ably/react";
import { UserAvatar } from "~/components/user-avatar";
import type { PresenceUser } from "~/components/lesson-presence";

// Payload attached on presence enter. Client-supplied and cosmetic only —
// identity is the token-bound clientId, which cannot be spoofed.
interface PresencePayload {
  name: string;
  avatarUrl: string | null;
}

const MAX_VISIBLE_AVATARS = 5;

// One Realtime connection per tab, shared across channels/components.
let realtimeClient: Ably.Realtime | null = null;

function getRealtimeClient(): Ably.Realtime {
  realtimeClient ??= new Ably.Realtime({
    authUrl: "/api/ably-token",
    closeOnUnload: true,
  });
  return realtimeClient;
}

// usePresence enters on mount and leaves on unmount; isolating it in a
// child component lets the parent opt out of entering by not rendering it.
function EnterPresence({
  channelName,
  payload,
}: {
  channelName: string;
  payload: PresencePayload;
}) {
  usePresence(channelName, payload);
  return null;
}

function PresenceStrip({
  channelName,
  user,
  enter,
  debug,
}: {
  channelName: string;
  user: PresenceUser;
  enter: boolean;
  debug: boolean;
}) {
  const { presenceData } = usePresenceListener(channelName);
  const [connectionState, setConnectionState] = useState("initialized");
  useConnectionStateListener((stateChange) => {
    setConnectionState(stateChange.current);
  });

  // The same user in two tabs appears as two presence members — dedupe by
  // clientId before rendering.
  const membersByClientId = new Map<string, PresencePayload>();
  for (const member of presenceData) {
    if (member.clientId && !membersByClientId.has(member.clientId)) {
      membersByClientId.set(member.clientId, member.data as PresencePayload);
    }
  }
  const others = [...membersByClientId.entries()].filter(
    ([clientId]) => clientId !== String(user.id)
  );

  const visible = others.slice(0, MAX_VISIBLE_AVATARS);
  const overflow = others.length - visible.length;

  return (
    <div className="flex flex-col gap-2">
      {enter && (
        <EnterPresence
          channelName={channelName}
          payload={{ name: user.name, avatarUrl: user.avatarUrl }}
        />
      )}
      {/* An empty presence strip is worse than none — render nothing when alone. */}
      {others.length > 0 && (
        <div className="flex items-center gap-2">
          <div className="flex -space-x-2">
            {visible.map(([clientId, payload]) => (
              <UserAvatar
                key={clientId}
                name={payload?.name ?? "Unknown"}
                avatarUrl={payload?.avatarUrl ?? null}
                className="ring-2 ring-background"
              />
            ))}
          </div>
          {overflow > 0 && (
            <span className="text-xs text-muted-foreground">+{overflow}</span>
          )}
          <span className="text-sm text-muted-foreground">
            also viewing this lesson
          </span>
        </div>
      )}
      {debug && (
        <div className="rounded-md border bg-muted/50 p-3 font-mono text-xs">
          <div>connection: {connectionState}</div>
          <div>raw members: {presenceData.length}</div>
          <div>unique clientIds: {membersByClientId.size}</div>
          <ul>
            {presenceData.map((member, i) => (
              <li key={`${member.clientId}-${member.connectionId}-${i}`}>
                clientId={member.clientId} conn={member.connectionId} data=
                {JSON.stringify(member.data)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function LessonPresenceClient({
  channelName,
  user,
  enter,
  debug,
}: {
  channelName: string;
  user: PresenceUser;
  enter: boolean;
  debug: boolean;
}) {
  return (
    <AblyProvider client={getRealtimeClient()}>
      <ChannelProvider channelName={channelName}>
        <PresenceStrip
          channelName={channelName}
          user={user}
          enter={enter}
          debug={debug}
        />
      </ChannelProvider>
    </AblyProvider>
  );
}
