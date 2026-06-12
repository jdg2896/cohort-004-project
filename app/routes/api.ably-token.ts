import type { Route } from "./+types/api.ably-token";
import { getCurrentUserId } from "~/lib/session";
import { buildPresenceTokenParams, getAblyRest } from "~/lib/ably.server";

// Ably's browser client points authUrl here (GET) and auto-renews tokens.
export async function loader({ request }: Route.LoaderArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const ably = getAblyRest();
  if (!ably) {
    throw new Response("Ably is not configured", { status: 503 });
  }

  const tokenRequest = await ably.auth.createTokenRequest(
    buildPresenceTokenParams({ userId })
  );
  return Response.json(tokenRequest);
}
