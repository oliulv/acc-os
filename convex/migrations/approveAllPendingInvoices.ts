import { internalMutation } from '../functions'
import { internal } from '../_generated/api'
import { v } from 'convex/values'
import { isValidTransition } from '../lib/invoiceLogic'

/**
 * One-shot manual approval. Mirrors `invoices.updateStatus` for the
 * approve path but bypasses the admin-permission check so it can be
 * driven from the Convex CLI when the operator can't sign in.
 *
 * Behaviour, per invoice:
 *   - Status patched to 'approved'
 *   - approvedByAdminId / approvedAt stamped (admin resolved by email)
 *   - sendToXero scheduled (emails Xero bills + receipts)
 *   - cancelBatchIfEmpty scheduled
 *   - notifyInvoiceStatusChanged scheduled (SMS the founder)
 *
 * Dry run:  npx convex run --prod migrations/approveAllPendingInvoices:run \
 *             '{"adminEmail":"oliver.ulvebne@gmail.com","dryRun":true}'
 * Execute:  npx convex run --prod migrations/approveAllPendingInvoices:run \
 *             '{"adminEmail":"oliver.ulvebne@gmail.com","dryRun":false}'
 */
export const run = internalMutation({
  args: {
    adminEmail: v.string(),
    dryRun: v.boolean(),
    invoiceIds: v.optional(v.array(v.id('invoices'))),
  },
  handler: async (ctx, args) => {
    const matches = await ctx.db
      .query('users')
      .filter((q) => q.eq(q.field('email'), args.adminEmail))
      .collect()
    if (matches.length === 0) throw new Error(`No user found with email ${args.adminEmail}`)
    if (matches.length > 1)
      throw new Error(`Multiple users (${matches.length}) found with email ${args.adminEmail}`)
    const admin = matches[0]
    if (admin.role !== 'admin' && admin.role !== 'super_admin') {
      throw new Error(`User ${args.adminEmail} is not an admin (role=${admin.role})`)
    }

    let candidates
    if (args.invoiceIds && args.invoiceIds.length > 0) {
      const fetched = await Promise.all(args.invoiceIds.map((id) => ctx.db.get(id)))
      candidates = fetched.filter(
        (i): i is NonNullable<typeof i> =>
          i !== null &&
          (i.status === 'submitted' || i.status === 'under_review') &&
          !i.batchedIntoId
      )
    } else {
      const submitted = await ctx.db
        .query('invoices')
        .withIndex('by_status', (q) => q.eq('status', 'submitted'))
        .collect()
      const underReview = await ctx.db
        .query('invoices')
        .withIndex('by_status', (q) => q.eq('status', 'under_review'))
        .collect()
      candidates = [...submitted, ...underReview].filter((i) => !i.batchedIntoId)
    }

    const summary = candidates.map((i) => ({
      _id: i._id,
      fileName: i.fileName,
      vendorName: i.vendorName,
      amountGbp: i.amountGbp,
      status: i.status,
      isBatched: i.isBatched ?? false,
      startupId: i.startupId,
    }))

    if (args.dryRun) {
      console.log(`[dryRun] would approve ${candidates.length} invoice(s) as ${admin.email}`)
      return { dryRun: true, count: candidates.length, invoices: summary }
    }

    const approvedAtIso = new Date().toISOString()
    const results: Array<{ id: string; fileName: string }> = []

    for (const invoice of candidates) {
      if (!isValidTransition(invoice.status, 'approved')) {
        throw new Error(
          `Invoice ${invoice._id} has invalid transition: ${invoice.status} -> approved`
        )
      }

      await ctx.db.patch(invoice._id, {
        status: 'approved',
        approvedByAdminId: admin._id,
        approvedAt: approvedAtIso,
      })

      await ctx.scheduler.runAfter(0, internal.invoices.sendToXero, {
        invoiceId: invoice._id,
      })
      await ctx.scheduler.runAfter(0, internal.invoiceBatching.cancelBatchIfEmpty, {
        startupId: invoice.startupId,
        excludeInvoiceId: invoice._id,
      })
      await ctx.scheduler.runAfter(0, internal.notifications.notifyInvoiceStatusChanged, {
        userId: invoice.uploadedByUserId,
        fileName: invoice.fileName,
        status: 'approved',
      })

      results.push({ id: String(invoice._id), fileName: invoice.fileName })
    }

    console.log(`approved ${results.length} invoice(s) as ${admin.email}`)
    return { dryRun: false, count: results.length, approved: results }
  },
})
