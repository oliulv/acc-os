import { query, mutation } from './functions'
import { v } from 'convex/values'
import { requireAdminForCohort, requireAuth, requireSuperAdmin } from './auth'
import type { Doc, Id } from './_generated/dataModel'
import { getWeekBoundaries } from './lib/dateUtils'
import {
  ACTIVE_WINDOW_DAYS,
  FAVORITE_WINDOW_DAYS,
  ROLLING_WEEKS,
  computeGrowthRate,
  computeLeaderboardScore,
  computeUpdateScore,
  computeVelocityScore,
  convertMergedCalendar,
  temporalDecay,
  type CategoryKey,
  type ScoringConfig,
  type ScoreResult,
  type TypedDayCounts,
  type MergedCalendarWeek,
} from './lib/scoring'
import { computeStreak } from './lib/streak'

// ── Score Breakdown Type ─────────────────────────────────────────────

export interface ScoreBreakdown {
  startupId: Id<'startups'>
  startupName: string
  startupSlug?: string
  startupLogoUrl?: string
  rank: number | null // null = unranked
  totalScore: number
  categories: {
    revenue: { raw: number; normalized: number; weighted: number; active: boolean }
    traffic: { raw: number; normalized: number; weighted: number; active: boolean }
    github: { raw: number; normalized: number; weighted: number; active: boolean }
    updates: { raw: number; normalized: number; weighted: number; active: boolean }
  }
  activeCategories: number
  qualified: boolean
  rankChange: number | null // positive = moved up, negative = moved down, null = no prior data
  /** True iff the startup has at least one admin favorite in the last 28 days. */
  hasFavoriteInWindow: boolean
  /** Count of admin favorites in the last 28 days (drives the multiplier). */
  favoritesInWindow: number
  /** Combined multiplier applied to baseScore. 1.0 when no favorites in window. */
  favoriteMultiplier: number
  updateStreak: number
  excludeFromMetrics: boolean
}

type Week = { start: Date; end: Date; weekOf: string }
type WeekWindow = Week[]

// ── Raw-data fetch (DB-reading, per startup) ─────────────────────────

/** Everything scoring needs for one startup, post-DB-read. Pure downstream. */
export interface StartupRawData {
  startup: Doc<'startups'>
  mrrMetrics: Doc<'metricsData'>[]
  sessionMetrics: Doc<'metricsData'>[]
  velocityCalendar: TypedDayCounts
  weeklyUpdates: Doc<'weeklyUpdates'>[]
}

async function readVelocityCalendar(
  ctx: { db: any },
  startupId: Id<'startups'>
): Promise<TypedDayCounts> {
  const typedMetric = await ctx.db
    .query('metricsData')
    .withIndex('by_startupId_provider_metricKey', (q: any) =>
      q
        .eq('startupId', startupId)
        .eq('provider', 'github')
        .eq('metricKey', 'typed_contribution_calendar')
    )
    .order('desc')
    .first()

  const typed = (typedMetric?.meta as TypedDayCounts | undefined) ?? {}
  if (Object.keys(typed).length > 0) return typed

  const mergedMetric = await ctx.db
    .query('metricsData')
    .withIndex('by_startupId_provider_metricKey', (q: any) =>
      q.eq('startupId', startupId).eq('provider', 'github').eq('metricKey', 'contribution_calendar')
    )
    .order('desc')
    .first()

  const merged = mergedMetric?.meta as MergedCalendarWeek[] | undefined
  if (merged && merged.length > 0) return convertMergedCalendar(merged)

  return {}
}

async function fetchStartupRawData(
  ctx: { db: any },
  startup: Doc<'startups'>
): Promise<StartupRawData> {
  const mrrMetrics = await ctx.db
    .query('metricsData')
    .withIndex('by_startupId_provider_metricKey', (q: any) =>
      q.eq('startupId', startup._id).eq('provider', 'stripe').eq('metricKey', 'mrr')
    )
    .collect()

  const sessionMetrics = await ctx.db
    .query('metricsData')
    .withIndex('by_startupId_provider_metricKey', (q: any) =>
      q.eq('startupId', startup._id).eq('provider', 'tracker').eq('metricKey', 'sessions')
    )
    .collect()

  const velocityCalendar = await readVelocityCalendar(ctx, startup._id)

  const weeklyUpdates = await ctx.db
    .query('weeklyUpdates')
    .withIndex('by_startupId', (q: any) => q.eq('startupId', startup._id))
    .collect()

  return {
    startup,
    mrrMetrics,
    sessionMetrics,
    velocityCalendar,
    weeklyUpdates,
  }
}

