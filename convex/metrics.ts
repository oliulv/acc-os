import { query, action, internalAction, internalMutation, internalQuery } from './functions'
import { api, internal } from './_generated/api'
import { v } from 'convex/values'
import { requireStartupAccess } from './auth'
import { logConvexError } from './lib/logging'
import { providerValidator } from './lib/providers'
import { normalizeToMonthlyCents } from './lib/stripeMrr'
import {
  computeVelocityScore,
  computeVelocityBreakdown,
  buildVelocityTimeSeries,
  convertMergedCalendar,
  type TypedDayCounts,
  type MergedCalendarWeek,
} from './lib/scoring'
import {
  normalizeGithubStatsMeta,
  buildFounderTypedCalendar,
  buildTypedDayCountsFromSearchResults,
  computeUnattributedContributionCount,
  buildContributionCalendarWeeksFromTypedDayCounts,
  type ContributionsInput,
  type FounderGithubStats,
  type SearchContributionHit,
} from './lib/githubStats'
import { buildTrackerDailyMetrics, trackerRollupWindow } from './lib/trackerRollup'

/**
 * Store metric snapshots (upserts by day to avoid duplicates).
 * Internal only — not exposed as a public API.
 */
export const store = internalMutation({
  args: {
    snapshots: v.array(
      v.object({
        startupId: v.id('startups'),
        provider: providerValidator,
        metricKey: v.string(),
        value: v.number(),
        timestamp: v.string(),
        window: v.union(v.literal('daily'), v.literal('weekly'), v.literal('monthly')),
        meta: v.optional(v.any()),
      })
    ),
  },
  handler: async (ctx, args) => {
    for (const snapshot of args.snapshots) {
      const dayTs = snapshot.timestamp.slice(0, 10) + 'T00:00:00.000Z'

      const existing = await ctx.db
        .query('metricsData')
        .withIndex('by_startupId_provider_metricKey', (q) =>
          q
            .eq('startupId', snapshot.startupId)
            .eq('provider', snapshot.provider)
            .eq('metricKey', snapshot.metricKey)
        )
        .filter((q) => q.eq(q.field('timestamp'), dayTs))
        .first()

      if (existing) {
        await ctx.db.patch(existing._id, { value: snapshot.value, meta: snapshot.meta })
      } else {
        await ctx.db.insert('metricsData', { ...snapshot, timestamp: dayTs })
      }
    }
  },
})

/**
 * Get latest metric value for a startup/provider/metric.
 */
export const getLatest = query({
  args: {
    startupId: v.id('startups'),
    provider: providerValidator,
    metricKey: v.string(),
    window: v.union(v.literal('daily'), v.literal('weekly'), v.literal('monthly')),
  },
  handler: async (ctx, args) => {
    await requireStartupAccess(ctx, args.startupId)

    const metrics = await ctx.db
      .query('metricsData')
      .withIndex('by_startupId_provider_metricKey', (q) =>
        q
          .eq('startupId', args.startupId)
          .eq('provider', args.provider)
          .eq('metricKey', args.metricKey)
      )
      .filter((q) => q.eq(q.field('window'), args.window))
      .collect()

    if (metrics.length === 0) return null

    // Sort by timestamp descending, return latest
    metrics.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    return metrics[0].value
  },
})

/**
 * Get metric time series.
 */
export const timeSeries = query({
  args: {
    startupId: v.id('startups'),
    provider: providerValidator,
    metricKey: v.string(),
    window: v.union(v.literal('daily'), v.literal('weekly'), v.literal('monthly')),
    startDate: v.optional(v.string()),
    endDate: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireStartupAccess(ctx, args.startupId)

    let metrics = await ctx.db
      .query('metricsData')
      .withIndex('by_startupId_provider_metricKey', (q) =>
        q
          .eq('startupId', args.startupId)
          .eq('provider', args.provider)
          .eq('metricKey', args.metricKey)
      )
      .filter((q) => q.eq(q.field('window'), args.window))
      .collect()

    // Filter by date range
    if (args.startDate) {
      metrics = metrics.filter((m) => m.timestamp >= args.startDate!)
    }
    if (args.endDate) {
      metrics = metrics.filter((m) => m.timestamp <= args.endDate!)
    }

    // Dedup: keep latest value per day (handles pre-existing duplicates)
    const byDay = new Map<string, { timestamp: string; value: number }>()
    for (const m of metrics) {
      const day = m.timestamp.slice(0, 10)
      const existing = byDay.get(day)
      if (!existing || m.timestamp > existing.timestamp) {
        byDay.set(day, { timestamp: m.timestamp, value: m.value })
      }
    }

    return Array.from(byDay.values()).sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  },
})

/**
 * Get velocity score time series with 28-day rolling window and temporal decay.
 * Single source of truth — same formula as the stored velocity_score metric.
 *
 * Uses the typed contribution calendar (per-type per-day counts) when available.
 * Falls back to the merged calendar (all types × 10) for pre-migration data.
 */
export const getVelocityTimeSeries = query({
  args: {
    startupId: v.id('startups'),
    startDate: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireStartupAccess(ctx, args.startupId)

    // Prefer typed calendar (per-type weights); fall back to merged calendar
    const typedMetric = await ctx.db
      .query('metricsData')
      .withIndex('by_startupId_provider_metricKey', (q) =>
        q
          .eq('startupId', args.startupId)
          .eq('provider', 'github')
          .eq('metricKey', 'typed_contribution_calendar')
      )
      .order('desc')
      .first()

    const typedCalendar = typedMetric?.meta as TypedDayCounts | undefined

    if (typedCalendar && Object.keys(typedCalendar).length > 0) {
      return buildTimeSeries(typedCalendar, args.startDate, true)
    }

    // Fallback: merged calendar (pre-migration data, all types × 10)
    const calendarMetric = await ctx.db
      .query('metricsData')
      .withIndex('by_startupId_provider_metricKey', (q) =>
        q
          .eq('startupId', args.startupId)
          .eq('provider', 'github')
          .eq('metricKey', 'contribution_calendar')
      )
      .order('desc')
      .first()

    const calendar = calendarMetric?.meta as MergedCalendarWeek[] | undefined

    if (!calendar || calendar.length === 0) return []

    return buildTimeSeries(convertMergedCalendar(calendar), args.startDate, false)
  },
})

function buildTimeSeries(
  calendar: TypedDayCounts,
  startDate: string | undefined,
  _isTyped: boolean
): { timestamp: string; value: number }[] {
  return buildVelocityTimeSeries(calendar, startDate)
}

/**
 * Get the latest GitHub contribution calendar data for a startup.
 */
export const getContributionCalendar = query({
  args: { startupId: v.id('startups') },
  handler: async (ctx, args) => {
    await requireStartupAccess(ctx, args.startupId)

    const metric = await ctx.db
      .query('metricsData')
      .withIndex('by_startupId_provider_metricKey', (q) =>
        q
          .eq('startupId', args.startupId)
          .eq('provider', 'github')
          .eq('metricKey', 'contribution_calendar')
      )
      .order('desc')
      .first()

    return metric?.meta ?? null
  },
})

/**
 * Decompose today's velocity score by contribution type.
 * Each type's `points` is the decayed contribution — they sum to `total`.
 */
export const getVelocityBreakdown = query({
  args: { startupId: v.id('startups') },
  handler: async (ctx, args) => {
    await requireStartupAccess(ctx, args.startupId)

    // Prefer typed calendar; fall back to merged calendar (pre-migration)
    const typedMetric = await ctx.db
      .query('metricsData')
      .withIndex('by_startupId_provider_metricKey', (q) =>
        q
          .eq('startupId', args.startupId)
          .eq('provider', 'github')
          .eq('metricKey', 'typed_contribution_calendar')
      )
      .order('desc')
      .first()

    let teamCalendar: TypedDayCounts = (typedMetric?.meta as TypedDayCounts | undefined) ?? {}

    // Fallback: convert merged calendar to typed format (all counts as commits)
    if (Object.keys(teamCalendar).length === 0) {
      const calendarMetric = await ctx.db
        .query('metricsData')
        .withIndex('by_startupId_provider_metricKey', (q) =>
          q
            .eq('startupId', args.startupId)
            .eq('provider', 'github')
            .eq('metricKey', 'contribution_calendar')
        )
        .order('desc')
        .first()

      const calendar = calendarMetric?.meta as MergedCalendarWeek[] | undefined
      if (calendar) {
        teamCalendar = convertMergedCalendar(calendar)
      }
    }

    const founderMetric = await ctx.db
      .query('metricsData')
      .withIndex('by_startupId_provider_metricKey', (q) =>
        q
          .eq('startupId', args.startupId)
          .eq('provider', 'github')
          .eq('metricKey', 'typed_contribution_calendar_by_founder')
      )
      .order('desc')
      .first()

    let founderCalendars = (founderMetric?.meta as Record<string, TypedDayCounts> | undefined) ?? {}

    // Check if typed per-founder data has any actual contribution days
    const hasTypedFounderData = Object.values(founderCalendars).some(
      (cal) => cal && Object.keys(cal).length > 0
    )

    // Fallback: convert merged per-founder calendar to typed format
    if (!hasTypedFounderData) {
      const mergedFounderMetric = await ctx.db
        .query('metricsData')
        .withIndex('by_startupId_provider_metricKey', (q) =>
          q
            .eq('startupId', args.startupId)
            .eq('provider', 'github')
            .eq('metricKey', 'contribution_calendar_by_founder')
        )
        .order('desc')
        .first()

      const mergedFounderCals = mergedFounderMetric?.meta as
        | Record<string, MergedCalendarWeek[]>
        | undefined

      if (mergedFounderCals) {
        const converted: Record<string, TypedDayCounts> = {}
        for (const [name, calendar] of Object.entries(mergedFounderCals)) {
          const typed = convertMergedCalendar(calendar)
          if (Object.keys(typed).length > 0) converted[name] = typed
        }
        founderCalendars = converted
      }
    }

    const team = computeVelocityBreakdown(teamCalendar)
    const perFounder: Record<string, ReturnType<typeof computeVelocityBreakdown>> = {}
    for (const [name, cal] of Object.entries(founderCalendars)) {
      perFounder[name] = computeVelocityBreakdown(cal)
    }

    return { team, perFounder }
  },
})

