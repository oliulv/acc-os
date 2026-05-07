/**
 * Shared scoring engine for leaderboard rankings.
 *
 * Score range: 0.0 – ~100+ (displayed as-is in the UI).
 *
 * Categories (v1, no social, no milestones — milestones drive funding
 * unlock, not scoring):
 *   Revenue 35%  — MRR growth rate (week-over-week %), 4-week decayed sum
 *   Traffic 25%  — Session growth rate (week-over-week %), 4-week decayed sum
 *   GitHub  25%  — Velocity score (commits + PRs + issues) with 28-day daily decay
 *   Updates 15%  — Weekly update × streak multiplier, 4-week decayed sum
 *
 * Policy:
 *   - Growth-only: every week of positive WoW growth earns points; declines
 *     earn 0, not negative. A single bad week can't erase points the startup
 *     earned through growth. Time still erodes points via temporal decay.
 *   - Absolute weights — a startup with only 1 active category caps at
 *     that category's weight × 100 (breadth matters, no re-weighting).
 *   - No participation floor. Zero raw → zero normalized → zero weighted.
 *   - Admin favorites apply an exp-decay multiplier over a 28-day window.
 */

// ── Constants ────────────────────────────────────────────────────────

export const CATEGORY_KEYS = ['revenue', 'traffic', 'github', 'updates'] as const
export type CategoryKey = (typeof CATEGORY_KEYS)[number]

export const WEIGHTS: Record<CategoryKey, number> = {
  revenue: 0.35,
  traffic: 0.25,
  github: 0.25,
  updates: 0.15,
}

export const DECAY_RATE = 0.03

// Per-type velocity scoring weights (used by the unified formula)
export const COMMIT_PTS = 10
export const PR_PTS = 25
export const ISSUE_PTS = 15
export const ROLLING_WEEKS = 4
export const QUALIFICATION_THRESHOLD = 3
export const GROWTH_RATE_CAP_MAX = 200 // +200%
export const GROWTH_RATE_CAP_MIN = -100 // -100%

// Favorite multiplier parameters. Each favorite in the 28-day window adds
// a decaying boost to the multiplier. Max stackable boost with 8 recent
// favorites (2/wk × 4 wks, no decay): ~0.80 → multiplier ~1.80. In practice
// decay trims this to ~1.37 for 8 evenly-spaced favs.
export const FAVORITE_WEIGHT = 0.1
export const FAVORITE_DECAY_RATE = 0.1
export const FAVORITE_WINDOW_DAYS = 28

// Active-category gate window. A category is "active" iff it has data
// newer than this cutoff. Currently equal to FAVORITE_WINDOW_DAYS, but
// named separately because the two are semantically independent — one
// can move without the other.
export const ACTIVE_WINDOW_DAYS = 28

export type TypedDayCounts = Record<string, { commits: number; prs: number; issues: number }>

export type MergedCalendarWeek = {
  contributionDays?: Array<{ date: string; contributionCount?: number }>
}

/**
 * Convert GitHub's merged contributionCalendar format to our per-type format.
 * All contributions counted as commits (we don't know the breakdown from merged data).
 */
export function convertMergedCalendar(weeks: MergedCalendarWeek[]): TypedDayCounts {
  const typed: TypedDayCounts = {}
  for (const week of weeks) {
    for (const day of week.contributionDays ?? []) {
      if ((day.contributionCount ?? 0) > 0) {
        typed[day.date] = { commits: day.contributionCount ?? 0, prs: 0, issues: 0 }
      }
    }
  }
  return typed
}

export interface VelocityBreakdown {
  commits: { count: number; points: number }
  prs: { count: number; points: number }
  issues: { count: number; points: number }
  total: number
  rawTotal: number
}

export function buildVelocityTimeSeries(
  calendar: TypedDayCounts,
  startDate?: string,
  asOf = new Date()
): { timestamp: string; value: number }[] {
  const allDates = Object.keys(calendar).sort()
  if (allDates.length === 0) return []

  const earliestDay = new Date(`${allDates[0]}T00:00:00.000Z`)
  const requestedStart = startDate ? new Date(startDate) : earliestDay
  const outputStart = requestedStart > earliestDay ? requestedStart : earliestDay

  const today = new Date(asOf.getTime())
  today.setUTCHours(0, 0, 0, 0)

  const current = new Date(outputStart.getTime())
  current.setUTCHours(0, 0, 0, 0)

  const result: { timestamp: string; value: number }[] = []
  while (current <= today) {
    result.push({
      timestamp: `${current.toISOString().slice(0, 10)}T00:00:00.000Z`,
      value: computeVelocityScore(calendar, current),
    })
    current.setUTCDate(current.getUTCDate() + 1)
  }

  return result
}

