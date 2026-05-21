import { internal } from './_generated/api'
import { query, mutation, type MutationCtx, type QueryCtx } from './functions'
import type { Doc, Id } from './_generated/dataModel'
import { ConvexError, v } from 'convex/values'
import {
  getFounderStartupIds,
  requireAdminForCohort,
  requireAdminForStartup,
  requireFounder,
  requireSuperAdmin,
} from './auth'
import {
  canDeductFromBaseline,
  computeInvoiceFundingTotals,
  computeStartupFunding,
  computeTopUpPool,
  sumAdjustments,
  type StartupFundingSummary,
} from './lib/fundingMath'

type DbCtx = QueryCtx | MutationCtx

type FundingSeriesPoint = {
  date: string
  entitled: number
  unlocked: number
  deployed: number
  available: number
}

type StartupFundingSeries = {
  startupId: Id<'startups'>
  startupName: string
  points: FundingSeriesPoint[]
}

type AdjustmentWithAdmin = Doc<'fundingAdjustments'> & {
  adminName: string
  adminEmail: string | null
  adminImageUrl: string | null
}

function assertPositiveAmount(amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ConvexError('Amount must be greater than zero')
  }
}

function assertNote(note: string) {
  if (note.trim().length === 0) {
    throw new ConvexError('Founder-visible note is required')
  }
}