/**
 * Get per-founder velocity time series (one series per connected GitHub account).
 * Returns { [founderName]: { timestamp, value }[] }
 */
export const getVelocityTimeSeriesPerFounder = query({
  args: {
    startupId: v.id('startups'),
    startDate: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireStartupAccess(ctx, args.startupId)

    // Prefer typed per-founder calendars; fall back to merged per-founder
    const typedMetric = await ctx.db
      .query('metricsData')
      .withIndex('by_startupId_provider_metricKey', (q) =>
        q
          .eq('startupId', args.startupId)
          .eq('provider', 'github')
          .eq('metricKey', 'typed_contribution_calendar_by_founder')
      )
      .order('desc')
      .first()

    const typedCalendars = typedMetric?.meta as Record<string, TypedDayCounts> | undefined

    if (typedCalendars && Object.keys(typedCalendars).length > 0) {
      const result: Record<string, Array<{ timestamp: string; value: number }>> = {}
      for (const [name, cal] of Object.entries(typedCalendars)) {
        if (!cal || Object.keys(cal).length === 0) continue
        result[name] = buildTimeSeries(cal, args.startDate, true)
      }
      // Only use typed data if it actually produced results; otherwise fall through
      if (Object.keys(result).length > 0) return result
    }

    // Fallback: merged per-founder calendar
    const calendarMetric = await ctx.db
      .query('metricsData')
      .withIndex('by_startupId_provider_metricKey', (q) =>
        q
          .eq('startupId', args.startupId)
          .eq('provider', 'github')
          .eq('metricKey', 'contribution_calendar_by_founder')
      )
      .order('desc')
      .first()

    const perFounderCalendars = calendarMetric?.meta as
      | Record<string, MergedCalendarWeek[]>
      | undefined

    if (!perFounderCalendars) return {}

    const result: Record<string, Array<{ timestamp: string; value: number }>> = {}
    for (const [founderName, calendar] of Object.entries(perFounderCalendars)) {
      if (!calendar || calendar.length === 0) continue
      const typed = convertMergedCalendar(calendar)
      if (Object.keys(typed).length === 0) continue
      result[founderName] = buildTimeSeries(typed, args.startDate, false)
    }

    return result
  },
})

/**
 * Get per-founder GitHub stats.
 * Returns { [founderName]: { commits, prs, issues, restricted } }.
 * `restricted` is the residual between GitHub's coarse total contribution
 * count and the commit / PR / issue detail we could classify. Missing org
 * installs are one cause, but GitHub also keeps some activity coarse-grained
 * even when a GitHub App user token can read the private repo directly.
 * Older rows without the field normalize to 0.
 */
export const getPerFounderGithubStats = query({
  args: { startupId: v.id('startups') },
  handler: async (ctx, args) => {
    await requireStartupAccess(ctx, args.startupId)

    const metric = await ctx.db
      .query('metricsData')
      .withIndex('by_startupId_provider_metricKey', (q) =>
        q
          .eq('startupId', args.startupId)
          .eq('provider', 'github')
          .eq('metricKey', 'github_stats_by_founder')
      )
      .order('desc')
      .first()

    return normalizeGithubStatsMeta(
      metric?.meta as Record<string, Partial<FounderGithubStats>> | undefined
    )
  },
})

/**
 * Manually sync metrics for a startup (admin-only).
 * Triggers Stripe, tracker, and GitHub metric fetches.
 */
export const syncMetricsForStartup = action({
  args: { startupId: v.id('startups') },
  handler: async (ctx, args) => {
    const user = await ctx.runQuery(api.users.current)
    if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) {
      throw new Error('Admin access required')
    }

    const errors: string[] = []

    try {
      await ctx.runAction(internal.metrics.fetchStripeMetrics, {
        startupId: args.startupId,
      })
    } catch (error) {
      errors.push(`Stripe: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }

    try {
      await ctx.runAction(internal.metrics.fetchTrackerMetrics_cron, {
        startupId: args.startupId,
      })
    } catch (error) {
      errors.push(`Tracker: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }

    try {
      const githubConnections: any[] = await ctx.runQuery(
        internal.metrics.getAllGithubConnectionsForStartup,
        { startupId: args.startupId }
      )
      if (githubConnections.length > 0) {
        await ctx.runAction(internal.metrics.syncGithubForStartup, {
          startupId: args.startupId,
          connectionId: githubConnections[0]._id,
        })
      }
    } catch (error) {
      errors.push(`GitHub: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }

    if (errors.length > 0) {
      throw new Error(`Sync completed with errors: ${errors.join('; ')}`)
    }
  },
})

/**
 * Auto-paginate a Stripe list endpoint, following `has_more` cursors.
 */
async function paginateStripe<T extends { id: string }>(
  listFn: (params: {
    limit: number
    starting_after?: string
  }) => Promise<{ data: T[]; has_more: boolean }>
): Promise<T[]> {
  const all: T[] = []
  let startingAfter: string | undefined
  let hasMore = true
  while (hasMore) {
    const page = await listFn({
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
    all.push(...page.data)
    hasMore = page.has_more
    if (page.data.length > 0) startingAfter = page.data[page.data.length - 1].id
  }
  return all
}

/**
 * Fetch and store Stripe metrics for a startup (action).
 * Uses stripe-mrr lib for MRR calculation and movement detection.
 */
export const fetchStripeMetrics = internalAction({
  args: { startupId: v.id('startups') },
  handler: async (ctx, args) => {
    const connection: any = await ctx.runQuery(internal.metrics.getStripeConnection, {
      startupId: args.startupId,
    })

    if (!connection?.accessToken) return

    const Stripe = (await import('stripe')).default
    const { calculateMrrSnapshot, computeMrrMovements } = await import('./lib/stripeMrr')

    const stripe = new Stripe(connection.accessToken, {
      apiVersion: '2025-11-17.clover',
    })

    const now = new Date()
    const timestamp = now.toISOString()

    // ── MRR from subscriptions (using stripe-mrr lib) ─────────────
    const activeSubs = await paginateStripe((p) =>
      stripe.subscriptions.list({ ...p, status: 'active' })
    )
    const pastDueSubs = await paginateStripe((p) =>
      stripe.subscriptions.list({ ...p, status: 'past_due' })
    )
    const allSubs = [...activeSubs, ...pastDueSubs]
    const { totalMrrCents, activeSubscriptionCount, customerMrrMap } = calculateMrrSnapshot(allSubs)

    const mrr = totalMrrCents / 100
    const arr = mrr * 12
    const arpu = activeSubscriptionCount > 0 ? mrr / activeSubscriptionCount : 0

    // ── Revenue from paid invoices ──────────────────────────────────
    const paidInvoices = await paginateStripe((p) => stripe.invoices.list({ ...p, status: 'paid' }))
    const totalRevenue = paidInvoices.reduce((sum, inv) => sum + (inv.amount_paid ?? 0), 0) / 100

    // Active customers: unique customers from paid invoices in last 90 days
    const ninetyDaysAgo = Math.floor((now.getTime() - 90 * 24 * 60 * 60 * 1000) / 1000)
    const recentInvoices = paidInvoices.filter(
      (inv) => inv.status_transitions?.paid_at && inv.status_transitions.paid_at >= ninetyDaysAgo
    )
    const uniqueCustomers = new Set(
      recentInvoices
        .map((inv) => (typeof inv.customer === 'string' ? inv.customer : null))
        .filter((c): c is string => Boolean(c))
    ).size

    // ── Store customerMrr time-series ───────────────────────────────
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    for (const [customerId, mrrValue] of customerMrrMap) {
      await ctx.runMutation(internal.metrics.upsertCustomerMrr, {
        startupId: args.startupId,
        stripeCustomerId: customerId,
        month: currentMonth,
        mrr: mrrValue,
      })
    }

    // ── Compute MRR movements (using stripe-mrr lib) ────────────────
    const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`
    const prevCustomerMrrs: any[] = await ctx.runQuery(internal.metrics.getCustomerMrrForMonth, {
      startupId: args.startupId,
      month: prevMonth,
    })

    const prevMrrMap = new Map<string, number>()
    for (const row of prevCustomerMrrs) {
      prevMrrMap.set(row.stripeCustomerId, row.mrr)
    }

    // All-time customer IDs for reactivation detection (fixed: no longer depends on prevMrrMap.size)
    const allTimeCustomers: any[] = await ctx.runQuery(internal.metrics.getDistinctCustomerIds, {
      startupId: args.startupId,
    })
    const allTimeCustomerIds = new Set(allTimeCustomers.map((c: any) => c.stripeCustomerId))

    const movements = computeMrrMovements(customerMrrMap, prevMrrMap, allTimeCustomerIds)

    // Clear existing movements for this month before inserting (idempotent)
    await ctx.runMutation(internal.metrics.clearMrrMovementsForMonth, {
      startupId: args.startupId,
      month: currentMonth,
    })

    for (const movement of movements) {
      await ctx.runMutation(internal.metrics.insertMrrMovement, {
        startupId: args.startupId,
        month: currentMonth,
        type: movement.type,
        amount: movement.amount,
        stripeCustomerId: movement.stripeCustomerId,
      })
    }

    // ── Derived metrics ─────────────────────────────────────────────
    const trialingSubs = await paginateStripe((p) =>
      stripe.subscriptions.list({ ...p, status: 'trialing' })
    )
    const totalTrialing = trialingSubs.length
    const trialConversionRate =
      totalTrialing > 0
        ? (activeSubscriptionCount / (totalTrialing + activeSubscriptionCount)) * 100
        : -1

    const recentAllInvoices = await paginateStripe((p) =>
      stripe.invoices.list({ ...p, created: { gte: ninetyDaysAgo } })
    )
    const failedPayments = recentAllInvoices.filter(
      (inv) => inv.status === 'uncollectible' || inv.status === 'void'
    ).length
    const paymentFailureRate =
      recentAllInvoices.length > 0 ? (failedPayments / recentAllInvoices.length) * 100 : -1

    const churnAmount = movements
      .filter((m) => m.type === 'churn')
      .reduce((sum, m) => sum + m.amount, 0)
    const prevTotalMrr = Array.from(prevMrrMap.values()).reduce((sum, v) => sum + v, 0)
    const monthlyChurnRate = prevTotalMrr > 0 ? (churnAmount / prevTotalMrr) * 100 : -1
    const nrr = prevTotalMrr > 0 ? (totalMrrCents / prevTotalMrr) * 100 : -1
    const ltv = monthlyChurnRate > 0 ? arpu / (monthlyChurnRate / 100) : -1

    // ── Store all metric snapshots ──────────────────────────────────
    await ctx.runMutation(internal.metrics.storeInternal, {
      snapshots: [
        {
          startupId: args.startupId,
          provider: 'stripe',
          metricKey: 'mrr',
          value: mrr,
          timestamp,
          window: 'daily',
        },
        {
          startupId: args.startupId,
          provider: 'stripe',
          metricKey: 'arr',
          value: arr,
          timestamp,
          window: 'daily',
        },
        {
          startupId: args.startupId,
          provider: 'stripe',
          metricKey: 'total_revenue',
          value: totalRevenue,
          timestamp,
          window: 'daily',
        },
        {
          startupId: args.startupId,
          provider: 'stripe',
          metricKey: 'active_customers',
          value: uniqueCustomers,
          timestamp,
          window: 'daily',
        },
        {
          startupId: args.startupId,
          provider: 'stripe',
          metricKey: 'active_subscriptions',
          value: activeSubscriptionCount,
          timestamp,
          window: 'daily',
        },
        {
          startupId: args.startupId,
          provider: 'stripe',
          metricKey: 'arpu',
          value: arpu,
          timestamp,
          window: 'daily',
        },
        {
          startupId: args.startupId,
          provider: 'stripe',
          metricKey: 'nrr',
          value: nrr,
          timestamp,
          window: 'daily',
        },
        {
          startupId: args.startupId,
          provider: 'stripe',
          metricKey: 'ltv',
          value: ltv,
          timestamp,
          window: 'daily',
        },
        {
          startupId: args.startupId,
          provider: 'stripe',
          metricKey: 'trial_conversion_rate',
          value: trialConversionRate,
          timestamp,
          window: 'daily',
        },
        {
          startupId: args.startupId,
          provider: 'stripe',
          metricKey: 'payment_failure_rate',
          value: paymentFailureRate,
          timestamp,
          window: 'daily',
        },
        {
          startupId: args.startupId,
          provider: 'stripe',
          metricKey: 'monthly_churn_rate',
          value: monthlyChurnRate,
          timestamp,
          window: 'daily',
        },
      ],
    })

    // Update connection sync timestamp and restore active status
    await ctx.runMutation(internal.metrics.updateConnectionSyncStatus, {
      connectionId: connection._id,
      status: 'active',
      lastSyncedAt: timestamp,
    })
  },
})

/**
 * Internal query to get Stripe connection for a startup.
 */
export const getStripeConnection = internalQuery({
  args: { startupId: v.id('startups') },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('integrationConnections')
      .withIndex('by_startupId_provider', (q) =>
        q.eq('startupId', args.startupId).eq('provider', 'stripe')
      )
      .filter((q) => q.eq(q.field('isActive'), true))
      .first()
  },
})

/**
 * Internal mutation to store metrics (used by actions).
 * Upserts by day to avoid duplicates.
 */
export const storeInternal = internalMutation({
  args: {
    snapshots: v.array(
      v.object({
        startupId: v.id('startups'),
        provider: providerValidator,
        metricKey: v.string(),
        value: v.number(),
        timestamp: v.string(),
        window: v.union(v.literal('daily'), v.literal('weekly'), v.literal('monthly')),
      })
    ),
  },
  handler: async (ctx, args) => {
    for (const snapshot of args.snapshots) {
      const dayTs = snapshot.timestamp.slice(0, 10) + 'T00:00:00.000Z'

      const existing = await ctx.db
        .query('metricsData')
        .withIndex('by_startupId_provider_metricKey', (q) =>
          q
            .eq('startupId', snapshot.startupId)
            .eq('provider', snapshot.provider)
            .eq('metricKey', snapshot.metricKey)
        )
        .filter((q) => q.eq(q.field('timestamp'), dayTs))
        .first()

      if (existing) {
        await ctx.db.patch(existing._id, { value: snapshot.value })
      } else {
        await ctx.db.insert('metricsData', { ...snapshot, timestamp: dayTs })
      }
    }
  },
})

// ── Internal queries for cron jobs ──────────────────────────────────

/**
 * Get all active Stripe integration connections.
 */
export const getAllActiveStripeConnections = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query('integrationConnections')
      .filter((q) => q.and(q.eq(q.field('provider'), 'stripe'), q.eq(q.field('isActive'), true)))
      .collect()
  },
})

