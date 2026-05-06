import { query, mutation } from './functions'
import { internal } from './_generated/api'
import { v } from 'convex/values'
import {
  requireAuth,
  requireFounder,
  requireAdminForCohort,
  requireAdminForStartup,
  requireStartupAccess,
  getFounderStartupIds,
} from './auth'
import { getActiveWeekOf } from './lib/dateUtils'
import { computeStreak } from './lib/streak'

/**
 * Submit or update a weekly update (one per startup per week, upsert).
 * Founders can edit until Monday 9am UTC deadline.
 */
export const submit = mutation({
  args: {
    highlight: v.string(),
    primaryMetric: v.optional(
      v.object({
        label: v.string(),
        value: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    const user = await requireFounder(ctx)
    const startupIds = await getFounderStartupIds(ctx, user._id)
    if (startupIds.length === 0) throw new Error('No startup found')
    const startupId = startupIds[0]

    const now = new Date()
    // Active submission week: rolls at Mon 09:00 UTC, matching the deadline.
    // Using `getMonday(now)` here would roll at Mon 00:00 UTC and lock founders
    // out of last week's still-editable submission for 9 hours every Monday.
    const weekOf = getActiveWeekOf(now)

    // Check deadline: Monday 9am UTC of next week. All math in UTC so the
    // result is independent of the runtime's local timezone.
    const deadline = new Date(weekOf + 'T00:00:00.000Z')
    deadline.setUTCDate(deadline.getUTCDate() + 7) // Next Monday
    deadline.setUTCHours(9, 0, 0, 0)

    if (now > deadline) {
      throw new Error("The deadline for this week's update has passed (Monday 9am UTC)")
    }

    // Upsert: check if update exists for this startup + week
    const existing = await ctx.db
      .query('weeklyUpdates')
      .withIndex('by_startupId_weekOf', (q) => q.eq('startupId', startupId).eq('weekOf', weekOf))
      .first()

    if (existing) {
      await ctx.db.patch(existing._id, {
        highlight: args.highlight,
        primaryMetric: args.primaryMetric,
      })
    } else {
      await ctx.db.insert('weeklyUpdates', {
        startupId,
        founderId: user._id,
        weekOf,
        highlight: args.highlight,
        primaryMetric: args.primaryMetric,
        isFavorite: false,
        createdAt: now.toISOString(),
      })

      // Notify admins of new submission
      const startup = await ctx.db.get(startupId)
      if (startup) {
        await ctx.scheduler.runAfter(0, internal.notifications.notifyWeeklyUpdateSubmitted, {
          cohortId: startup.cohortId,
          startupName: startup.name,
        })
      }
    }
  },
})

/**
 * List all weekly updates for a specific week (admin view).
 */
export const list = query({
  args: {
    cohortId: v.id('cohorts'),
    weekOf: v.string(),
  },
  handler: async (ctx, args) => {
    await requireAdminForCohort(ctx, args.cohortId)

    // Get all startups in cohort
    const startups = await ctx.db
      .query('startups')
      .withIndex('by_cohortId', (q) => q.eq('cohortId', args.cohortId))
      .collect()

    const startupIds = new Set(startups.map((s) => s._id))

    // Get all updates for this week
    const updates = await ctx.db
      .query('weeklyUpdates')
      .withIndex('by_weekOf', (q) => q.eq('weekOf', args.weekOf))
      .collect()

    // Filter to this cohort's startups and join startup info
    return updates
      .filter((u) => startupIds.has(u.startupId))
      .map((u) => {
        const startup = startups.find((s) => s._id === u.startupId)
        return {
          ...u,
          startupName: startup?.name ?? 'Unknown',
          startupLogoUrl: startup?.logoUrl,
        }
      })
  },
})

/**
 * List a startup's update history (paginated).
 */
export const listForStartup = query({
  args: {
    startupId: v.optional(v.id('startups')),
  },
  handler: async (ctx, args) => {
    let startupId = args.startupId
    if (!startupId) {
      const user = await requireAuth(ctx)
      const startupIds = await getFounderStartupIds(ctx, user._id)
      if (startupIds.length === 0) return []
      startupId = startupIds[0]
    }
    await requireStartupAccess(ctx, startupId)

    const updates = await ctx.db
      .query('weeklyUpdates')
      .withIndex('by_startupId', (q) => q.eq('startupId', startupId!))
      .collect()

    return updates.sort((a, b) => b.weekOf.localeCompare(a.weekOf))
  },
})

/**
 * Get the current week's update for the founder's startup.
 */
export const getCurrent = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireFounder(ctx)
    const startupIds = await getFounderStartupIds(ctx, user._id)
    if (startupIds.length === 0) return null

    const weekOf = getActiveWeekOf(new Date())

    return await ctx.db
      .query('weeklyUpdates')
      .withIndex('by_startupId_weekOf', (q) =>
        q.eq('startupId', startupIds[0]).eq('weekOf', weekOf)
      )
      .first()
  },
})

