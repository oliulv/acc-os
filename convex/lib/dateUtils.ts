/**
 * Shared date utilities for leaderboard scoring and weekly updates.
 *
 * All week math is UTC. Founders in other timezones see "their Monday"
 * on a best-effort basis via the timezone hint in their profile — the
 * storage key is always UTC Monday. See TODOS.md for the follow-up on
 * per-user timezone weeks.
 */

/**
 * Get the Monday ISO date string (YYYY-MM-DD) for a given date, in UTC.
 *
 * UTC-only so the result is stable regardless of the runtime's local
 * timezone. Using `getDay`/`setDate` (local) here was a latent bug:
 * Convex runs in UTC today but the moment a test or script runs under
 * `TZ=America/Los_Angeles` the week boundary flips for a few hours every
 * Sunday night.
 */
export function getMonday(date: Date): string {
  const d = new Date(date)
  const day = d.getUTCDay()
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1)
  d.setUTCDate(diff)
  return d.toISOString().slice(0, 10)
}

/**
 * Active submission week for the founder weekly-update flow.
 *
 * Storage uses Monday 00:00 UTC as the week key, but the founder-facing
 * deadline is Monday 09:00 UTC of the following week. Between Mon 00:00 and
 * Mon 09:00 UTC, calendar week and submission window disagree: `getMonday`
 * has rolled over to the new week, but last week's submission is still
 * within its editable window. Shifting `now` back 9 hours before computing
 * the Monday closes the gap so the storage key flips at 09:00 UTC, in line
 * with the deadline.
 *
 * Use only on the founder submit/getCurrent path. Calendar-week consumers
 * (leaderboard, scoring, admin week pickers, streak walking) keep `getMonday`.
 */
export function getActiveWeekOf(now: Date): string {
  const shifted = new Date(now)
  shifted.setUTCHours(shifted.getUTCHours() - 9)
  return getMonday(shifted)
}

/**
 * Generate week boundaries for a rolling window (most recent first).
 * All date math is in UTC so the boundaries are timezone-stable — DST
 * transitions in the host runtime will not shift `start`/`end` by an hour.
 */
export function getWeekBoundaries(
  weeksBack: number
): Array<{ start: Date; end: Date; weekOf: string }> {
  const now = new Date()
  const weeks: Array<{ start: Date; end: Date; weekOf: string }> = []
  for (let i = 0; i < weeksBack; i++) {
    const d = new Date(now)
    d.setUTCDate(d.getUTCDate() - i * 7)
    const monday = getMonday(d)
    const start = new Date(monday + 'T00:00:00.000Z')
    const end = new Date(start)
    end.setUTCDate(end.getUTCDate() + 7)
    weeks.push({ start, end, weekOf: monday })
  }
  return weeks
}