function parseIsoTime(value?: string) {
  if (!value) return undefined
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function dayKey(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function startOfDay(timestamp: number) {
  const date = new Date(timestamp)
  date.setUTCHours(0, 0, 0, 0)
  return date.getTime()
}

function todayEnd() {
  const date = new Date()
  date.setUTCHours(23, 59, 59, 999)
  return date.getTime()
}

async function getStartupAdjustments(ctx: DbCtx, startupId: Id<'startups'>) {
  return await ctx.db
    .query('fundingAdjustments')
    .withIndex('by_startupId', (q) => q.eq('startupId', startupId))
    .collect()
}

async function getCohortAdjustments(ctx: DbCtx, cohortId: Id<'cohorts'>) {
  return await ctx.db
    .query('fundingAdjustments')
    .withIndex('by_cohortId', (q) => q.eq('cohortId', cohortId))
    .collect()
}

async function enrichAdjustments(
  ctx: DbCtx,
  adjustments: Doc<'fundingAdjustments'>[]
): Promise<AdjustmentWithAdmin[]> {
  const enriched = await Promise.all(
    adjustments.map(async (adjustment) => {
      const admin = await ctx.db.get(adjustment.createdByUserId)
      return {
        ...adjustment,
        adminName: admin?.fullName ?? admin?.email ?? 'Unknown admin',
        adminEmail: admin?.email ?? null,
        adminImageUrl: admin?.imageUrl ?? null,
      }
    })
  )
  return enriched.sort((a, b) => b.createdAt - a.createdAt)
}

async function computeStartupSummary(
  ctx: DbCtx,
  startup: Doc<'startups'>,
  cohort: Doc<'cohorts'>,
  adjustments: Doc<'fundingAdjustments'>[]
) {
  const milestones = await ctx.db
    .query('milestones')
    .withIndex('by_startupId', (q) => q.eq('startupId', startup._id))
    .collect()

  const invoices = await ctx.db
    .query('invoices')
    .withIndex('by_startupId', (q) => q.eq('startupId', startup._id))
    .collect()

  const { topUps, deductions } = sumAdjustments(adjustments)
  const invoiceTotals = computeInvoiceFundingTotals(invoices)
  const approvedMilestones = milestones
    .filter((milestone) => milestone.status === 'approved')
    .reduce((sum, milestone) => sum + milestone.amount, 0)
  const potential = milestones.reduce((sum, milestone) => sum + milestone.amount, 0)

  const funding = computeStartupFunding({
    baseline: cohort.baseFunding ?? 0,
    approvedMilestones,
    topUps,
    deductions,
    committedInvoices: invoiceTotals.committed,
    deployedInvoices: invoiceTotals.deployed,
  })

  return {
    ...funding,
    potential,
    hasMilestones: milestones.length > 0,
    milestoneCount: milestones.length,
    adjustmentCount: adjustments.length,
  }
}

async function buildCohortPosition(ctx: DbCtx, cohort: Doc<'cohorts'>) {
  const startups = await ctx.db
    .query('startups')
    .withIndex('by_cohortId', (q) => q.eq('cohortId', cohort._id))
    .collect()
  const includedStartups = startups.filter((startup) => startup.excludeFromMetrics !== true)
  const includedStartupIds = new Set(includedStartups.map((startup) => startup._id))
  const allAdjustments = await getCohortAdjustments(ctx, cohort._id)
  const includedAdjustments = allAdjustments.filter((adjustment) =>
    includedStartupIds.has(adjustment.startupId)
  )

  const adjustmentsByStartup = new Map<Id<'startups'>, Doc<'fundingAdjustments'>[]>()
  for (const adjustment of includedAdjustments) {
    const existing = adjustmentsByStartup.get(adjustment.startupId) ?? []
    existing.push(adjustment)
    adjustmentsByStartup.set(adjustment.startupId, existing)
  }

  const startupRows = []
  for (const startup of includedStartups) {
    const summary = await computeStartupSummary(
      ctx,
      startup,
      cohort,
      adjustmentsByStartup.get(startup._id) ?? []
    )
    startupRows.push({
      _id: startup._id,
      startupId: startup._id,
      name: startup.name,
      slug: startup.slug,
      excludeFromMetrics: false,
      ...summary,
    })
  }

  const totals = startupRows.reduce(
    (acc, row) => {
      acc.topUpsAllocated += row.topUp
      acc.deductionsReturned += row.deductions
      acc.unlocked += row.unlocked
      acc.committed += row.committed
      acc.deployed += row.deployed
      acc.available += row.available
      acc.entitlement += row.entitlement
      acc.claimable += row.claimable
      return acc
    },
    {
      topUpsAllocated: 0,
      deductionsReturned: 0,
      unlocked: 0,
      committed: 0,
      deployed: 0,
      available: 0,
      entitlement: 0,
      claimable: 0,
    }
  )

  const totalAllocation = cohort.fundingBudget ?? 0
  const baseFunding = cohort.baseFunding ?? 0
  const baselineReserve = baseFunding * includedStartups.length
  const topUpPool = computeTopUpPool({
    totalAllocation,
    baselinePerStartup: baseFunding,
    includedStartupCount: includedStartups.length,
    topUpsAllocated: totals.topUpsAllocated,
    deductionsReturned: totals.deductionsReturned,
  })

  return {
    startups,
    includedStartups,
    includedAdjustments,
    startupRows,
    position: {
      totalAllocation,
      baselineReserve,
      topUpPool,
      topUpsAllocated: totals.topUpsAllocated,
      deductionsReturned: totals.deductionsReturned,
      unlocked: totals.unlocked,
      committed: totals.committed,
      deployed: totals.deployed,
      available: totals.available,
      entitlement: totals.entitlement,
      claimable: totals.claimable,
    },
    cohort: {
      fundingBudget: cohort.fundingBudget ?? null,
      baseFunding: cohort.baseFunding ?? null,
      includedStartupCount: includedStartups.length,
      startupCount: includedStartups.length,
    },
  }
}

function buildDailySeries(input: {
  startup: Doc<'startups'>
  baseline: number
  adjustments: Doc<'fundingAdjustments'>[]
  milestones: Doc<'milestones'>[]
  invoices: Doc<'invoices'>[]
  startAt: number
  endAt: number
}): FundingSeriesPoint[] {
  const events: Array<{
    at: number
    kind:
      | 'created'
      | 'top_up'
      | 'deduction'
      | 'milestone_approved'
      | 'invoice_approved'
      | 'invoice_paid'
    amount: number
  }> = [{ at: input.startup._creationTime, kind: 'created', amount: 0 }]

  for (const adjustment of input.adjustments) {
    events.push({ at: adjustment.createdAt, kind: adjustment.type, amount: adjustment.amount })
  }

  for (const milestone of input.milestones) {
    if (milestone.status === 'approved') {
      events.push({
        at: milestone.approvedAt ?? milestone._creationTime,
        kind: 'milestone_approved',
        amount: milestone.amount,
      })
    }
  }

  for (const invoice of input.invoices) {
    if (invoice.batchedIntoId) continue
    if (invoice.status === 'approved' || invoice.status === 'paid') {
      const approvedAt = parseIsoTime(invoice.approvedAt) ?? invoice._creationTime
      events.push({ at: approvedAt, kind: 'invoice_approved', amount: invoice.amountGbp })
    }
    if (invoice.status === 'paid') {
      const paidAt =
        parseIsoTime(invoice.paidAt) ?? parseIsoTime(invoice.approvedAt) ?? invoice._creationTime
      events.push({ at: paidAt, kind: 'invoice_paid', amount: invoice.amountGbp })
    }
  }

  events.sort((a, b) => a.at - b.at)

  const state = {
    active: false,
    approvedMilestones: 0,
    topUps: 0,
    deductions: 0,
    committed: 0,
    deployed: 0,
  }

  const points: FundingSeriesPoint[] = []
  let eventIndex = 0
  const start = startOfDay(input.startAt)
  const end = startOfDay(input.endAt)

  for (let cursor = start; cursor <= end; cursor += 24 * 60 * 60 * 1000) {
    const dayEnd = cursor + 24 * 60 * 60 * 1000 - 1
    while (eventIndex < events.length && events[eventIndex].at <= dayEnd) {
      const event = events[eventIndex]
      if (event.kind === 'created') state.active = true
      if (event.kind === 'top_up') state.topUps += event.amount
      if (event.kind === 'deduction') state.deductions += event.amount
      if (event.kind === 'milestone_approved') state.approvedMilestones += event.amount
      if (event.kind === 'invoice_approved') state.committed += event.amount
      if (event.kind === 'invoice_paid') {
        state.committed = Math.max(0, state.committed - event.amount)
        state.deployed += event.amount
      }
      eventIndex++
    }

    const summary = computeStartupFunding({
      baseline: state.active ? input.baseline : 0,
      approvedMilestones: state.approvedMilestones,
      topUps: state.topUps,
      deductions: state.deductions,
      committedInvoices: state.committed,
      deployedInvoices: state.deployed,
    })

    points.push({
      date: dayKey(cursor),
      entitled: summary.entitlement,
      unlocked: summary.unlocked,
      deployed: summary.deployed,
      available: summary.available,
    })
  }

  return points
}

async function buildTimeSeries(
  ctx: DbCtx,
  cohort: Doc<'cohorts'>,
  startups: Doc<'startups'>[],
  adjustments: Doc<'fundingAdjustments'>[]
) {
  if (startups.length === 0) {
    const today = dayKey(Date.now())
    return {
      aggregate: [{ date: today, entitled: 0, unlocked: 0, deployed: 0, available: 0 }],
      byStartup: [],
    }
  }

  const startAt = Math.min(...startups.map((startup) => startup._creationTime))
  const endAt = todayEnd()
  const adjustmentsByStartup = new Map<Id<'startups'>, Doc<'fundingAdjustments'>[]>()
  for (const adjustment of adjustments) {
    const existing = adjustmentsByStartup.get(adjustment.startupId) ?? []
    existing.push(adjustment)
    adjustmentsByStartup.set(adjustment.startupId, existing)
  }

  const byStartup: StartupFundingSeries[] = []
  for (const startup of startups) {
    const milestones = await ctx.db
      .query('milestones')
      .withIndex('by_startupId', (q) => q.eq('startupId', startup._id))
      .collect()
    const invoices = await ctx.db
      .query('invoices')
      .withIndex('by_startupId', (q) => q.eq('startupId', startup._id))
      .collect()
    byStartup.push({
      startupId: startup._id,
      startupName: startup.name,
      points: buildDailySeries({
        startup,
        baseline: cohort.baseFunding ?? 0,
        adjustments: adjustmentsByStartup.get(startup._id) ?? [],
        milestones,
        invoices,
        startAt,
        endAt,
      }),
    })
  }

  const aggregate =
    byStartup[0]?.points.map((point, index) => {
      return byStartup.reduce(
        (acc, startupSeries) => {
          const current = startupSeries.points[index]
          acc.entitled += current.entitled
          acc.unlocked += current.unlocked
          acc.deployed += current.deployed
          acc.available += current.available
          return acc
        },
        { date: point.date, entitled: 0, unlocked: 0, deployed: 0, available: 0 }
      )
    }) ?? []

  return { aggregate, byStartup }
}

export const dashboardForAdmin = query({
  args: { cohortId: v.id('cohorts') },
  handler: async (ctx, args) => {
    await requireAdminForCohort(ctx, args.cohortId)
    const cohort = await ctx.db.get(args.cohortId)
    if (!cohort) throw new Error('Cohort not found')

    const {
      includedStartups,
      includedAdjustments,
      startupRows,
      position,
      cohort: cohortFunding,
    } = await buildCohortPosition(ctx, cohort)
    const timeSeries = await buildTimeSeries(ctx, cohort, includedStartups, includedAdjustments)
    const auditEvents = await ctx.db
      .query('fundingAuditEvents')
      .withIndex('by_cohortId', (q) => q.eq('cohortId', args.cohortId))
      .collect()

    return {
      position,
      flow: position,
      timeSeries,
      startups: startupRows.sort((a, b) => a.name.localeCompare(b.name)),
      cohort: cohortFunding,
      auditEvents: auditEvents.sort((a, b) => b.createdAt - a.createdAt).slice(0, 20),
    }
  },
})

export const summaryForFounder = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireFounder(ctx)
    const startupIds = await getFounderStartupIds(ctx, user._id)

    if (startupIds.length === 0) {
      return {
        baseline: 0,
        topUp: 0,
        deductions: 0,
        entitlement: 0,
        unlocked: 0,
        claimable: 0,
        committed: 0,
        deployed: 0,
        available: 0,
        potential: 0,
        hasMilestones: false,
        adjustments: [] as AdjustmentWithAdmin[],
      }
    }

    const startup = await ctx.db.get(startupIds[0])
    if (!startup) throw new Error('Startup not found')
    const cohort = await ctx.db.get(startup.cohortId)
    if (!cohort) throw new Error('Cohort not found')
    const adjustments = await getStartupAdjustments(ctx, startup._id)
    const summary = await computeStartupSummary(ctx, startup, cohort, adjustments)
    const enrichedAdjustments = await enrichAdjustments(ctx, adjustments)

    return { ...summary, adjustments: enrichedAdjustments }
  },
})