// ── Pure assembly: raw rows + weeks + now → per-category scalars ─────

export interface AssembledCategoryRaw {
  perCatRaw: Record<CategoryKey, number>
  perCatActive: Record<CategoryKey, boolean>
  updateStreak: number
}

/**
 * Pure function: given fetched rows + a sliding window of `ROLLING_WEEKS + 1`
 * week boundaries (so ROLLING_WEEKS growth pairs are possible) + `now`,
 * produce a single scalar raw value and an active flag per category.
 *
 * The caller must pass at least `ROLLING_WEEKS + 1` weeks. Weeks are
 * ordered most-recent-first: `weeks[0]` is the newest.
 *
 * Active-gate rules:
 *   revenue — ≥1 MRR snapshot > 0 in last 28 days
 *   traffic — ≥1 day with sessions > 0 in last 28 days
 *   github  — ≥1 contribution day in last 28 days
 *   updates — ≥1 weekly update submitted in last 28 days
 */
export function assembleCategoryRaw(
  raw: StartupRawData,
  weeks: WeekWindow,
  now: Date
): AssembledCategoryRaw {
  const windowCutoff = now.getTime() - ACTIVE_WINDOW_DAYS * 86400_000

  // ── Revenue (MRR growth, decayed sum across window) ────────────────
  let revenueRaw = 0
  let revenueActiveSnapshot = false
  for (let i = 0; i < ROLLING_WEEKS; i++) {
    const week = weeks[i]
    const prevWeek = weeks[i + 1]
    const thisMrr =
      raw.mrrMetrics
        .filter(
          (m) => m.timestamp >= week.start.toISOString() && m.timestamp < week.end.toISOString()
        )
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0]?.value ?? 0
    const prevMrr = prevWeek
      ? (raw.mrrMetrics
          .filter(
            (m) =>
              m.timestamp >= prevWeek.start.toISOString() &&
              m.timestamp < prevWeek.end.toISOString()
          )
          .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0]?.value ?? 0)
      : 0
    if (thisMrr > 0 && week.end.getTime() > windowCutoff) revenueActiveSnapshot = true
    const growth = computeGrowthRate(thisMrr, prevMrr)
    // Growth-only model: positive growth earns decaying points, declines earn 0.
    // A bad week shouldn't subtract from the score it took growth weeks to earn.
    if (growth !== null && growth > 0) revenueRaw += growth * temporalDecay(i)
  }

  // ── Traffic (session growth, decayed sum) ─────────────────────────
  let trafficRaw = 0
  let trafficActive = false
  for (let i = 0; i < ROLLING_WEEKS; i++) {
    const week = weeks[i]
    const prevWeek = weeks[i + 1]
    const thisSessions = raw.sessionMetrics
      .filter(
        (m) => m.timestamp >= week.start.toISOString() && m.timestamp < week.end.toISOString()
      )
      .reduce((sum, m) => sum + m.value, 0)
    const prevSessions = prevWeek
      ? raw.sessionMetrics
          .filter(
            (m) =>
              m.timestamp >= prevWeek.start.toISOString() &&
              m.timestamp < prevWeek.end.toISOString()
          )
          .reduce((sum, m) => sum + m.value, 0)
      : 0
    if (thisSessions > 0 && week.end.getTime() > windowCutoff) trafficActive = true
    const growth = computeGrowthRate(thisSessions, prevSessions)
    // Growth-only model: same as revenue — declines earn 0, not negative.
    if (growth !== null && growth > 0) trafficRaw += growth * temporalDecay(i)
  }

  // ── GitHub (velocity score; has internal 28-day decay) ────────────
  const githubRaw = computeVelocityScore(raw.velocityCalendar, now)
  // Active if any day in the last 28 had >0 contributions
  let githubActive = false
  const today = new Date(now.getTime())
  today.setUTCHours(0, 0, 0, 0)
  for (let daysAgo = 0; daysAgo < ACTIVE_WINDOW_DAYS; daysAgo++) {
    const d = new Date(today.getTime())
    d.setUTCDate(d.getUTCDate() - daysAgo)
    const dateStr = d.toISOString().slice(0, 10)
    const counts = raw.velocityCalendar[dateStr]
    if (counts && counts.commits + counts.prs + counts.issues > 0) {
      githubActive = true
      break
    }
  }

  // ── Updates (decayed sum of weekBase across submitted weeks) ──────
  const streak = computeStreak(raw.weeklyUpdates as any, now)
  const weekBase = computeUpdateScore(true, streak) * 10
  let updatesRaw = 0
  let updatesActive = false
  for (let i = 0; i < ROLLING_WEEKS; i++) {
    const week = weeks[i]
    const update = raw.weeklyUpdates.find((u) => u.weekOf === week.weekOf)
    if (update) {
      updatesRaw += weekBase * temporalDecay(i)
      if (week.end.getTime() > windowCutoff) updatesActive = true
    }
  }

  return {
    perCatRaw: {
      revenue: revenueRaw,
      traffic: trafficRaw,
      github: githubRaw,
      updates: updatesRaw,
    },
    perCatActive: {
      revenue: revenueActiveSnapshot,
      traffic: trafficActive,
      github: githubActive,
      updates: updatesActive,
    },
    updateStreak: streak,
  }
}

