import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { XpSourceType } from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the module picks up our test db
import {
  awardXp,
  getTotalXp,
  getGamificationStats,
  hasXpEvent,
  LESSON_COMPLETION_XP,
  QUIZ_FIRST_PASS_XP,
} from "./gamificationService";

function makeStudent(email: string) {
  return testDb
    .insert(schema.users)
    .values({ name: email, email, role: schema.UserRole.Student })
    .returning()
    .get();
}

describe("gamificationService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("awardXp", () => {
    it("inserts an event and returns true on first award", () => {
      const awarded = awardXp({
        userId: base.user.id,
        amount: LESSON_COMPLETION_XP,
        sourceType: XpSourceType.LessonCompletion,
        sourceId: 1,
      });

      expect(awarded).toBe(true);
      expect(getTotalXp(base.user.id)).toBe(10);
    });

    it("is idempotent — the same source never awards twice", () => {
      const opts = {
        userId: base.user.id,
        amount: LESSON_COMPLETION_XP,
        sourceType: XpSourceType.LessonCompletion,
        sourceId: 42,
      };

      expect(awardXp(opts)).toBe(true);
      expect(awardXp(opts)).toBe(false);

      expect(getTotalXp(base.user.id)).toBe(10);
      expect(testDb.select().from(schema.xpEvents).all()).toHaveLength(1);
    });

    it("accumulates XP across different sources into one global total", () => {
      awardXp({
        userId: base.user.id,
        amount: LESSON_COMPLETION_XP,
        sourceType: XpSourceType.LessonCompletion,
        sourceId: 1,
      });
      awardXp({
        userId: base.user.id,
        amount: LESSON_COMPLETION_XP,
        sourceType: XpSourceType.LessonCompletion,
        sourceId: 2,
      });
      awardXp({
        userId: base.user.id,
        amount: QUIZ_FIRST_PASS_XP,
        sourceType: XpSourceType.QuizFirstPass,
        sourceId: 1,
      });

      expect(getTotalXp(base.user.id)).toBe(25);
    });

    it("distinguishes the same sourceId across different source types", () => {
      awardXp({
        userId: base.user.id,
        amount: LESSON_COMPLETION_XP,
        sourceType: XpSourceType.LessonCompletion,
        sourceId: 1,
      });
      // Same sourceId (1) but a different type — a separate award.
      const awarded = awardXp({
        userId: base.user.id,
        amount: QUIZ_FIRST_PASS_XP,
        sourceType: XpSourceType.QuizFirstPass,
        sourceId: 1,
      });

      expect(awarded).toBe(true);
      expect(getTotalXp(base.user.id)).toBe(15);
    });

    it("scopes XP per user", () => {
      const other = makeStudent("other@example.com");

      awardXp({
        userId: base.user.id,
        amount: LESSON_COMPLETION_XP,
        sourceType: XpSourceType.LessonCompletion,
        sourceId: 1,
      });

      expect(getTotalXp(base.user.id)).toBe(10);
      expect(getTotalXp(other.id)).toBe(0);
    });
  });

  describe("getTotalXp", () => {
    it("returns 0 for a student with no events", () => {
      expect(getTotalXp(base.user.id)).toBe(0);
    });
  });

  describe("getGamificationStats", () => {
    it("returns sane zero-state values for a fresh student", () => {
      const stats = getGamificationStats(base.user.id);
      expect(stats).toEqual({
        totalXp: 0,
        level: 1,
        xpIntoLevel: 0,
        xpForLevel: 80,
        progress: 0,
      });
    });

    it("reflects level-up after 8 lessons (80 XP)", () => {
      for (let i = 1; i <= 8; i++) {
        awardXp({
          userId: base.user.id,
          amount: LESSON_COMPLETION_XP,
          sourceType: XpSourceType.LessonCompletion,
          sourceId: i,
        });
      }

      const stats = getGamificationStats(base.user.id);
      expect(stats.totalXp).toBe(80);
      expect(stats.level).toBe(2);
      expect(stats.xpIntoLevel).toBe(0);
      expect(stats.xpForLevel).toBe(197);
    });
  });

  describe("hasXpEvent", () => {
    it("is false before an award and true after", () => {
      const query = {
        userId: base.user.id,
        sourceType: XpSourceType.LessonCompletion,
        sourceId: 7,
      };

      expect(hasXpEvent(query)).toBe(false);
      awardXp({ ...query, amount: LESSON_COMPLETION_XP });
      expect(hasXpEvent(query)).toBe(true);
    });
  });
});