export const summaryForAdminStartup = query({
  args: { startupId: v.id('startups') },
  handler: async (ctx, args) => {
    const { startup } = await requireAdminForStartup(ctx, args.startupId)
    const cohort = await ctx.db.get(startup.cohortId)
    if (!cohort) throw new Error('Cohort not found')
    const adjustments = await getStartupAdjustments(ctx, startup._id)
    const summary = await computeStartupSummary(ctx, startup, cohort, adjustments)
    const enrichedAdjustments = await enrichAdjustments(ctx, adjustments)
    const { position } = await buildCohortPosition(ctx, cohort)

    return {
      ...summary,
      startupId: startup._id,
      startupName: startup.name,
      topUpPool: position.topUpPool,
      adjustments: enrichedAdjustments,
    }
  },
})

async function validateAdjustmentTarget(
  ctx: MutationCtx,
  cohortId: Id<'cohorts'>,
  startupId: Id<'startups'>
) {
  const startup = await ctx.db.get(startupId)
  if (!startup) throw new ConvexError('Startup not found')
  if (startup.cohortId !== cohortId) {
    throw new ConvexError('Startup does not belong to this cohort')
  }
  if (startup.excludeFromMetrics === true) {
    throw new ConvexError('Funding adjustments are disabled for excluded startups')
  }
  const cohort = await ctx.db.get(cohortId)
  if (!cohort) throw new ConvexError('Cohort not found')
  return { startup, cohort }
}