// ── Favorites (derived from weeklyUpdates, pure) ─────────────────────

/** Extract favorites within the 28-day window from a startup's weeklyUpdates. */
export function deriveFavorites(
  weeklyUpdates: Array<{ weekOf: string; isFavorite?: boolean }>,
  now: Date
): { favorites: Array<{ daysAgo: number }>; count: number; hasAny: boolean } {
  const favorites: Array<{ daysAgo: number }> = []
  for (const u of weeklyUpdates) {
    if (!u.isFavorite) continue
    const weekDate = new Date(u.weekOf + 'T00:00:00.000Z')
    const ts = weekDate.getTime()
    if (!Number.isFinite(ts)) continue
    const daysAgo = Math.floor((now.getTime() - ts) / 86400_000)
    // Keep favorites within window; the scorer additionally clamps negative
    // daysAgo and filters > 28.
    if (daysAgo <= FAVORITE_WINDOW_DAYS) favorites.push({ daysAgo })
  }
  return {
    favorites,
    count: favorites.length,
    hasAny: favorites.length > 0,
  }
}

// ── Ranking (pure) ───────────────────────────────────────────────────

export interface AssignRanksResult {
  /** Final rank per qualified startup (1-indexed, sorted by score desc). */
  rankings: Map<string, number>
  /** `prevRank - rank` per startup; null when we lack prev data for them. */
  rankChangeByStartup: Map<string, number | null>
}

/**
 * Pure ranking helper. Given current and previous score maps plus the set
 * of startups that qualify for ranking (activeCategories ≥ 3 AND
 * !excludeFromMetrics), produce the final rank order and per-startup rank
 * change.
 *
 * `rankChange = prevRank - currentRank`: positive means moved up.
 * null when either current or prev rank is missing for that startup.
 */
export function assignRanks(
  currentScores: Map<string, number>,
  prevScores: Map<string, number>,
  qualified: Set<string>
): AssignRanksResult {
  const currentRanked = [...currentScores.entries()]
    .filter(([id]) => qualified.has(id))
    .sort((a, b) => b[1] - a[1])
  const rankings = new Map<string, number>()
  currentRanked.forEach(([id], i) => rankings.set(id, i + 1))

  const prevRanked = [...prevScores.entries()]
    .filter(([id]) => qualified.has(id))
    .sort((a, b) => b[1] - a[1])
  const prevRankings = new Map<string, number>()
  prevRanked.forEach(([id], i) => prevRankings.set(id, i + 1))

  const rankChangeByStartup = new Map<string, number | null>()
  for (const id of rankings.keys()) {
    const prevRank = prevRankings.get(id)
    const currentRank = rankings.get(id)
    if (prevRank == null || currentRank == null) {
      rankChangeByStartup.set(id, null)
    } else {
      rankChangeByStartup.set(id, prevRank - currentRank)
    }
  }

  return { rankings, rankChangeByStartup }
}

