import { internalAction, internalMutation } from './functions'
import { internal } from './_generated/api'
import { v } from 'convex/values'
import type { MutationCtx } from './functions'
import type { Id } from './_generated/dataModel'

async function deletePendingBatchRows(ctx: MutationCtx, startupId: Id<'startups'>) {
  const existing = await ctx.db
    .query('pendingBatches')
    .withIndex('by_startupId', (q) => q.eq('startupId', startupId))
    .collect()
  for (const pending of existing) {
    await ctx.db.delete(pending._id)
  }
}

/**
 * Legacy compatibility shim only.
 *
 * Invoice batching is disabled going forward. These internal functions remain
 * so already-scheduled Convex jobs can drain without creating generated batch
 * invoices or leaving stale pending batch records behind.
 */
export const executeBatch = internalAction({
  args: { startupId: v.id('startups') },
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.invoiceBatching.cleanupPendingBatch, {
      startupId: args.startupId,
    })
  },
})

export const scheduleBatching = internalMutation({
  args: { startupId: v.id('startups') },
  handler: async (ctx, args) => {
    await deletePendingBatchRows(ctx, args.startupId)
  },
})

export const cancelBatchIfEmpty = internalMutation({
  args: {
    startupId: v.id('startups'),
    excludeInvoiceId: v.id('invoices'),
  },
  handler: async (ctx, args) => {
    await deletePendingBatchRows(ctx, args.startupId)
  },
})

export const cleanupPendingBatch = internalMutation({
  args: { startupId: v.id('startups') },
  handler: async (ctx, args) => {
    await deletePendingBatchRows(ctx, args.startupId)
  },
})