/**
 * Compute the velocity score for a single day's snapshot using the unified
 * formula: 28-day rolling window with per-type weights and temporal decay.
 */
export function computeVelocityScore(calendar: TypedDayCounts, asOf?: Date): number {
  const today = asOf ? new Date(asOf.getTime()) : new Date()
  today.setUTCHours(0, 0, 0, 0)
  let score = 0
  for (let daysAgo = 0; daysAgo < 28; daysAgo++) {
    const d = new Date(today.getTime())
    d.setUTCDate(d.getUTCDate() - daysAgo)
    const dateStr = d.toISOString().slice(0, 10)
    const counts = calendar[dateStr]
    if (!counts) continue
    const dayScore = counts.commits * COMMIT_PTS + counts.prs * PR_PTS + counts.issues * ISSUE_PTS
    score += dayScore * Math.exp(-DECAY_RATE * daysAgo)
  }
  return Math.round(score)
}

/**
 * Decompose a velocity score into per-type contributions. Each type's
 * `points` field is the decayed contribution — they sum to `total` exactly
 * (before rounding).
 */
export function computeVelocityBreakdown(calendar: TypedDayCounts, asOf?: Date): VelocityBreakdown {
  const today = asOf ? new Date(asOf.getTime()) : new Date()
  today.setUTCHours(0, 0, 0, 0)
  let commitsPts = 0
  let prsPts = 0
  let issuesPts = 0
  let rawCommits = 0
  let rawPrs = 0
  let rawIssues = 0
  for (let daysAgo = 0; daysAgo < 28; daysAgo++) {
    const d = new Date(today.getTime())
    d.setUTCDate(d.getUTCDate() - daysAgo)
    const dateStr = d.toISOString().slice(0, 10)
    const counts = calendar[dateStr]
    if (!counts) continue
    const decay = Math.exp(-DECAY_RATE * daysAgo)
    commitsPts += counts.commits * COMMIT_PTS * decay
    prsPts += counts.prs * PR_PTS * decay
    issuesPts += counts.issues * ISSUE_PTS * decay
    rawCommits += counts.commits
    rawPrs += counts.prs
    rawIssues += counts.issues
  }
  const total = Math.round(commitsPts + prsPts + issuesPts)
  return {
    commits: { count: rawCommits, points: Math.round(commitsPts) },
    prs: { count: rawPrs, points: Math.round(prsPts) },
    issues: { count: rawIssues, points: Math.round(issuesPts) },
    total,
    rawTotal: rawCommits * COMMIT_PTS + rawPrs * PR_PTS + rawIssues * ISSUE_PTS,
  }
}

// ── Types ────────────────────────────────────────────────────────────

export interface ScoringConfig {
  normalizationPower: number // 0.3 – 1.0, default 0.7
}

export interface CategoryScore {
  raw: number
  normalized: number
  weighted: number
}

export interface ScoreResult {
  totalScore: number
  baseScore: number
  favoriteMultiplier: number
  categories: Record<CategoryKey, CategoryScore>
  activeCategories: number
  qualified: boolean
}

// ── Pure scoring functions ───────────────────────────────────────────

/** Exponential temporal decay based on week index (0 = current week). */
export function temporalDecay(weekIndex: number): number {
  const daysOld = weekIndex * 7
  return Math.exp(-DECAY_RATE * daysOld)
}

/**
 * Power-law normalization: compresses the distribution so outliers
 * don't dominate. A power < 1 makes scores closer together.
 *
 * Returns 0–1. If maxInCohort is 0, returns 0.
 */
export function powerLawNormalize(raw: number, maxInCohort: number, power: number): number {
  if (maxInCohort <= 0) return 0
  const ratio = Math.max(0, raw) / maxInCohort
  return Math.pow(Math.min(ratio, 1), power)
}

/**
 * Compute week-over-week growth rate with edge-case handling.
 *
 * Returns a percentage (e.g. 50 for +50%), capped to [-100, +200].
 * Returns `null` if both values are 0 (category inactive for this week).
 */