/**
 * Get all startups that have tracker websites.
 */
export const getStartupsWithTrackers = internalQuery({
  args: {},
  handler: async (ctx) => {
    const websites = await ctx.db.query('trackerWebsites').collect()
    const startupIds = [...new Set(websites.map((w) => w.startupId))]
    return startupIds
  },
})

/**
 * Update integration connection sync status.
 */
export const updateConnectionSyncStatus = internalMutation({
  args: {
    connectionId: v.id('integrationConnections'),
    status: v.optional(v.union(v.literal('active'), v.literal('error'), v.literal('disconnected'))),
    syncError: v.optional(v.string()),
    lastSyncedAt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Guard against reviving a detached connection: if the row was marked
    // isActive:false (e.g. because the founder who owned it was just deleted and
    // cascadeDeleteUserData detached it), a concurrent sync must not flip status
    // back to 'active'. Let lastSyncedAt through since it's informational.
    const existing = await ctx.db.get(args.connectionId)
    if (!existing) return
    const isDetached = existing.isActive === false

    const patch: Record<string, unknown> = {}
    if (args.status !== undefined && !isDetached) patch.status = args.status
    if (args.syncError !== undefined && !isDetached) patch.syncError = args.syncError
    if (args.lastSyncedAt !== undefined) patch.lastSyncedAt = args.lastSyncedAt
    // Clear syncError when status recovers to active
    if (args.status === 'active' && args.syncError === undefined && !isDetached) {
      patch.syncError = undefined
    }
    if (Object.keys(patch).length === 0) return
    await ctx.db.patch(args.connectionId, patch)
  },
})

// ── Sync all metrics (cron job) ─────────────────────────────────────

/**
 * Sync metrics from all active integrations (Stripe + Tracker + GitHub).
 * Called by cron every 12 hours. Fans out per-startup syncs as separate scheduled actions.
 */
/**
 * Sync all Stripe metrics (separate cron). Fans out per-startup.
 */
export const syncAllStripeMetrics = internalAction({
  args: {},
  handler: async (ctx) => {
    const connections = await ctx.runQuery(internal.metrics.getAllActiveStripeConnections)
    for (const connection of connections) {
      await ctx.scheduler.runAfter(0, internal.metrics.syncStripeForStartup, {
        startupId: connection.startupId,
        connectionId: connection._id,
      })
    }
  },
})

/**
 * Sync all GitHub metrics (separate cron). Fans out per-startup (deduplicated).
 */
export const syncAllGithubMetrics = internalAction({
  args: {},
  handler: async (ctx) => {
    const githubConnections = await ctx.runQuery(internal.metrics.getAllActiveGithubConnections)
    const githubStartupIds = new Set(githubConnections.map((c: any) => c.startupId))
    for (const startupId of githubStartupIds) {
      const firstConnection = githubConnections.find((c: any) => c.startupId === startupId)
      await ctx.scheduler.runAfter(0, internal.metrics.syncGithubForStartup, {
        startupId,
        connectionId: firstConnection!._id,
      })
    }
  },
})

/**
 * Sync all tracker metrics (separate cron). Fans out per-startup.
 */
export const syncAllTrackerMetrics = internalAction({
  args: {},
  handler: async (ctx) => {
    const trackerStartupIds = await ctx.runQuery(internal.metrics.getStartupsWithTrackers)
    for (const startupId of trackerStartupIds) {
      await ctx.scheduler.runAfter(0, internal.metrics.syncTrackerForStartup, {
        startupId,
      })
    }
  },
})

/**
 * Sync Stripe metrics for a single startup (fan-out target).
 */