/**
 * Set/unset favorite on a weekly update (admin only).
 * Max 2 favorites per week enforced.
 */
export const setFavorite = mutation({
  args: {
    updateId: v.id('weeklyUpdates'),
    isFavorite: v.boolean(),
  },
  handler: async (ctx, args) => {
    const update = await ctx.db.get(args.updateId)
    if (!update) throw new Error('Update not found')
    const { user } = await requireAdminForStartup(ctx, update.startupId)

    if (args.isFavorite) {
      // Check max 2 favorites per week
      const allUpdates = await ctx.db
        .query('weeklyUpdates')
        .withIndex('by_weekOf', (q) => q.eq('weekOf', update.weekOf))
        .collect()

      const favorites = allUpdates.filter((u) => u.isFavorite)
      if (favorites.length >= 2) {
        throw new Error('Maximum 2 favorites per week. Un-favorite one first.')
      }
    }

    await ctx.db.patch(args.updateId, {
      isFavorite: args.isFavorite,
      favoritedBy: args.isFavorite ? user._id : undefined,
    })

    // Notify founder when their update is favorited (only on false→true transition)
    if (args.isFavorite && !update.isFavorite) {
      const startup = await ctx.db.get(update.startupId)
      if (startup) {
        await ctx.scheduler.runAfter(0, internal.notifications.notifyWeeklyUpdateFavorited, {
          founderId: update.founderId,
          startupName: startup.name,
          weekOf: update.weekOf,
          cohortId: startup.cohortId,
        })
      }
    }
  },
})

/**
 * Get the current update streak for a startup (computed live from history).
 */
export const getCurrentStreak = query({
  args: {
    startupId: v.optional(v.id('startups')),
  },
  handler: async (ctx, args) => {
    let startupId = args.startupId
    if (!startupId) {
      const user = await requireAuth(ctx)
      const startupIds = await getFounderStartupIds(ctx, user._id)
      if (startupIds.length === 0) return 0
      startupId = startupIds[0]
    }
    await requireStartupAccess(ctx, startupId)

    const updates = await ctx.db
      .query('weeklyUpdates')
      .withIndex('by_startupId', (q) => q.eq('startupId', startupId!))
      .collect()

    return computeStreak(updates, new Date())
  },
})

/**
 * Get summary of weekly updates for admin review.
 */
export const getWeeklySummary = query({
  args: {
    cohortId: v.id('cohorts'),
    weekOf: v.string(),
  },
  handler: async (ctx, args) => {
    await requireAdminForCohort(ctx, args.cohortId)

    const startups = await ctx.db
      .query('startups')
      .withIndex('by_cohortId', (q) => q.eq('cohortId', args.cohortId))
      .collect()

    const updates = await ctx.db
      .query('weeklyUpdates')
      .withIndex('by_weekOf', (q) => q.eq('weekOf', args.weekOf))
      .collect()

    const startupIds = new Set(startups.map((s) => s._id))
    const cohortUpdates = updates.filter((u) => startupIds.has(u.startupId))
    const submittedIds = new Set(cohortUpdates.map((u) => u.startupId))

    const submitted = startups.filter((s) => submittedIds.has(s._id))
    const missing = startups.filter((s) => !submittedIds.has(s._id))
    const favorites = cohortUpdates.filter((u) => u.isFavorite)

    return {
      totalStartups: startups.length,
      submittedCount: submitted.length,
      missingCount: missing.length,
      favoriteCount: favorites.length,
      submitted: submitted.map((s) => ({ _id: s._id, name: s.name })),
      missing: missing.map((s) => ({ _id: s._id, name: s.name })),
    }
  },
})