export function computeGrowthRate(current: number, previous: number): number | null {
  if (current === 0 && previous === 0) return null
  if (previous === 0 && current > 0) return 100 // zero-to-positive
  if (previous > 0 && current === 0) return -100 // positive-to-zero
  const rate = ((current - previous) / previous) * 100
  return Math.max(GROWTH_RATE_CAP_MIN, Math.min(GROWTH_RATE_CAP_MAX, rate))
}

/** Check if a startup qualifies for extra funding (>= 3/5 active categories). */
export function isQualified(activeCategoryCount: number): boolean {
  return activeCategoryCount >= QUALIFICATION_THRESHOLD
}

/**
 * Weekly update raw score: binary submit + streak bonus.
 *
 * raw = 1.0 if submitted, else 0.0
 * streak_bonus = 0.1 × min(streak, 8)   →  max +0.8
 * total range: 0.0 – 1.8
 */
export function computeUpdateScore(submitted: boolean, streak: number): number {
  const base = submitted ? 1.0 : 0.0
  const bonus = 0.1 * Math.min(streak, 8)
  return base + bonus
}

/**
 * Compute the favorite multiplier for a startup given favorites within the
 * 28-day window. Each favorite contributes `FAVORITE_WEIGHT × exp(-FAVORITE_DECAY_RATE × daysAgo)`.
 * Out-of-window favorites (daysAgo > FAVORITE_WINDOW_DAYS) contribute 0.
 * Negative daysAgo (future weekOf, edge case from direct DB mutation) is
 * clamped to 0 so a future-dated favorite doesn't silently amplify.
 *
 * No favorites → multiplier = 1 exactly.
 */
export function computeFavoriteMultiplier(favorites: Array<{ daysAgo: number }>): number {
  let totalBoost = 0
  for (const fav of favorites) {
    const clamped = Math.max(0, fav.daysAgo)
    if (clamped > FAVORITE_WINDOW_DAYS) continue
    totalBoost += FAVORITE_WEIGHT * Math.exp(-FAVORITE_DECAY_RATE * clamped)
  }
  return 1 + totalBoost
}

// ── Main scoring function ────────────────────────────────────────────

/**
 * Compute the composite score for a single startup given its per-category
 * raw scalars and active flags. The caller is responsible for reducing
 * category-specific weekly data (growth rates, velocity scores, absolute
 * counts) to a single number per category before calling this function —
 * the category-specific math intentionally lives outside this pure helper.
 *
 * Weights are ABSOLUTE, not re-weighted for active categories. A startup
 * with only milestones active caps at 100 × 0.15 = 15. Breadth matters.
 *
 * `maxInCohort` is the per-category maximum raw value across the cohort
 * for this scoring cycle. Used for power-law normalization. Zero max →
 * normalized = 0 (no divide-by-zero, no NaN).
 *
 * `favorites` is the list of admin favorites for this startup within the
 * 28-day window, represented as `{ daysAgo: number }` so this function
 * stays free of time parsing. Caller computes daysAgo from each favorite's
 * weekOf. Out-of-window favorites are filtered here.
 */
export function computeLeaderboardScore(
  perCatRaw: Record<CategoryKey, number>,
  perCatActive: Record<CategoryKey, boolean>,
  maxInCohort: Record<CategoryKey, number>,
  config: ScoringConfig,
  favorites: Array<{ daysAgo: number }>
): ScoreResult {
  const categories = {} as Record<CategoryKey, CategoryScore>
  let activeCount = 0
  let baseScore = 0

  for (const key of CATEGORY_KEYS) {
    const raw = perCatRaw[key] ?? 0
    const active = perCatActive[key] ?? false

    const normalized =
      powerLawNormalize(raw, maxInCohort[key] ?? 0, config.normalizationPower) * 100

    let weighted = 0
    if (active) {
      activeCount++
      weighted = normalized * WEIGHTS[key]
      baseScore += weighted
    }

    categories[key] = { raw, normalized, weighted }
  }

  const favoriteMultiplier = computeFavoriteMultiplier(favorites)
  const totalScore = baseScore * favoriteMultiplier

  return {
    totalScore,
    baseScore,
    favoriteMultiplier,
    categories,
    activeCategories: activeCount,
    qualified: isQualified(activeCount),
  }
}