export const allocateTopUp = mutation({
  args: {
    cohortId: v.id('cohorts'),
    startupId: v.id('startups'),
    amount: v.number(),
    note: v.string(),
    appUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx)
    assertPositiveAmount(args.amount)
    assertNote(args.note)
    const { startup, cohort } = await validateAdjustmentTarget(ctx, args.cohortId, args.startupId)
    const { position } = await buildCohortPosition(ctx, cohort)
    const remainingPool = Math.max(0, position.topUpPool)

    if (args.amount > remainingPool) {
      throw new ConvexError(
        `Top-up exceeds remaining top-up pool. Current pool: £${remainingPool.toFixed(2)}.`
      )
    }

    const adjustmentId = await ctx.db.insert('fundingAdjustments', {
      cohortId: args.cohortId,
      startupId: args.startupId,
      type: 'top_up',
      amount: args.amount,
      note: args.note.trim(),
      createdByUserId: admin._id,
      createdAt: Date.now(),
    })

    await ctx.scheduler.runAfter(0, internal.notifications.notifyFundingAdjustment, {
      cohortId: args.cohortId,
      startupId: args.startupId,
      startupName: startup.name,
      deltaAmount: args.amount,
      appUrl: args.appUrl,
    })

    return adjustmentId
  },
})

export const deductAvailableFunding = mutation({
  args: {
    cohortId: v.id('cohorts'),
    startupId: v.id('startups'),
    amount: v.number(),
    note: v.string(),
    appUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx)
    assertPositiveAmount(args.amount)
    assertNote(args.note)
    const { startup, cohort } = await validateAdjustmentTarget(ctx, args.cohortId, args.startupId)
    const adjustments = await getStartupAdjustments(ctx, startup._id)
    const summary = await computeStartupSummary(ctx, startup, cohort, adjustments)

    if (!canDeductFromBaseline(summary as StartupFundingSummary, args.amount)) {
      const remainingBaseline = Math.max(0, summary.baseline - summary.deductions)
      throw new ConvexError(
        `Deduction exceeds the startup's remaining baseline. Current baseline headroom: £${remainingBaseline.toFixed(2)}.`
      )
    }

    const adjustmentId = await ctx.db.insert('fundingAdjustments', {
      cohortId: args.cohortId,
      startupId: args.startupId,
      type: 'deduction',
      amount: args.amount,
      note: args.note.trim(),
      createdByUserId: admin._id,
      createdAt: Date.now(),
    })

    await ctx.scheduler.runAfter(0, internal.notifications.notifyFundingAdjustment, {
      cohortId: args.cohortId,
      startupId: args.startupId,
      startupName: startup.name,
      deltaAmount: -args.amount,
      appUrl: args.appUrl,
    })

    return adjustmentId
  },
})

