import Ably from "ably";

// Capability operations are "subscribe" (receive messages + presence events +
// presence.get) and "presence" (enter/update/leave). There is no
// "presence-subscribe" op — see https://ably.com/docs/auth/capabilities.
const LESSON_CHANNEL_NAMESPACE = "lesson:*";

/**
 * Token params for a presence-capable client. The clientId is bound by the
 * token, so a client cannot impersonate another user. Hidden users ("appear
 * invisible") get a token without the presence (enter) capability, enforcing
 * the opt-out server-side rather than just in the UI.
 */
export function buildPresenceTokenParams(opts: {
  userId: number;
  hidden?: boolean;
}): Ably.TokenParams {
  const operations: Ably.capabilityOp[] = opts.hidden
    ? ["subscribe"]
    : ["subscribe", "presence"];
  return {
    clientId: String(opts.userId),
    capability: { [LESSON_CHANNEL_NAMESPACE]: operations },
  };
}

let restClient: Ably.Rest | null = null;

/**
 * Lazily-created server-side Ably REST client. Returns null when
 * ABLY_API_KEY is not configured so callers can degrade gracefully.
 */
export function getAblyRest(): Ably.Rest | null {
  const apiKey = process.env.ABLY_API_KEY;
  if (!apiKey) {
    return null;
  }
  restClient ??= new Ably.Rest({ key: apiKey });
  return restClient;
}
