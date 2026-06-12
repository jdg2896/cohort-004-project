import { eq } from "drizzle-orm";
import { db } from "~/db";
import { streakActivities, streakStats } from "~/db/schema";

// ─── Streak Service ───
// Tracks a student's daily lesson-completion streak. streak_activities is the
// append-only source of truth (one row per user per UTC day); streak_stats holds
// the denormalized current/longest streak so the sidebar and dashboard read a
// single row instead of rescanning the log. Everything is UTC-based: there is no
// timezone localization and no grace/freeze — miss a full UTC day and the streak
// resets to 0, while the longest streak is a high-water mark that never decreases.

// The UTC calendar day (YYYY-MM-DD) of a given instant.
function utcDayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Whole UTC days between two YYYY-MM-DD strings, computed as `a - b`.
function dayDiff(a: string, b: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round(
    (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / msPerDay
  );
}

export interface StreakStats {
  currentStreak: number;
  longestStreak: number;
}

// Records that a student completed a lesson today (UTC) and returns their updated
// streak. The first completion of a UTC day extends the streak (or resets it to 1
// if a day was missed); subsequent completions the same day are no-ops via the
// unique (userId, activityDate) index. `now` is injectable for tests; production
// callers omit it. Students only — callers gate on role before invoking.
export function recordStreakActivity(opts: {
  userId: number;
  now?: Date;
}): StreakStats {
  const today = utcDayString(opts.now ?? new Date());

  // One row per user per UTC day. A duplicate insert (already active today) is a
  // no-op, so cramming multiple lessons into one day counts as a single day.
  const inserted = db
    .insert(streakActivities)
    .values({ userId: opts.userId, activityDate: today })
    .onConflictDoNothing()
    .returning()
    .get();

  const existing = db
    .select()
    .from(streakStats)
    .where(eq(streakStats.userId, opts.userId))
    .get();

  if (inserted === undefined) {
    // Already counted today — leave the stored streak untouched, but still apply
    // the read-time lapse check in case the row is stale.
    return getStreakStats({ userId: opts.userId, now: opts.now });
  }

  let currentStreak: number;
  if (existing?.lastActivityDate) {
    // A consecutive UTC day (gap of exactly 1) extends; any larger gap means a
    // full day was missed, so the streak restarts at 1.
    const gap = dayDiff(today, existing.lastActivityDate);
    currentStreak = gap === 1 ? existing.currentStreak + 1 : 1;
  } else {
    currentStreak = 1;
  }

  const longestStreak = Math.max(existing?.longestStreak ?? 0, currentStreak);

  db.insert(streakStats)
    .values({
      userId: opts.userId,
      currentStreak,
      longestStreak,
      lastActivityDate: today,
    })
    .onConflictDoUpdate({
      target: streakStats.userId,
      set: {
        currentStreak,
        longestStreak,
        lastActivityDate: today,
        updatedAt: new Date().toISOString(),
      },
    })
    .run();

  return { currentStreak, longestStreak };
}

// A student's current and longest streak. Returns zeros for a student with no
// activity. The stored current streak is only "live" if the last activity was
// today or yesterday (UTC); once a full day lapses it reads as 0 without any
// write, while the longest streak is always the stored high-water mark.
export function getStreakStats(opts: {
  userId: number;
  now?: Date;
}): StreakStats {
  const stats = db
    .select()
    .from(streakStats)
    .where(eq(streakStats.userId, opts.userId))
    .get();

  if (!stats) return { currentStreak: 0, longestStreak: 0 };

  let currentStreak = stats.currentStreak;
  if (stats.lastActivityDate) {
    const today = utcDayString(opts.now ?? new Date());
    // gap >= 2 means at least one full UTC day passed with no completion.
    if (dayDiff(today, stats.lastActivityDate) >= 2) currentStreak = 0;
  }

  return { currentStreak, longestStreak: stats.longestStreak };
}