export const updateCohortSettings = mutation({
  args: {
    cohortId: v.id('cohorts'),
    fundingBudget: v.optional(v.number()),
    baseFunding: v.optional(v.number()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx)
    const cohort = await ctx.db.get(args.cohortId)
    if (!cohort) throw new ConvexError('Cohort not found')

    if (
      args.fundingBudget !== undefined &&
      (!Number.isFinite(args.fundingBudget) || args.fundingBudget < 0)
    ) {
      throw new ConvexError('Funding budget must be non-negative')
    }
    if (
      args.baseFunding !== undefined &&
      (!Number.isFinite(args.baseFunding) || args.baseFunding < 0)
    ) {
      throw new ConvexError('Base funding must be non-negative')
    }

    await ctx.db.patch(args.cohortId, {
      fundingBudget: args.fundingBudget,
      baseFunding: args.baseFunding,
    })

    await ctx.db.insert('fundingAuditEvents', {
      cohortId: args.cohortId,
      type: 'cohort_settings_change',
      note: args.note?.trim() || 'Funding settings updated',
      createdByUserId: admin._id,
      createdAt: Date.now(),
      previousFundingBudget: cohort.fundingBudget,
      newFundingBudget: args.fundingBudget,
      previousBaseFunding: cohort.baseFunding,
      newBaseFunding: args.baseFunding,
    })
  },
})
