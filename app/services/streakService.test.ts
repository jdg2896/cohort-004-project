import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the module picks up our test db
import { recordStreakActivity, getStreakStats } from "./streakService";

// Fixed UTC days used across the suite. Times-of-day vary to prove the logic keys
// off the UTC calendar day, not the instant.
const DAY1 = new Date("2026-06-10T08:00:00Z");
const DAY1_LATER = new Date("2026-06-10T23:30:00Z");
const DAY2 = new Date("2026-06-11T09:15:00Z");
const DAY3 = new Date("2026-06-12T02:00:00Z");
const DAY4 = new Date("2026-06-13T12:00:00Z");

describe("streakService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("getStreakStats", () => {
    it("returns zeros for a student with no activity", () => {
      expect(getStreakStats({ userId: base.user.id, now: DAY1 })).toEqual({
        currentStreak: 0,
        longestStreak: 0,
      });
    });
  });

  describe("recordStreakActivity", () => {
    it("starts a streak at 1 on the first day", () => {
      const stats = recordStreakActivity({ userId: base.user.id, now: DAY1 });
      expect(stats).toEqual({ currentStreak: 1, longestStreak: 1 });
    });

    it("counts multiple completions in one UTC day as a single streak day", () => {
      recordStreakActivity({ userId: base.user.id, now: DAY1 });
      const stats = recordStreakActivity({
        userId: base.user.id,
        now: DAY1_LATER,
      });

      expect(stats).toEqual({ currentStreak: 1, longestStreak: 1 });
      // And only one streak_activities row exists for that day.
      const rows = testDb.select().from(schema.streakActivities).all();
      expect(rows).toHaveLength(1);
    });

    it("extends the streak on consecutive UTC days", () => {
      recordStreakActivity({ userId: base.user.id, now: DAY1 });
      recordStreakActivity({ userId: base.user.id, now: DAY2 });
      const stats = recordStreakActivity({ userId: base.user.id, now: DAY3 });

      expect(stats).toEqual({ currentStreak: 3, longestStreak: 3 });
    });

    it("resets the current streak to 1 after a missed UTC day, keeping longest", () => {
      recordStreakActivity({ userId: base.user.id, now: DAY1 });
      recordStreakActivity({ userId: base.user.id, now: DAY2 });
      recordStreakActivity({ userId: base.user.id, now: DAY3 });
      // Skip DAY4 entirely; next activity is two days later.
      const skipped = new Date("2026-06-15T10:00:00Z");
      const stats = recordStreakActivity({
        userId: base.user.id,
        now: skipped,
      });

      expect(stats).toEqual({ currentStreak: 1, longestStreak: 3 });
    });

    it("scopes streaks per user", () => {
      const other = testDb
        .insert(schema.users)
        .values({
          name: "Other",
          email: "other@example.com",
          role: schema.UserRole.Student,
        })
        .returning()
        .get();

      recordStreakActivity({ userId: base.user.id, now: DAY1 });
      recordStreakActivity({ userId: base.user.id, now: DAY2 });
      recordStreakActivity({ userId: other.id, now: DAY1 });

      expect(getStreakStats({ userId: base.user.id, now: DAY2 })).toEqual({
        currentStreak: 2,
        longestStreak: 2,
      });
      expect(getStreakStats({ userId: other.id, now: DAY1 })).toEqual({
        currentStreak: 1,
        longestStreak: 1,
      });
    });
  });

  describe("read-time lapse", () => {
    it("reports a still-live streak when last activity was yesterday", () => {
      recordStreakActivity({ userId: base.user.id, now: DAY1 });
      // Reading on DAY2 (gap of 1) keeps the streak live.
      expect(getStreakStats({ userId: base.user.id, now: DAY2 })).toEqual({
        currentStreak: 1,
        longestStreak: 1,
      });
    });

    it("reports current 0 once a full UTC day has lapsed, retaining longest", () => {
      recordStreakActivity({ userId: base.user.id, now: DAY1 });
      recordStreakActivity({ userId: base.user.id, now: DAY2 });
      // Reading on DAY4 — DAY3 was missed entirely (gap of 2 from DAY2).
      expect(getStreakStats({ userId: base.user.id, now: DAY4 })).toEqual({
        currentStreak: 0,
        longestStreak: 2,
      });
    });
  });
});