export const syncStripeForStartup = internalAction({
  args: { startupId: v.id('startups'), connectionId: v.id('integrationConnections') },
  handler: async (ctx, args) => {
    try {
      await ctx.runAction(internal.metrics.fetchStripeMetrics, {
        startupId: args.startupId,
      })
    } catch (error) {
      logConvexError(`Error syncing Stripe for startup ${args.startupId}:`, error)
      await ctx.runMutation(internal.metrics.updateConnectionSyncStatus, {
        connectionId: args.connectionId,
        status: 'error',
        syncError: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  },
})

/**
 * Sync tracker metrics for a single startup (fan-out target).
 */
export const syncTrackerForStartup = internalAction({
  args: { startupId: v.id('startups') },
  handler: async (ctx, args) => {
    try {
      await ctx.runAction(internal.metrics.fetchTrackerMetrics_cron, {
        startupId: args.startupId,
      })
    } catch (error) {
      logConvexError(`Error syncing tracker metrics for startup ${args.startupId}:`, error)
    }
  },
})

/**
 * Sync GitHub metrics for a single startup (fan-out target).
 * Refreshes tokens before fetching if needed.
 */
export const syncGithubForStartup = internalAction({
  args: { startupId: v.id('startups'), connectionId: v.id('integrationConnections') },
  handler: async (ctx, args) => {
    let connections: any[] = []
    let partialFailureError: Error | null = null
    try {
      // Refresh tokens for all GitHub connections on this startup before fetching
      connections = await ctx.runQuery(internal.metrics.getAllGithubConnectionsForStartup, {
        startupId: args.startupId,
      })
      for (const conn of connections) {
        await ctx.runAction(internal.integrations.refreshGithubToken, {
          connectionId: conn._id,
        })
      }

      const syncResult: any = await ctx.runAction(internal.metrics.fetchGithubMetrics, {
        startupId: args.startupId,
      })

      const failedConnectionSyncErrors =
        (syncResult?.failedConnectionSyncErrors as Record<string, string> | undefined) ?? {}
      const successfulConnectionIds = new Set<string>(
        (syncResult?.successfulConnectionIds as string[] | undefined) ??
          connections.map((conn) => conn._id)
      )

      const now = new Date().toISOString()
      for (const conn of connections) {
        const syncError = failedConnectionSyncErrors[conn._id]
        if (syncError) {
          await ctx.runMutation(internal.metrics.updateConnectionSyncStatus, {
            connectionId: conn._id,
            status: 'error',
            syncError,
            lastSyncedAt: now,
          })
        } else if (successfulConnectionIds.has(conn._id)) {
          await ctx.runMutation(internal.metrics.updateConnectionSyncStatus, {
            connectionId: conn._id,
            status: 'active',
            lastSyncedAt: now,
          })
        }
      }

      const failedConnectionIds = Object.keys(failedConnectionSyncErrors)
      if (failedConnectionIds.length > 0) {
        const failedNames = failedConnectionIds.map(
          (id) => connections.find((conn) => conn._id === id)?.accountName ?? id
        )
        partialFailureError = new Error(
          `Some GitHub connections failed to sync: ${failedNames.join(', ')}`
        )
      }
    } catch (error) {
      logConvexError(`Error syncing GitHub for startup ${args.startupId}:`, error)
      const targets =
        connections.length > 0 ? connections.map((conn) => conn._id) : [args.connectionId]
      for (const connectionId of targets) {
        await ctx.runMutation(internal.metrics.updateConnectionSyncStatus, {
          connectionId,
          status: 'error',
          syncError: error instanceof Error ? error.message : 'Unknown error',
        })
      }
      throw error
    }

    if (partialFailureError) throw partialFailureError
  },
})

/**
 * Get all active GitHub integration connections.
 */
export const getAllActiveGithubConnections = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query('integrationConnections')
      .filter((q) => q.and(q.eq(q.field('provider'), 'github'), q.eq(q.field('isActive'), true)))
      .collect()
  },
})

type GitHubDateRange = {
  from: string
  to: string
}

type GitHubIssueSearchNode = {
  createdAt?: string | null
}

