import { eq, and, sql } from "drizzle-orm";
import { db } from "~/db";
import { xpEvents, XpSourceType } from "~/db/schema";
import { getLevelProgress } from "~/lib/leveling";

// ─── Gamification Service ───
// Records XP awards and reads back a student's totals/level. The xp_events table
// is the single source of truth: total XP is the sum of all events, and level is
// always derived from that total (never stored). Awards are deduplicated by the
// unique (userId, sourceType, sourceId) index, so re-completing a lesson or
// re-passing a quiz never grants XP twice.

// Flat XP amounts per the PRD. Exported so callers award the canonical value
// rather than hard-coding magic numbers at each site.
export const LESSON_COMPLETION_XP = 10;
export const QUIZ_FIRST_PASS_XP = 5;

interface AwardXpOptions {
  userId: number;
  amount: number;
  sourceType: XpSourceType;
  sourceId: number;
}

// Records an XP award if one doesn't already exist for this
// (userId, sourceType, sourceId). Returns true if a new award was inserted, false
// if it was a duplicate (already awarded). Relies on the unique index to stay
// idempotent under races rather than a check-then-insert.
export function awardXp(opts: AwardXpOptions): boolean {
  const inserted = db
    .insert(xpEvents)
    .values({
      userId: opts.userId,
      amount: opts.amount,
      sourceType: opts.sourceType,
      sourceId: opts.sourceId,
    })
    .onConflictDoNothing()
    .returning()
    .get();

  return inserted !== undefined;
}

// Awards the one-time quiz XP on a student's first *passing* attempt. Failing
// attempts award nothing (and don't reserve the award), so a student who fails
// then later passes still earns the XP exactly once. The first pass inserts;
// every subsequent pass is a no-op via awardXp's unique-index dedup, keyed on
// (userId, QuizFirstPass, quizId). Returns true only when a new award was made.
export function awardQuizFirstPassXp(opts: {
  userId: number;
  quizId: number;
  passed: boolean;
}): boolean {
  if (!opts.passed) return false;

  return awardXp({
    userId: opts.userId,
    amount: QUIZ_FIRST_PASS_XP,
    sourceType: XpSourceType.QuizFirstPass,
    sourceId: opts.quizId,
  });
}

// Total XP a student has earned, summed across every source and every course
// (XP is global). Returns 0 for a student with no events.
export function getTotalXp(userId: number): number {
  const result = db
    .select({ total: sql<number>`coalesce(sum(${xpEvents.amount}), 0)` })
    .from(xpEvents)
    .where(eq(xpEvents.userId, userId))
    .get();

  return result?.total ?? 0;
}

export interface GamificationStats {
  totalXp: number;
  level: number;
  xpIntoLevel: number;
  xpForLevel: number;
  progress: number;
}

// The at-a-glance gamification stats for a student: total XP plus the derived
// level and progress toward the next level. Backs both the sidebar and dashboard.
export function getGamificationStats(userId: number): GamificationStats {
  const totalXp = getTotalXp(userId);
  const { level, xpIntoLevel, xpForLevel, progress } =
    getLevelProgress(totalXp);

  return { totalXp, level, xpIntoLevel, xpForLevel, progress };
}

// Whether a student has already been awarded XP for a given source. Lets callers
// (e.g. the quiz flow) branch before doing extra work, though awardXp is itself
// idempotent.
export function hasXpEvent(opts: {
  userId: number;
  sourceType: XpSourceType;
  sourceId: number;
}): boolean {
  const existing = db
    .select({ id: xpEvents.id })
    .from(xpEvents)
    .where(
      and(
        eq(xpEvents.userId, opts.userId),
        eq(xpEvents.sourceType, opts.sourceType),
        eq(xpEvents.sourceId, opts.sourceId)
      )
    )
    .get();

  return existing !== undefined;
}