// ── Cohort compute (shared by admin + founder queries) ───────────────

interface CohortLeaderboardResult {
  ranked: ScoreBreakdown[]
  unranked: ScoreBreakdown[]
  normalizationPower: number
}

async function computeCohortLeaderboard(
  ctx: { db: any },
  cohortId: Id<'cohorts'>
): Promise<CohortLeaderboardResult | null> {
  const cohort = await ctx.db.get(cohortId)
  if (!cohort) return null

  const normalizationPower = cohort.leaderboardConfig?.normalizationPower ?? 0.7
  const config: ScoringConfig = { normalizationPower }

  const startups = await ctx.db
    .query('startups')
    .withIndex('by_cohortId', (q: any) => q.eq('cohortId', cohortId))
    .collect()

  const now = new Date()
  // Need ROLLING_WEEKS + 2 boundaries: weeks[0..ROLLING_WEEKS] for current
  // window, weeks[1..ROLLING_WEEKS+1] for the shifted (prev-ranking) window.
  const allWeeks = getWeekBoundaries(ROLLING_WEEKS + 2)
  const currentWeeks = allWeeks.slice(0, ROLLING_WEEKS + 1)
  const shiftedWeeks = allWeeks.slice(1, ROLLING_WEEKS + 2)

  // Per-startup: fetch raw once, assemble twice (current + shifted), derive favorites once.
  const perStartup: Array<{
    startup: Doc<'startups'>
    currentAssembly: AssembledCategoryRaw
    shiftedAssembly: AssembledCategoryRaw
    favorites: ReturnType<typeof deriveFavorites>
  }> = []
  for (const startup of startups) {
    const raw = await fetchStartupRawData(ctx, startup)
    const currentAssembly = assembleCategoryRaw(raw, currentWeeks, now)
    const shiftedAssembly = assembleCategoryRaw(raw, shiftedWeeks, now)
    const favorites = deriveFavorites(raw.weeklyUpdates, now)
    perStartup.push({ startup, currentAssembly, shiftedAssembly, favorites })
  }

  // Cohort-wide max per category, per window.
  const cohortMaxFor = (assemblies: AssembledCategoryRaw[]): Record<CategoryKey, number> => {
    const max: Record<CategoryKey, number> = {
      revenue: 0,
      traffic: 0,
      github: 0,
      updates: 0,
    }
    for (const a of assemblies) {
      for (const key of Object.keys(max) as CategoryKey[]) {
        if (a.perCatRaw[key] > max[key]) max[key] = a.perCatRaw[key]
      }
    }
    return max
  }
  const currentMax = cohortMaxFor(perStartup.map((p) => p.currentAssembly))
  const shiftedMax = cohortMaxFor(perStartup.map((p) => p.shiftedAssembly))

  // Score each startup under both windows.
  const currentScores = new Map<string, number>()
  const prevScores = new Map<string, number>()
  const perStartupCurrent = new Map<string, ScoreResult>()
  const qualifiedSet = new Set<string>()

  for (const entry of perStartup) {
    const favorites = entry.favorites.favorites
    const current = computeLeaderboardScore(
      entry.currentAssembly.perCatRaw,
      entry.currentAssembly.perCatActive,
      currentMax,
      config,
      favorites
    )
    const shifted = computeLeaderboardScore(
      entry.shiftedAssembly.perCatRaw,
      entry.shiftedAssembly.perCatActive,
      shiftedMax,
      config,
      favorites
    )
    const id = String(entry.startup._id)
    currentScores.set(id, current.totalScore)
    prevScores.set(id, shifted.totalScore)
    perStartupCurrent.set(id, current)
    if (current.qualified && entry.startup.excludeFromMetrics !== true) {
      qualifiedSet.add(id)
    }
  }

  const { rankings, rankChangeByStartup } = assignRanks(currentScores, prevScores, qualifiedSet)

  const ranked: ScoreBreakdown[] = []
  const unranked: ScoreBreakdown[] = []

  for (const entry of perStartup) {
    const id = String(entry.startup._id)
    const current = perStartupCurrent.get(id)!
    const rank = rankings.get(id) ?? null
    const rankChange = rankChangeByStartup.get(id) ?? null

    const breakdown: ScoreBreakdown = {
      startupId: entry.startup._id,
      startupName: entry.startup.name,
      startupSlug: entry.startup.slug,
      startupLogoUrl: entry.startup.logoUrl,
      rank,
      totalScore: Math.round(current.totalScore * 100) / 100,
      categories: {
        revenue: {
          ...current.categories.revenue,
          active: entry.currentAssembly.perCatActive.revenue,
        },
        traffic: {
          ...current.categories.traffic,
          active: entry.currentAssembly.perCatActive.traffic,
        },
        github: {
          ...current.categories.github,
          active: entry.currentAssembly.perCatActive.github,
        },
        updates: {
          ...current.categories.updates,
          active: entry.currentAssembly.perCatActive.updates,
        },
      },
      activeCategories: current.activeCategories,
      qualified: current.qualified,
      rankChange,
      hasFavoriteInWindow: entry.favorites.hasAny,
      favoritesInWindow: entry.favorites.count,
      favoriteMultiplier: Math.round(current.favoriteMultiplier * 1000) / 1000,
      updateStreak: entry.currentAssembly.updateStreak,
      excludeFromMetrics: entry.startup.excludeFromMetrics === true,
    }

    if (rank !== null) ranked.push(breakdown)
    else unranked.push(breakdown)
  }

  ranked.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))

  return { ranked, unranked, normalizationPower }
}