type GitHubCommitSearchItem = {
  commit?: {
    author?: {
      date?: string | null
    } | null
  } | null
}

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function parseDateOnly(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`)
}

function splitGitHubDateRange(range: GitHubDateRange): [GitHubDateRange, GitHubDateRange] | null {
  const start = parseDateOnly(range.from)
  const end = parseDateOnly(range.to)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) return null

  const diffDays = Math.floor((end.getTime() - start.getTime()) / 86400000)
  if (diffDays < 1) return null

  const mid = new Date(start)
  mid.setUTCDate(mid.getUTCDate() + Math.floor(diffDays / 2))

  const next = new Date(mid)
  next.setUTCDate(next.getUTCDate() + 1)
  if (next > end) return null

  return [
    { from: range.from, to: toDateOnly(mid) },
    { from: toDateOnly(next), to: range.to },
  ]
}

async function fetchGitHubGraphql<T>(
  accessToken: string,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!response.ok) {
    throw new Error(`GitHub GraphQL HTTP ${response.status}`)
  }

  const body = await response.json()
  if (body.errors?.length) {
    throw new Error(body.errors.map((e: any) => e.message).join('; '))
  }
  return body.data as T
}

async function fetchGitHubRest<T>(accessToken: string, url: URL, accept?: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })

  if (!response.ok) {
    throw new Error(`GitHub REST HTTP ${response.status}`)
  }

  return (await response.json()) as T
}

async function collectGithubIssueSearchHits(
  accessToken: string,
  login: string,
  kind: 'pr' | 'issue',
  range: GitHubDateRange
): Promise<SearchContributionHit[]> {
  const searchQuery =
    `author:${login} is:${kind} created:${range.from}..${range.to} sort:created-desc` +
    ' archived:false'

  const query = `query($query: String!, $after: String) {
    search(query: $query, type: ISSUE, first: 100, after: $after) {
      issueCount
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on PullRequest { createdAt }
        ... on Issue { createdAt }
      }
    }
  }`

  type SearchResponse = {
    search: {
      issueCount: number
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
      nodes: GitHubIssueSearchNode[]
    }
  }

  const first = await fetchGitHubGraphql<SearchResponse>(accessToken, query, {
    query: searchQuery,
    after: null,
  })

  if (first.search.issueCount > 1000) {
    const split = splitGitHubDateRange(range)
    if (!split) {
      logConvexError(
        `GitHub ${kind} search exceeded 1000 results for @${login} in ${range.from}..${range.to}; truncating to the first 1000.`,
        null
      )
    } else {
      const [left, right] = split
      const [leftHits, rightHits] = await Promise.all([
        collectGithubIssueSearchHits(accessToken, login, kind, left),
        collectGithubIssueSearchHits(accessToken, login, kind, right),
      ])
      return [...leftHits, ...rightHits]
    }
  }

  const hits: SearchContributionHit[] = []
  for (const node of first.search.nodes ?? []) {
    if (node?.createdAt) hits.push({ occurredAt: node.createdAt })
  }

  let cursor = first.search.pageInfo.endCursor
  let hasNextPage = first.search.pageInfo.hasNextPage
  while (hasNextPage) {
    const page = await fetchGitHubGraphql<SearchResponse>(accessToken, query, {
      query: searchQuery,
      after: cursor,
    })
    for (const node of page.search.nodes ?? []) {
      if (node?.createdAt) hits.push({ occurredAt: node.createdAt })
    }
    cursor = page.search.pageInfo.endCursor
    hasNextPage = page.search.pageInfo.hasNextPage
  }

  return hits
}

async function collectGithubCommitSearchHits(
  accessToken: string,
  login: string,
  range: GitHubDateRange
): Promise<SearchContributionHit[]> {
  const query = `author:${login} author-date:${range.from}..${range.to}`

  type CommitSearchResponse = {
    total_count: number
    items: GitHubCommitSearchItem[]
  }

  const firstUrl = new URL('https://api.github.com/search/commits')
  firstUrl.searchParams.set('q', query)
  firstUrl.searchParams.set('per_page', '100')
  firstUrl.searchParams.set('page', '1')

  const first = await fetchGitHubRest<CommitSearchResponse>(
    accessToken,
    firstUrl,
    'application/vnd.github.cloak-preview+json'
  )

  if (first.total_count > 1000) {
    const split = splitGitHubDateRange(range)
    if (!split) {
      logConvexError(
        `GitHub commit search exceeded 1000 results for @${login} in ${range.from}..${range.to}; truncating to the first 1000.`,
        null
      )
    } else {
      const [left, right] = split
      const [leftHits, rightHits] = await Promise.all([
        collectGithubCommitSearchHits(accessToken, login, left),
        collectGithubCommitSearchHits(accessToken, login, right),
      ])
      return [...leftHits, ...rightHits]
    }
  }

  const hits: SearchContributionHit[] = []
  for (const item of first.items ?? []) {
    if (item?.commit?.author?.date) hits.push({ occurredAt: item.commit.author.date })
  }

  const totalPages = Math.min(10, Math.ceil(Math.min(first.total_count, 1000) / 100))
  for (let page = 2; page <= totalPages; page++) {
    const url = new URL('https://api.github.com/search/commits')
    url.searchParams.set('q', query)
    url.searchParams.set('per_page', '100')
    url.searchParams.set('page', String(page))
    const response = await fetchGitHubRest<CommitSearchResponse>(
      accessToken,
      url,
      'application/vnd.github.cloak-preview+json'
    )
    for (const item of response.items ?? []) {
      if (item?.commit?.author?.date) hits.push({ occurredAt: item.commit.author.date })
    }
  }

  return hits
}

async function fetchGithubTypedCalendarFromSearch(
  accessToken: string,
  login: string,
  range: GitHubDateRange
): Promise<{
  typedCalendar: TypedDayCounts
  commits: number
  prs: number
  issues: number
}> {
  const [commitHits, prHits, issueHits] = await Promise.all([
    collectGithubCommitSearchHits(accessToken, login, range),
    collectGithubIssueSearchHits(accessToken, login, 'pr', range),
    collectGithubIssueSearchHits(accessToken, login, 'issue', range),
  ])

  const typedCalendar = buildTypedDayCountsFromSearchResults({
    commits: commitHits,
    prs: prHits,
    issues: issueHits,
  })

  return {
    typedCalendar,
    commits: commitHits.length,
    prs: prHits.length,
    issues: issueHits.length,
  }
}

/**
 * Fetch and store GitHub metrics for a startup.
 * Aggregates contributions across ALL connected founders (summed, not averaged).
 * Uses contributionsCollection for coarse totals, then search endpoints for the
 * typed commit / PR / issue detail that GitHub App user tokens can see on
 * private installed repos.
 */
export const fetchGithubMetrics = internalAction({
  args: { startupId: v.id('startups') },
  handler: async (ctx, args) => {
    // Get ALL GitHub connections for this startup (one per founder)
    const connections: any[] = await ctx.runQuery(
      internal.metrics.getAllGithubConnectionsForStartup,
      { startupId: args.startupId }
    )
    if (connections.length === 0) return

    const now = new Date()
    // Fetch 1 year of data for the contribution calendar (scoring only uses last 4 weeks)
    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)

    const range: GitHubDateRange = {
      from: toDateOnly(oneYearAgo),
      to: toDateOnly(now),
    }

    const graphqlQuery = `query($from: DateTime!, $to: DateTime!) {
      viewer {
        login
        contributionsCollection(from: $from, to: $to) {
          totalCommitContributions
          totalPullRequestContributions
          totalIssueContributions
          restrictedContributionsCount
          contributionCalendar {
            totalContributions
          }
          commitContributionsByRepository(maxRepositories: 100) {
            contributions(first: 100, orderBy: { field: OCCURRED_AT, direction: DESC }) {
              nodes { commitCount occurredAt }
            }
          }
          pullRequestContributions(first: 100, orderBy: { direction: DESC }) {
            nodes { occurredAt }
          }
          issueContributions(first: 100, orderBy: { direction: DESC }) {
            nodes { occurredAt }
          }
        }
      }
    }`

    // Aggregate across all founders + track per-founder breakdown
    let totalCommits = 0
    let totalPrsOpened = 0
    let totalIssues = 0
    let totalRestricted = 0
    let successfulFetches = 0

    const perFounderStats: Record<string, FounderGithubStats> = {}
    const perFounderTypedCalendars: Record<string, TypedDayCounts> = {}
    const mergedTypedCalendar: TypedDayCounts = {}
    const successfulConnectionIds: string[] = []
    const failedConnectionSyncErrors: Record<string, string> = {}

    for (const connection of connections) {
      if (!connection.accessToken) {
        failedConnectionSyncErrors[connection._id] = 'Missing GitHub access token'
        continue
      }

      try {
        type ContributionsSummary = {
          viewer?: {
            login?: string | null
            contributionsCollection?: {
              totalCommitContributions?: number | null
              totalPullRequestContributions?: number | null
              totalIssueContributions?: number | null
              restrictedContributionsCount?: number | null
              contributionCalendar?: {
                totalContributions?: number | null
              } | null
            } & ContributionsInput
          } | null
        }

        const data = await fetchGitHubGraphql<ContributionsSummary>(
          connection.accessToken,
          graphqlQuery,
          {
            from: oneYearAgo.toISOString(),
            to: now.toISOString(),
          }
        )

        const contrib = data.viewer?.contributionsCollection
        if (!contrib) {
          const message = `GitHub returned no contribution data for @${connection.accountName ?? connection._id}`
          logConvexError(
            `GitHub returned no contributionsCollection for startup ${args.startupId}, connection ${connection._id} (@${connection.accountName}). ` +
              `viewer login: ${data.viewer?.login ?? 'unknown'}`,
            null
          )
          failedConnectionSyncErrors[connection._id] = message
          continue
        }

        successfulFetches++
        successfulConnectionIds.push(connection._id)
        const founderName = connection.accountName ?? data.viewer?.login ?? connection._id
        const searchLogin = data.viewer?.login ?? connection.accountName
        const totalContributionCount = contrib.contributionCalendar?.totalContributions ?? 0

        let connCommits = contrib.totalCommitContributions ?? 0
        let connPrs = contrib.totalPullRequestContributions ?? 0
        let connIssues = contrib.totalIssueContributions ?? 0
        let connRestricted = contrib.restrictedContributionsCount ?? 0
        let founderTyped = buildFounderTypedCalendar(contrib)

        // GitHub App user tokens can read private repos, but
        // `viewer.contributionsCollection` still hides the typed private nodes.
        // Search endpoints do return those private commits/PRs/issues, so use
        // search as the primary source of truth and fall back to the older
        // contributionCollection detail nodes only if search fails.
        if (searchLogin) {
          try {
            const searchData = await fetchGithubTypedCalendarFromSearch(
              connection.accessToken,
              searchLogin,
              range
            )
            founderTyped = searchData.typedCalendar
            connCommits = searchData.commits
            connPrs = searchData.prs
            connIssues = searchData.issues
            connRestricted = computeUnattributedContributionCount(
              totalContributionCount,
              founderTyped
            )
          } catch (searchError) {
            logConvexError(
              `GitHub search fallback failed for startup ${args.startupId}, connection ${connection._id} (@${founderName}). Falling back to contributionsCollection detail nodes:`,
              searchError
            )
          }
        }

        // Sum across founders (not average)
        totalCommits += connCommits
        totalPrsOpened += connPrs
        totalIssues += connIssues
        totalRestricted += connRestricted

        // Track per-founder stats
        perFounderStats[founderName] = {
          commits: connCommits,
          prs: connPrs,
          issues: connIssues,
          restricted: connRestricted,
        }

        perFounderTypedCalendars[founderName] = founderTyped

        // Merge into team-level typed calendar
        for (const [date, counts] of Object.entries(founderTyped)) {
          mergedTypedCalendar[date] ??= { commits: 0, prs: 0, issues: 0 }
          mergedTypedCalendar[date].commits += counts.commits
          mergedTypedCalendar[date].prs += counts.prs
          mergedTypedCalendar[date].issues += counts.issues
        }
      } catch (error) {
        failedConnectionSyncErrors[connection._id] =
          error instanceof Error ? error.message : 'Unknown GitHub API error'
        logConvexError(
          `GitHub fetch error for startup ${args.startupId}, connection ${connection._id}:`,
          error
        )
        continue
      }
    }

    // Don't overwrite stored metrics with zeros if all API calls failed
    if (successfulFetches === 0) {
      logConvexError(
        `All GitHub API calls failed for startup ${args.startupId} (${connections.length} connections). ` +
          `Skipping metric storage to preserve existing data.`,
        null
      )
      throw new Error(`All GitHub API calls failed for startup ${args.startupId}`)
    }

    // Git Velocity scoring: unified formula with per-type weights and decay
    const velocityScore = computeVelocityScore(mergedTypedCalendar, now)
    const timestamp = now.toISOString()
    const mergedCalendarWeeks = buildContributionCalendarWeeksFromTypedDayCounts(
      mergedTypedCalendar,
      range
    )

    await ctx.runMutation(internal.metrics.storeInternal, {
      snapshots: [
        {
          startupId: args.startupId,
          provider: 'github' as const,
          metricKey: 'velocity_score',
          value: velocityScore,
          timestamp,
          window: 'daily' as const,
        },
        {
          startupId: args.startupId,
          provider: 'github' as const,
          metricKey: 'commits',
          value: totalCommits,
          timestamp,
          window: 'daily' as const,
        },
        {
          startupId: args.startupId,
          provider: 'github' as const,
          metricKey: 'prs_opened',
          value: totalPrsOpened,
          timestamp,
          window: 'daily' as const,
        },
        {
          startupId: args.startupId,
          provider: 'github' as const,
          metricKey: 'total_contributions',
          value: totalCommits + totalPrsOpened + totalIssues,
          timestamp,
          window: 'daily' as const,
        },
        {
          startupId: args.startupId,
          provider: 'github' as const,
          metricKey: 'restricted_contributions',
          value: totalRestricted,
          timestamp,
          window: 'daily' as const,
        },
      ],
    })

    // Store merged calendar data
    await ctx.runMutation(internal.metrics.storeInternalWithMeta, {
      startupId: args.startupId,
      provider: 'github' as const,
      metricKey: 'contribution_calendar',
      value: 0,
      timestamp,
      window: 'daily' as const,
      meta: mergedCalendarWeeks,
    })

    // Store per-founder breakdown for multi-founder analytics
    if (Object.keys(perFounderStats).length > 0) {
      const perFounderCalendarWeeks = Object.fromEntries(
        Object.entries(perFounderTypedCalendars).map(([name, typed]) => [
          name,
          buildContributionCalendarWeeksFromTypedDayCounts(typed, range),
        ])
      )

      await ctx.runMutation(internal.metrics.storeInternalWithMeta, {
        startupId: args.startupId,
        provider: 'github' as const,
        metricKey: 'contribution_calendar_by_founder',
        value: 0,
        timestamp,
        window: 'daily' as const,
        meta: perFounderCalendarWeeks,
      })

      await ctx.runMutation(internal.metrics.storeInternalWithMeta, {
        startupId: args.startupId,
        provider: 'github' as const,
        metricKey: 'github_stats_by_founder',
        value: 0,
        timestamp,
        window: 'daily' as const,
        meta: perFounderStats,
      })
    }

    // Store typed per-day calendars for the unified velocity formula
    await ctx.runMutation(internal.metrics.storeInternalWithMeta, {
      startupId: args.startupId,
      provider: 'github' as const,
      metricKey: 'typed_contribution_calendar',
      value: 0,
      timestamp,
      window: 'daily' as const,
      meta: mergedTypedCalendar,
    })

    if (Object.keys(perFounderTypedCalendars).length > 0) {
      await ctx.runMutation(internal.metrics.storeInternalWithMeta, {
        startupId: args.startupId,
        provider: 'github' as const,
        metricKey: 'typed_contribution_calendar_by_founder',
        value: 0,
        timestamp,
        window: 'daily' as const,
        meta: perFounderTypedCalendars,
      })
    }

    return { successfulConnectionIds, failedConnectionSyncErrors }
  },
})

/**
 * Get a single GitHub connection for a startup (legacy, used by integrations page).
 */
export const getGithubConnection = internalQuery({
  args: { startupId: v.id('startups') },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('integrationConnections')
      .withIndex('by_startupId_provider', (q) =>
        q.eq('startupId', args.startupId).eq('provider', 'github')
      )
      .filter((q) => q.eq(q.field('isActive'), true))
      .first()
  },
})

/**
 * Get ALL active GitHub connections for a startup (one per connected founder).
 * Used by fetchGithubMetrics to aggregate contributions across the team.
 */
export const getAllGithubConnectionsForStartup = internalQuery({
  args: { startupId: v.id('startups') },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('integrationConnections')
      .withIndex('by_startupId_provider', (q) =>
        q.eq('startupId', args.startupId).eq('provider', 'github')
      )
      .filter((q) => q.eq(q.field('isActive'), true))
      .collect()
  },
})

/**
 * Store a single metric with meta (used for contribution calendar data).
 */
export const storeInternalWithMeta = internalMutation({
  args: {
    startupId: v.id('startups'),
    provider: providerValidator,
    metricKey: v.string(),
    value: v.number(),
    timestamp: v.string(),
    window: v.union(v.literal('daily'), v.literal('weekly'), v.literal('monthly')),
    meta: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const dayTs = args.timestamp.slice(0, 10) + 'T00:00:00.000Z'

    const existing = await ctx.db
      .query('metricsData')
      .withIndex('by_startupId_provider_metricKey', (q) =>
        q
          .eq('startupId', args.startupId)
          .eq('provider', args.provider)
          .eq('metricKey', args.metricKey)
      )
      .filter((q) => q.eq(q.field('timestamp'), dayTs))
      .first()

    if (existing) {
      await ctx.db.patch(existing._id, { value: args.value, meta: args.meta })
    } else {
      await ctx.db.insert('metricsData', { ...args, timestamp: dayTs })
    }
  },
})

/**
 * Fetch and store tracker metrics for a startup (used by cron).
 * Aggregates tracker events into metric snapshots.
 */
export const fetchTrackerMetrics_cron = internalAction({
  args: { startupId: v.id('startups') },
  handler: async (ctx, args) => {
    // Get tracker websites for this startup
    const websites: any[] = await ctx.runQuery(internal.metrics.getTrackerWebsitesForStartup, {
      startupId: args.startupId,
    })

    if (websites.length === 0) return

    const websiteIds = websites.map((w: any) => w._id)

    const window = trackerRollupWindow()

    // Aggregate inside the query so the wire payload is bounded by days, not
    // events. Returning raw events would hit Convex's 8192 array-length cap
    // for high-traffic startups.
    const dailyMetrics = await ctx.runQuery(internal.metrics.getTrackerDailyMetricsForWebsites, {
      websiteIds,
      startMs: window.startMs,
      endMs: window.endMs,
    })

    // The helper zero-fills the full window so a day with no events overwrites
    // stale prior metrics instead of leaving an old leaderboard value behind.
    const snapshots: Array<{
      startupId: typeof args.startupId
      provider: 'tracker'
      metricKey: string
      value: number
      timestamp: string
      window: 'daily'
    }> = dailyMetrics.map((metric) => ({
      startupId: args.startupId,
      provider: 'tracker',
      metricKey: metric.metricKey,
      value: metric.value,
      timestamp: metric.timestamp,
      window: 'daily',
    }))

    if (snapshots.length > 0) {
      await ctx.runMutation(internal.metrics.storeInternal, { snapshots })
    }
  },
})

/**
 * Get tracker websites for a startup (internal).
 */
export const getTrackerWebsitesForStartup = internalQuery({
  args: { startupId: v.id('startups') },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('trackerWebsites')
      .withIndex('by_startupId', (q) => q.eq('startupId', args.startupId))
      .collect()
  },
})

/**
 * Aggregate tracker events into daily metrics for the given websites and time
 * window. Aggregation happens inside the query so the wire payload is bounded
 * by `(days * metric keys)` (~90 rows) instead of raw event count — Convex
 * caps query return arrays at 8192. The `_creationTime` range on the index
 * also bounds the DB read to events in the window so total-history rowcount
 * cannot trigger Convex's per-query read limits.
 */
export const getTrackerDailyMetricsForWebsites = internalQuery({
  args: {
    websiteIds: v.array(v.id('trackerWebsites')),
    startMs: v.number(),
    endMs: v.number(),
  },
  handler: async (ctx, args) => {
    const events: Array<{
      _creationTime: number
      eventName?: string
      sessionId?: string
    }> = []

    for (const websiteId of args.websiteIds) {
      const rows = await ctx.db
        .query('trackerEvents')
        .withIndex('by_websiteId', (q) =>
          q.eq('websiteId', websiteId).gte('_creationTime', args.startMs)
        )
        .collect()

      for (const row of rows) {
        if (row._creationTime < args.endMs) {
          events.push({
            _creationTime: row._creationTime,
            eventName: row.eventName,
            sessionId: row.sessionId,
          })
        }
      }
    }

    return buildTrackerDailyMetrics(events, {
      startMs: args.startMs,
      endMs: args.endMs,
    })
  },
})

// ── Customer MRR helpers ─────────────────────────────────────────────

/**
 * Upsert a customer's MRR for a given month.
 */
export const upsertCustomerMrr = internalMutation({
  args: {
    startupId: v.id('startups'),
    stripeCustomerId: v.string(),
    month: v.string(),
    mrr: v.number(),
    currencyOriginal: v.optional(v.string()),
    mrrOriginal: v.optional(v.number()),
    exchangeRate: v.optional(v.number()),
    subscriptionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('customerMrr')
      .withIndex('by_startupId_customerId_month', (q) =>
        q
          .eq('startupId', args.startupId)
          .eq('stripeCustomerId', args.stripeCustomerId)
          .eq('month', args.month)
      )
      .first()

    if (existing) {
      await ctx.db.patch(existing._id, {
        mrr: args.mrr,
        currencyOriginal: args.currencyOriginal,
        mrrOriginal: args.mrrOriginal,
        exchangeRate: args.exchangeRate,
        subscriptionId: args.subscriptionId,
      })
    } else {
      await ctx.db.insert('customerMrr', {
        startupId: args.startupId,
        stripeCustomerId: args.stripeCustomerId,
        month: args.month,
        mrr: args.mrr,
        currencyOriginal: args.currencyOriginal,
        mrrOriginal: args.mrrOriginal,
        exchangeRate: args.exchangeRate,
        subscriptionId: args.subscriptionId,
      })
    }
  },
})

/**
 * Get customer MRR rows for a specific month.
 */
export const getCustomerMrrForMonth = internalQuery({
  args: {
    startupId: v.id('startups'),
    month: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('customerMrr')
      .withIndex('by_startupId_month', (q) =>
        q.eq('startupId', args.startupId).eq('month', args.month)
      )
      .collect()
  },
})

/**
 * Get distinct customer IDs that have ever had MRR for a startup.
 */
export const getDistinctCustomerIds = internalQuery({
  args: { startupId: v.id('startups') },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('customerMrr')
      .withIndex('by_startupId', (q) => q.eq('startupId', args.startupId))
      .collect()
    const seen = new Set<string>()
    return rows.filter((r) => {
      if (seen.has(r.stripeCustomerId)) return false
      seen.add(r.stripeCustomerId)
      return true
    })
  },
})

/**
 * Insert an MRR movement record.
 */
/**
 * Clear MRR movements for a month (idempotent re-computation).
 */
export const clearMrrMovementsForMonth = internalMutation({
  args: {
    startupId: v.id('startups'),
    month: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('mrrMovements')
      .withIndex('by_startupId_month', (q) =>
        q.eq('startupId', args.startupId).eq('month', args.month)
      )
      .collect()
    for (const row of existing) {
      await ctx.db.delete(row._id)
    }
  },
})

export const insertMrrMovement = internalMutation({
  args: {
    startupId: v.id('startups'),
    month: v.string(),
    type: v.union(
      v.literal('new'),
      v.literal('expansion'),
      v.literal('contraction'),
      v.literal('churn'),
      v.literal('reactivation')
    ),
    amount: v.number(),
    stripeCustomerId: v.string(),
    subscriptionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('mrrMovements', {
      startupId: args.startupId,
      month: args.month,
      type: args.type,
      amount: args.amount,
      stripeCustomerId: args.stripeCustomerId,
      subscriptionId: args.subscriptionId,
    })
  },
})

/**
 * Get MRR movements for a startup and month (used by waterfall chart).
 */
export const getMrrMovements = query({
  args: {
    startupId: v.id('startups'),
    month: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireStartupAccess(ctx, args.startupId)

    const q = ctx.db
      .query('mrrMovements')
      .withIndex('by_startupId', (qb) => qb.eq('startupId', args.startupId))

    const rows = await q.collect()

    if (args.month) {
      return rows.filter((r) => r.month === args.month)
    }
    return rows
  },
})

/**
 * Check if a Stripe webhook event has been processed (idempotency).
 */
export const getWebhookEvent = internalQuery({
  args: { stripeEventId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('stripeWebhookEvents')
      .withIndex('by_stripeEventId', (q) => q.eq('stripeEventId', args.stripeEventId))
      .first()
  },
})

/**
 * Record a processed Stripe webhook event.
 */
export const insertWebhookEvent = internalMutation({
  args: {
    stripeEventId: v.string(),
    type: v.string(),
    payload: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('stripeWebhookEvents', {
      stripeEventId: args.stripeEventId,
      type: args.type,
      processedAt: new Date().toISOString(),
      payload: args.payload,
    })
  },
})

/**
 * Find the integration connection for a Stripe account ID (used by webhooks).
 */
export const getConnectionByStripeAccountId = internalQuery({
  args: { accountId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('integrationConnections')
      .filter((q) =>
        q.and(
          q.eq(q.field('provider'), 'stripe'),
          q.eq(q.field('accountId'), args.accountId),
          q.eq(q.field('isActive'), true)
        )
      )
      .first()
  },
})

/**
 * Backfill Stripe historical data when a founder first connects.
 * Reconstructs customerMrr time-series from invoice line items.
 */
export const backfillStripeHistory = internalAction({
  args: { startupId: v.id('startups') },
  handler: async (ctx, args) => {
    const connection: any = await ctx.runQuery(internal.metrics.getStripeConnection, {
      startupId: args.startupId,
    })
    if (!connection?.accessToken) return

    const Stripe = (await import('stripe')).default
    const stripe = new Stripe(connection.accessToken, {
      apiVersion: '2025-11-17.clover',
    })

    // Get all paid invoices and reconstruct monthly MRR per customer
    const allInvoices = await paginateStripe((p) => stripe.invoices.list({ ...p, status: 'paid' }))

    // Group by customer + month, sum recurring line items (exclude prorations)
    const monthlyMrr = new Map<string, Map<string, number>>() // customerId -> month -> mrr

    for (const invoice of allInvoices) {
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : null
      if (!customerId) continue

      const paidAt = invoice.status_transitions?.paid_at
      if (!paidAt) continue

      const date = new Date(paidAt * 1000)
      const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`

      if (!monthlyMrr.has(customerId)) monthlyMrr.set(customerId, new Map())
      const customerMap = monthlyMrr.get(customerId)!

      for (const rawLine of invoice.lines?.data ?? []) {
        // Cast to any — Stripe API shape varies across versions
        const line = rawLine as any
        // Skip prorations
        if (line.proration) continue
        // Only recurring items
        if (!line.price?.recurring) continue
        if (!line.price.unit_amount || line.price.unit_amount === 0) continue

        const lineMrr = normalizeToMonthlyCents(
          line.price.unit_amount * (line.quantity ?? 1),
          line.price.recurring.interval,
          line.price.recurring.interval_count ?? 1
        )

        customerMap.set(month, (customerMap.get(month) ?? 0) + lineMrr)
      }
    }

    // Store all historical customerMrr
    for (const [customerId, months] of monthlyMrr) {
      for (const [month, mrr] of months) {
        await ctx.runMutation(internal.metrics.upsertCustomerMrr, {
          startupId: args.startupId,
          stripeCustomerId: customerId,
          month,
          mrr,
        })
      }
    }

    // Compute MRR movements by diffing consecutive months
    const allMonths = new Set<string>()
    for (const months of monthlyMrr.values()) {
      for (const month of months.keys()) allMonths.add(month)
    }
    const sortedMonths = Array.from(allMonths).sort()

    const allCustomerIds = Array.from(monthlyMrr.keys())
    const seenCustomers = new Set<string>()

    for (let i = 0; i < sortedMonths.length; i++) {
      const month = sortedMonths[i]
      const prevMonth = i > 0 ? sortedMonths[i - 1] : null

      // Clear existing movements for idempotent re-backfill
      await ctx.runMutation(internal.metrics.clearMrrMovementsForMonth, {
        startupId: args.startupId,
        month,
      })

      for (const customerId of allCustomerIds) {
        const currentMrr = monthlyMrr.get(customerId)?.get(month) ?? 0
        const previousMrr = prevMonth ? (monthlyMrr.get(customerId)?.get(prevMonth) ?? 0) : 0

        if (currentMrr > 0 && previousMrr === 0) {
          const type = seenCustomers.has(customerId) ? 'reactivation' : 'new'
          seenCustomers.add(customerId)
          await ctx.runMutation(internal.metrics.insertMrrMovement, {
            startupId: args.startupId,
            month,
            type,
            amount: currentMrr,
            stripeCustomerId: customerId,
          })
        } else if (currentMrr === 0 && previousMrr > 0) {
          await ctx.runMutation(internal.metrics.insertMrrMovement, {
            startupId: args.startupId,
            month,
            type: 'churn',
            amount: previousMrr,
            stripeCustomerId: customerId,
          })
        } else if (currentMrr > previousMrr) {
          seenCustomers.add(customerId)
          await ctx.runMutation(internal.metrics.insertMrrMovement, {
            startupId: args.startupId,
            month,
            type: 'expansion',
            amount: currentMrr - previousMrr,
            stripeCustomerId: customerId,
          })
        } else if (currentMrr < previousMrr && currentMrr > 0) {
          seenCustomers.add(customerId)
          await ctx.runMutation(internal.metrics.insertMrrMovement, {
            startupId: args.startupId,
            month,
            type: 'contraction',
            amount: previousMrr - currentMrr,
            stripeCustomerId: customerId,
          })
        } else if (currentMrr > 0) {
          seenCustomers.add(customerId)
        }
      }
    }
  },
})

