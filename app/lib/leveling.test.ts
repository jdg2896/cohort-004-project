import { describe, it, expect } from "vitest";
import { xpForNextLevel, getLevelProgress } from "./leveling";

describe("leveling", () => {
  describe("xpForNextLevel", () => {
    it("matches the PRD curve at the documented levels", () => {
      // round(80 * N^1.3) — exact values (the PRD's ~345/~720 are loose
      // approximations; the formula is authoritative).
      expect(xpForNextLevel(1)).toBe(80);
      expect(xpForNextLevel(2)).toBe(197);
      expect(xpForNextLevel(3)).toBe(334);
      expect(xpForNextLevel(5)).toBe(648);
      expect(xpForNextLevel(10)).toBe(1596);
    });
  });

  describe("getLevelProgress", () => {
    it("a brand-new student is Level 1 with an empty bar", () => {
      const p = getLevelProgress(0);
      expect(p.level).toBe(1);
      expect(p.xpIntoLevel).toBe(0);
      expect(p.xpForLevel).toBe(80);
      expect(p.progress).toBe(0);
    });

    it("tracks partial progress within Level 1", () => {
      const p = getLevelProgress(40);
      expect(p.level).toBe(1);
      expect(p.xpIntoLevel).toBe(40);
      expect(p.xpForLevel).toBe(80);
      expect(p.progress).toBeCloseTo(0.5);
    });

    it("80 XP (8 lessons) is exactly Level 2 with a reset bar", () => {
      const p = getLevelProgress(80);
      expect(p.level).toBe(2);
      expect(p.xpIntoLevel).toBe(0);
      expect(p.xpForLevel).toBe(197);
      expect(p.progress).toBe(0);
    });

    it("carries leftover XP into the next level", () => {
      // 80 to reach L2, then 30 into L2's 197 needed for L3.
      const p = getLevelProgress(110);
      expect(p.level).toBe(2);
      expect(p.xpIntoLevel).toBe(30);
      expect(p.xpForLevel).toBe(197);
    });

    it("reaches Level 3 once the L2→L3 cost is also covered", () => {
      const p = getLevelProgress(80 + 197);
      expect(p.level).toBe(3);
      expect(p.xpIntoLevel).toBe(0);
      expect(p.xpForLevel).toBe(334);
    });

    it("clamps negative totals to Level 1", () => {
      const p = getLevelProgress(-50);
      expect(p.level).toBe(1);
      expect(p.xpIntoLevel).toBe(0);
    });
  });
});
