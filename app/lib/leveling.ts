// Shared leveling math for gamification. Pure functions with no DB or server
// dependencies, so they're safe to import on both the server (for awards and
// loader calculations) and the client (for rendering progress bars).
//
// The XP required to advance from level N to level N+1 is round(80 * N^1.3):
//   Level 1→2: 80 XP, 2→3: ~197 XP, 3→4: ~345 XP, 5→6: ~720 XP, 10→11: ~1,596 XP.
// Levels scale infinitely (no cap). A student's level is always derived from their
// total XP, never stored, so the two can never drift apart.

const BASE_XP = 80;
const EXPONENT = 1.3;

// XP needed to go from `level` to `level + 1`. Levels are 1-indexed.
export function xpForNextLevel(level: number): number {
  return Math.round(BASE_XP * Math.pow(level, EXPONENT));
}

export interface LevelProgress {
  level: number;
  // XP accumulated within the current level (resets to 0 on each level-up).
  xpIntoLevel: number;
  // XP required to advance from the current level to the next.
  xpForLevel: number;
  // Fraction toward the next level, 0–1, for rendering a progress bar.
  progress: number;
}

// Derives the current level and progress toward the next level from a total XP
// amount. Walks the curve cumulatively: each level's cost is subtracted until the
// remaining XP no longer covers the next level-up.
export function getLevelProgress(totalXp: number): LevelProgress {
  let level = 1;
  let remaining = Math.max(0, Math.floor(totalXp));

  let cost = xpForNextLevel(level);
  while (remaining >= cost) {
    remaining -= cost;
    level += 1;
    cost = xpForNextLevel(level);
  }

  return {
    level,
    xpIntoLevel: remaining,
    xpForLevel: cost,
    progress: cost === 0 ? 0 : remaining / cost,
  };
}