// ── Public queries ───────────────────────────────────────────────────

/**
 * Compute the full leaderboard for a cohort.
 * All scoring is done on-read from raw data.
 */
export const computeLeaderboard = query({
  args: {
    cohortId: v.id('cohorts'),
  },
  handler: async (ctx, args) => {
    await requireAdminForCohort(ctx, args.cohortId)
    const result = await computeCohortLeaderboard(ctx, args.cohortId)
    if (!result) throw new Error('Cohort not found')
    return result
  },
})

/**
 * Compute leaderboard visible to founders (for their cohort).
 * Same scoring logic, but accessed via requireAuth instead of requireAdmin.
 */
export const computeLeaderboardForFounder = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireAuth(ctx)

    const founderProfile = await ctx.db
      .query('founderProfiles')
      .withIndex('by_userId', (q) => q.eq('userId', user._id))
      .first()
    if (!founderProfile) return null

    const startup = await ctx.db.get(founderProfile.startupId)
    if (!startup) return null

    const cohort = await ctx.db.get(startup.cohortId)
    if (!cohort) return null

    const result = await computeCohortLeaderboard(ctx, startup.cohortId)
    if (!result) return null

    const myEntry =
      result.ranked.find((r) => r.startupId === founderProfile.startupId) ??
      result.unranked.find((r) => r.startupId === founderProfile.startupId)

    return {
      ranked: result.ranked,
      unranked: result.unranked,
      normalizationPower: result.normalizationPower,
      myStartupId: founderProfile.startupId,
      myRank: myEntry?.rank ?? null,
      myScore: myEntry?.totalScore ?? 0,
      cohortName: cohort.label,
    }
  },
})

/**
 * Update the normalization power value for a cohort (super_admin only).
 */
export const updateNormalizationPower = mutation({
  args: {
    cohortId: v.id('cohorts'),
    normalizationPower: v.number(),
  },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx)

    if (args.normalizationPower < 0.3 || args.normalizationPower > 1.0) {
      throw new Error('Normalization power must be between 0.3 and 1.0')
    }

    await ctx.db.patch(args.cohortId, {
      leaderboardConfig: {
        normalizationPower: args.normalizationPower,
      },
    })
  },
})
