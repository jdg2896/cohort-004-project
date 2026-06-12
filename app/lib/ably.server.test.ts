import { describe, it, expect, vi, afterEach } from "vitest";

import { buildPresenceTokenParams, getAblyRest } from "./ably.server";

describe("buildPresenceTokenParams", () => {
  it("binds clientId to the user id as a string", () => {
    const params = buildPresenceTokenParams({ userId: 42 });
    expect(params.clientId).toBe("42");
  });

  it("grants subscribe and presence on the lesson namespace by default", () => {
    const params = buildPresenceTokenParams({ userId: 1 });
    expect(params.capability).toEqual({
      "lesson:*": ["subscribe", "presence"],
    });
  });

  it("omits the presence (enter) capability when the user is hidden", () => {
    const params = buildPresenceTokenParams({ userId: 1, hidden: true });
    expect(params.capability).toEqual({
      "lesson:*": ["subscribe"],
    });
  });
});

describe("getAblyRest", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when ABLY_API_KEY is not set", () => {
    vi.stubEnv("ABLY_API_KEY", "");
    expect(getAblyRest()).toBeNull();
  });

  it("returns a client when ABLY_API_KEY is set", () => {
    vi.stubEnv("ABLY_API_KEY", "fakeApp.fakeKey:fakeSecret");
    expect(getAblyRest()).not.toBeNull();
  });
});