// ── One-time cleanup ─────────────────────────────────────────────────

/**
 * Get all metricsData rows (internal, for cleanup).
 */
export const getAllMetricsData = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query('metricsData').collect()
  },
})

/**
 * Delete specific metricsData rows by ID (internal, for cleanup).
 */
export const deleteMetricsRows = internalMutation({
  args: { ids: v.array(v.id('metricsData')) },
  handler: async (ctx, args) => {
    for (const id of args.ids) {
      await ctx.db.delete(id)
    }
  },
})

/**
 * One-time cleanup: remove duplicate metric snapshots.
 * Groups by (startupId, provider, metricKey, day), keeps latest per group.
 * Run from the Convex dashboard after deploy.
 */
export const cleanupDuplicateSnapshots = internalAction({
  args: {},
  handler: async (ctx) => {
    const allRows: any[] = await ctx.runQuery(internal.metrics.getAllMetricsData)

    // Group by (startupId, provider, metricKey, day)
    const groups = new Map<string, Array<{ _id: any; timestamp: string }>>()
    for (const row of allRows) {
      const day = row.timestamp.slice(0, 10)
      const key = `${row.startupId}|${row.provider}|${row.metricKey}|${day}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push({ _id: row._id, timestamp: row.timestamp })
    }

    // Find IDs to delete (all but latest per group)
    const toDelete: any[] = []
    for (const rows of groups.values()) {
      if (rows.length <= 1) continue
      rows.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      // Keep first (latest), delete rest
      for (let i = 1; i < rows.length; i++) {
        toDelete.push(rows[i]._id)
      }
    }

    if (toDelete.length === 0) return

    // Delete in batches (Convex mutations have limits)
    const batchSize = 500
    for (let i = 0; i < toDelete.length; i += batchSize) {
      const batch = toDelete.slice(i, i + batchSize)
      await ctx.runMutation(internal.metrics.deleteMetricsRows, { ids: batch })
    }
  },
})

/**
 * DIAGNOSTIC — remove before shipping.
 * Simulates what integrations:fullStatus would return for a given clerkId
 * WITHOUT relying on ctx.auth.getUserIdentity (so we can run it from CLI).
 * Returns the exact shape the founder-integrations page consumes.
 */
export const simulateFullStatusForClerkDiag = internalQuery({
  args: { clerkId: v.string() },
  handler: async (ctx, args) => {
    const users = await ctx.db
      .query('users')
      .withIndex('by_clerkId', (q) => q.eq('clerkId', args.clerkId))
      .collect()
    if (users.length === 0) return { error: 'no user row for clerkId' }
    if (users.length > 1) return { error: 'duplicate user rows for clerkId', count: users.length }
    const user = users[0]

    const profiles = await ctx.db
      .query('founderProfiles')
      .withIndex('by_userId', (q) => q.eq('userId', user._id))
      .collect()
    if (profiles.length === 0) return { error: 'no founderProfile', user: { _id: user._id } }

    const startupId = profiles[0].startupId
    const connections = await ctx.db
      .query('integrationConnections')
      .withIndex('by_startupId', (q) => q.eq('startupId', startupId))
      .collect()
    const githubConns = connections.filter((c) => c.provider === 'github' && c.isActive)
    const myGithub = githubConns.find((c) => c.connectedByUserId === user._id) ?? null

    const annotated = githubConns.map((c) => ({
      _id: c._id,
      accountName: c.accountName,
      connectedByUserId: c.connectedByUserId ?? null,
      isMine_underCurrentLogic: myGithub ? c._id === myGithub._id : false,
      connectedByEqualsMyUserId: c.connectedByUserId === user._id,
    }))

    return {
      currentUser: { _id: user._id, clerkId: args.clerkId, role: user.role },
      startupId,
      myGithubFound: Boolean(myGithub),
      myGithubId: myGithub?._id ?? null,
      githubConnectionsCount: githubConns.length,
      connections: annotated,
    }
  },
})

/**
 * DIAGNOSTIC — remove before shipping.
 * Pass your Clerk user id (find it in the Clerk dashboard, or log it out of
 * the UI) to see all GitHub connections and whether each one's
 * `connectedByUserId` resolves to your user row.
 */
export const lookupUserByClerkId = internalQuery({
  args: { clerkId: v.string() },
  handler: async (ctx, args) => {
    const users = await ctx.db
      .query('users')
      .withIndex('by_clerkId', (q) => q.eq('clerkId', args.clerkId))
      .collect()
    return users.map((u: any) => ({
      _id: u._id,
      clerkId: u.clerkId,
      email: u.email,
      fullName: u.fullName,
      role: u.role,
    }))
  },
})

export const peekGithubStatsByStartupDiag = internalQuery({
  args: { startupId: v.id('startups') },
  handler: async (ctx, args) => {
    const statsByFounder = await ctx.db
      .query('metricsData')
      .withIndex('by_startupId_provider_metricKey', (q) =>
        q
          .eq('startupId', args.startupId)
          .eq('provider', 'github')
          .eq('metricKey', 'github_stats_by_founder')
      )
      .order('desc')
      .first()
    const restricted = await ctx.db
      .query('metricsData')
      .withIndex('by_startupId_provider_metricKey', (q) =>
        q
          .eq('startupId', args.startupId)
          .eq('provider', 'github')
          .eq('metricKey', 'restricted_contributions')
      )
      .order('desc')
      .first()
    const typedCal = await ctx.db
      .query('metricsData')
      .withIndex('by_startupId_provider_metricKey', (q) =>
        q
          .eq('startupId', args.startupId)
          .eq('provider', 'github')
          .eq('metricKey', 'typed_contribution_calendar')
      )
      .order('desc')
      .first()
    const typedCalByFounder = await ctx.db
      .query('metricsData')
      .withIndex('by_startupId_provider_metricKey', (q) =>
        q
          .eq('startupId', args.startupId)
          .eq('provider', 'github')
          .eq('metricKey', 'typed_contribution_calendar_by_founder')
      )
      .order('desc')
      .first()
    const typedMeta = (typedCal?.meta as Record<string, unknown>) ?? {}
    const perFounderTyped =
      (typedCalByFounder?.meta as Record<string, Record<string, unknown>>) ?? {}
    return {
      statsByFounderMeta: statsByFounder?.meta ?? null,
      restrictedValue: restricted?.value ?? null,
      typedCalendarDayCount: Object.keys(typedMeta).length,
      typedCalendarFirstFive: Object.entries(typedMeta).slice(-5),
      perFounderTypedKeys: Object.keys(perFounderTyped),
      perFounderTypedDayCounts: Object.fromEntries(
        Object.entries(perFounderTyped).map(([name, cal]) => [name, Object.keys(cal).length])
      ),
    }
  },
})

export const lookupUserById = internalQuery({
  args: { userId: v.id('users') },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId)
    if (!user) return null
    return {
      _id: user._id,
      clerkId: user.clerkId,
      email: (user as any).email,
      fullName: (user as any).fullName,
      role: (user as any).role,
    }
  },
})

export const whoOwnsGithubConnectionsDiag = internalQuery({
  args: { clerkId: v.string() },
  handler: async (ctx, args) => {
    const users = await ctx.db
      .query('users')
      .withIndex('by_clerkId', (q) => q.eq('clerkId', args.clerkId))
      .collect()

    const myUserId = users[0]?._id

    const githubConns = await ctx.db
      .query('integrationConnections')
      .filter((q) => q.and(q.eq(q.field('provider'), 'github'), q.eq(q.field('isActive'), true)))
      .collect()

    const annotated = await Promise.all(
      githubConns.map(async (c) => {
        const connUser = c.connectedByUserId ? await ctx.db.get(c.connectedByUserId) : null
        return {
          _id: c._id,
          accountName: c.accountName,
          startupId: c.startupId,
          connectedByUserId: c.connectedByUserId,
          connectedUserClerkId: connUser?.clerkId ?? null,
          connectedUserFullName: (connUser as any)?.fullName ?? null,
          isMineByUserId: c.connectedByUserId === myUserId,
          isMineByClerkId: connUser?.clerkId === args.clerkId,
        }
      })
    )

    return {
      currentUser: { _id: myUserId, clerkId: args.clerkId },
      usersMatchingClerkId: users.map((u) => ({ _id: u._id, fullName: (u as any).fullName })),
      connections: annotated,
    }
  },
})

/**
 * DIAGNOSTIC — remove before shipping.
 * Lists all active GitHub connections so you can find a connectionId to pass
 * to debugGithubContributions.
 */
export const listGithubConnectionsDiag = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query('integrationConnections')
      .filter((q) => q.and(q.eq(q.field('provider'), 'github'), q.eq(q.field('isActive'), true)))
      .collect()
    const annotated = await Promise.all(
      rows.map(async (r) => {
        const connUser = r.connectedByUserId ? await ctx.db.get(r.connectedByUserId) : null
        const startup = await ctx.db.get(r.startupId)
        return {
          _id: r._id,
          accountName: r.accountName,
          startupId: r.startupId,
          startupName: (startup as any)?.name ?? null,
          status: r.status,
          connectedByUserId: r.connectedByUserId ?? null,
          connectedUserExists: r.connectedByUserId ? connUser !== null : null,
          connectedUserClerkId: connUser?.clerkId ?? null,
          connectedUserName: (connUser as any)?.fullName ?? null,
          connectedUserRole: (connUser as any)?.role ?? null,
          hasAccessToken: Boolean(r.accessToken),
        }
      })
    )
    return annotated
  },
})

/**
 * DIAGNOSTIC — remove before shipping.
 * Dumps the raw GitHub GraphQL response for one connection so we can see
 * exactly what the API returns vs what we store.
 *
 * Run from Convex dashboard:
 *   1. runQuery: metrics:listGithubConnectionsDiag  → copy the _id
 *   2. runAction: metrics:debugGithubContributions  { connectionId: "<id>" }
 *      (or pass accountName to auto-find)
 */
export const debugGithubContributions = internalAction({
  args: {
    connectionId: v.optional(v.id('integrationConnections')),
    accountName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let connection: any = null
    if (args.connectionId) {
      connection = await ctx.runQuery(internal.integrations.getConnectionById, {
        connectionId: args.connectionId,
      })
    } else if (args.accountName) {
      const rows = (await ctx.runQuery(internal.metrics.listGithubConnectionsDiag, {})) as Array<{
        _id: any
        accountName?: string
      }>
      const match = rows.find((r) => r.accountName === args.accountName)
      if (match) {
        connection = await ctx.runQuery(internal.integrations.getConnectionById, {
          connectionId: match._id,
        })
      }
    }
    if (!connection) return { error: 'Connection not found' }
    if (!connection.accessToken) return { error: 'No access token' }

    const now = new Date()
    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)
    const fourWeeksAgo = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10)

    const query = `query($from: DateTime!, $to: DateTime!) {
      viewer {
        login
        contributionsCollection(from: $from, to: $to) {
          totalCommitContributions
          totalPullRequestContributions
          totalIssueContributions
          totalPullRequestReviewContributions
          restrictedContributionsCount
          hasAnyRestrictedContributions
          contributionCalendar { totalContributions }
          commitContributionsByRepository(maxRepositories: 100) {
            repository { nameWithOwner isPrivate }
            contributions(first: 5, orderBy: { field: OCCURRED_AT, direction: DESC }) {
              totalCount
              nodes { commitCount occurredAt }
            }
          }
          pullRequestContributions(first: 100, orderBy: { direction: DESC }) {
            totalCount
            nodes {
              occurredAt
              pullRequest { number title repository { nameWithOwner isPrivate } }
            }
          }
          issueContributions(first: 100, orderBy: { direction: DESC }) {
            totalCount
            nodes {
              occurredAt
              issue { number title repository { nameWithOwner isPrivate } }
            }
          }
        }
      }
    }`

    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${connection.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: { from: oneYearAgo.toISOString(), to: now.toISOString() },
      }),
    })

    const status = response.status
    const body: any = await response.json()
    const contrib = body?.data?.viewer?.contributionsCollection

    // Compute how many nodes fall in the last 28 days (the bar-chart window)
    const prNodes = (contrib?.pullRequestContributions?.nodes ?? []).filter((n: any) => n != null)
    const prNullCount = (contrib?.pullRequestContributions?.nodes ?? []).filter(
      (n: any) => n == null
    ).length
    const issueNodes = (contrib?.issueContributions?.nodes ?? []).filter((n: any) => n != null)
    const issueNullCount = (contrib?.issueContributions?.nodes ?? []).filter(
      (n: any) => n == null
    ).length

    const prNodesLast28 = prNodes.filter(
      (n: any) => typeof n?.occurredAt === 'string' && n.occurredAt.slice(0, 10) >= fourWeeksAgo
    )
    const issueNodesLast28 = issueNodes.filter(
      (n: any) => typeof n?.occurredAt === 'string' && n.occurredAt.slice(0, 10) >= fourWeeksAgo
    )

    const repoList = (contrib?.commitContributionsByRepository ?? []).map((r: any) => ({
      name: r?.repository?.nameWithOwner ?? null,
      isPrivate: r?.repository?.isPrivate ?? null,
      nodeCount: r?.contributions?.nodes?.length ?? 0,
      totalCount: r?.contributions?.totalCount ?? 0,
    }))

    const summary = {
      httpStatus: status,
      graphqlErrors: body?.errors ?? null,
      account: connection.accountName,
      viewerLogin: body?.data?.viewer?.login,
      totals: {
        totalCommitContributions: contrib?.totalCommitContributions ?? null,
        totalPullRequestContributions: contrib?.totalPullRequestContributions ?? null,
        totalIssueContributions: contrib?.totalIssueContributions ?? null,
        totalPullRequestReviewContributions: contrib?.totalPullRequestReviewContributions ?? null,
        restrictedContributionsCount: contrib?.restrictedContributionsCount ?? null,
        hasAnyRestrictedContributions: contrib?.hasAnyRestrictedContributions ?? null,
        calendarTotal: contrib?.contributionCalendar?.totalContributions ?? null,
      },
      prContributions: {
        totalCount: contrib?.pullRequestContributions?.totalCount ?? null,
        nodesReturned: prNodes.length,
        nodesNull: prNullCount,
        nodesLast28Days: prNodesLast28.length,
        firstThreeSample: prNodes.slice(0, 3),
      },
      issueContributions: {
        totalCount: contrib?.issueContributions?.totalCount ?? null,
        nodesReturned: issueNodes.length,
        nodesNull: issueNullCount,
        nodesLast28Days: issueNodesLast28.length,
        firstThreeSample: issueNodes.slice(0, 3),
      },
      commitReposReturned: repoList.length,
      commitReposSample: repoList.slice(0, 10),
    }

    console.log('=== GITHUB DIAGNOSTIC ===')
    console.log(JSON.stringify(summary, null, 2))
    console.log('=== END DIAGNOSTIC ===')

    return summary
  },
})
