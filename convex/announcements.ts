import { query, mutation } from './functions'
import { internal } from './_generated/api'
import { v } from 'convex/values'
import {
  requireAdmin,
  requireAdminWithPermission,
  requireAdminForCohort,
  requireFounder,
  getFounderStartupIds,
  hasPermission,
} from './auth'

/** Trim and validate announcement title/body. Throws on invalid input. */
function normalizeAnnouncementContent(title: string, body: string) {
  const trimmedTitle = title.trim()
  const trimmedBody = body.trim()
  if (trimmedTitle.length === 0 || trimmedTitle.length > 100) {
    throw new Error('Title must be between 1 and 100 characters')
  }
  if (trimmedBody.length === 0 || trimmedBody.length > 10000) {
    throw new Error('Body must be between 1 and 10,000 characters')
  }
  return { title: trimmedTitle, body: trimmedBody }
}

/**
 * Check if the current admin can send announcements for a cohort.
 */
export const canSend = query({
  args: { cohortId: v.id('cohorts') },
  handler: async (ctx, args) => {
    const user = await requireAdmin(ctx)
    if (user.role === 'super_admin') return true
    await requireAdminForCohort(ctx, args.cohortId)
    return hasPermission(ctx, user._id, args.cohortId, 'send_announcements')
  },
})

/**
 * Create and send an announcement to all founders in a cohort.
 */
export const send = mutation({
  args: {
    cohortId: v.id('cohorts'),
    title: v.string(),
    body: v.string(),
    appUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await requireAdminWithPermission(ctx, args.cohortId, 'send_announcements')

    const { title, body } = normalizeAnnouncementContent(args.title, args.body)

    const cohort = await ctx.db.get(args.cohortId)
    if (!cohort) throw new Error('Cohort not found')

    // Count founders in cohort for recipientCount
    const startups = await ctx.db
      .query('startups')
      .withIndex('by_cohortId', (q) => q.eq('cohortId', args.cohortId))
      .collect()

    let founderCount = 0
    for (const startup of startups) {
      const profiles = await ctx.db
        .query('founderProfiles')
        .withIndex('by_startupId', (q) => q.eq('startupId', startup._id))
        .collect()
      founderCount += profiles.length
    }

    const announcementId = await ctx.db.insert('announcements', {
      cohortId: args.cohortId,
      title,
      body,
      sentByUserId: admin._id,
      sentAt: new Date().toISOString(),
      recipientCount: founderCount,
    })

    // Schedule SMS notification
    await ctx.scheduler.runAfter(0, internal.notifications.sendAnnouncementNotification, {
      cohortId: args.cohortId,
      title,
      body,
      appUrl: args.appUrl,
    })

    return announcementId
  },
})

/**
 * Update an existing announcement's title and body.
 * Does not resend SMS — the SMS links to the announcement, which now reflects the edits.
 */
export const update = mutation({
  args: {
    announcementId: v.id('announcements'),
    title: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.announcementId)
    if (!existing) throw new Error('Announcement not found')

    await requireAdminWithPermission(ctx, existing.cohortId, 'send_announcements')

    const { title, body } = normalizeAnnouncementContent(args.title, args.body)

    await ctx.db.patch(args.announcementId, { title, body })
  },
})

/** Helper to enrich an announcement with sender info. */
async function enrichWithSender(
  ctx: { db: { get: (id: any) => Promise<any> } },
  announcement: any
) {
  const sender = await ctx.db.get(announcement.sentByUserId)
  return {
    ...announcement,
    senderName: sender?.fullName ?? sender?.email ?? 'Unknown',
    senderImageUrl: sender?.imageUrl ?? null,
  }
}

/**
 * List announcements for a cohort (admin view).
 */
export const listForAdmin = query({
  args: { cohortId: v.id('cohorts') },
  handler: async (ctx, args) => {
    await requireAdminForCohort(ctx, args.cohortId)

    const announcements = await ctx.db
      .query('announcements')
      .withIndex('by_cohortId', (q) => q.eq('cohortId', args.cohortId))
      .collect()

    const enriched = await Promise.all(announcements.map((a) => enrichWithSender(ctx, a)))
    return enriched.sort((a, b) => b.sentAt.localeCompare(a.sentAt))
  },
})

/**
 * List announcements for the current founder's cohort.
 */
export const listForFounder = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireFounder(ctx)
    const startupIds = await getFounderStartupIds(ctx, user._id)
    if (startupIds.length === 0) return []

    const startup = await ctx.db.get(startupIds[0])
    if (!startup) return []

    const announcements = await ctx.db
      .query('announcements')
      .withIndex('by_cohortId', (q) => q.eq('cohortId', startup.cohortId))
      .collect()

    const enriched = await Promise.all(announcements.map((a) => enrichWithSender(ctx, a)))
    return enriched.sort((a, b) => b.sentAt.localeCompare(a.sentAt))
  },
})

/**
 * Get recent announcements for founder dashboard (last 3).
 */
export const recentForFounder = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireFounder(ctx)
    const startupIds = await getFounderStartupIds(ctx, user._id)
    if (startupIds.length === 0) return []

    const startup = await ctx.db.get(startupIds[0])
    if (!startup) return []

    const announcements = await ctx.db
      .query('announcements')
      .withIndex('by_cohortId', (q) => q.eq('cohortId', startup.cohortId))
      .collect()

    const enriched = await Promise.all(announcements.map((a) => enrichWithSender(ctx, a)))
    return enriched.sort((a, b) => b.sentAt.localeCompare(a.sentAt)).slice(0, 3)
  },
})
