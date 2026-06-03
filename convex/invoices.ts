import { query, mutation, internalAction, internalQuery, enrichEvent } from './functions'
import { internal } from './_generated/api'
import { v, ConvexError } from 'convex/values'
import type { Id } from './_generated/dataModel'
import {
  requireAdmin,
  requireAdminWithPermission,
  requireFounder,
  requireAuth,
  requireStartupAccess,
  getAdminAccessibleCohortIds,
  requireAdminForCohort,
  requireAdminForStartup,
  getFounderStartupIds,
} from './auth'
import { validateInvoiceFileName, extractInvoiceNumber } from './invoiceValidation'
import { isValidTransition, computeNextInvoiceNumber } from './lib/invoiceLogic'
import {
  computeInvoiceFundingTotals,
  computeStartupFunding,
  sumAdjustments,
} from './lib/fundingMath'
import { isStorageIdOnInvoice } from './lib/invoiceAccess'
import { withResendRetry } from './lib/resendRetry'

// Upload claim TTL. A founder must attach a claimed storageId to an invoice
// (or cancel it) within this window. Longer than a typical upload + extract +
// confirm loop, short enough that stale claims don't accumulate.
const STORAGE_CLAIM_TTL_MS = 60 * 60 * 1000 // 1h

/**
 * Generate a pre-signed upload URL for invoice files.
 */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireAuth(ctx)
    return await ctx.storage.generateUploadUrl()
  },
})

/**
 * Claim ownership of a freshly-uploaded storage blob. Called by the client
 * immediately after a successful upload. Rejects if the storageId has
 * already been claimed by another user — the legitimate uploader writes
 * the claim before any other party learns the storageId, so a race is only
 * exploitable by someone who already has the ID (not useful).
 */
export const claimStorageUpload = mutation({
  args: { storageId: v.id('_storage') },
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx)
    const existing = await ctx.db
      .query('storageClaims')
      .withIndex('by_storageId', (q) => q.eq('storageId', args.storageId))
      .unique()
    if (existing) {
      if (existing.uploaderUserId === user._id) return
      throw new ConvexError('Storage already claimed by another user')
    }
    await ctx.db.insert('storageClaims', {
      storageId: args.storageId,
      uploaderUserId: user._id,
      createdAt: Date.now(),
    })
  },
})

/**
 * Delete a stored file (cleanup for cancelled uploads). Gated on the
 * storageClaims record — only the user who uploaded the blob can delete it.
 */
export const deleteStorageFile = mutation({
  args: { storageId: v.id('_storage') },
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx)
    const claim = await ctx.db
      .query('storageClaims')
      .withIndex('by_storageId', (q) => q.eq('storageId', args.storageId))
      .unique()
    if (!claim || claim.uploaderUserId !== user._id) {
      throw new ConvexError('Not authorized to delete this file')
    }
    await ctx.storage.delete(args.storageId)
    await ctx.db.delete(claim._id)
  },
})

/**
 * Get a URL for a stored file. Requires the caller to identify which invoice
 * the file belongs to, and is gated on startup access. Prevents handing out
 * signed URLs for storage IDs that belong to other startups.
 */
export const getFileUrl = query({
  args: {
    invoiceId: v.id('invoices'),
    storageId: v.id('_storage'),
  },
  handler: async (ctx, args) => {
    const invoice = await ctx.db.get(args.invoiceId)
    if (!invoice) throw new Error('Invoice not found')
    await requireStartupAccess(ctx, invoice.startupId)
    if (!isStorageIdOnInvoice(invoice, args.storageId)) {
      throw new Error('File not found on invoice')
    }
    return await ctx.storage.getUrl(args.storageId)
  },
})

/**
 * Create an invoice record (founder uploads file, then creates record).
 * Validates: PDF only, naming convention, amount within available balance.
 */
export const create = mutation({
  args: {
    storageId: v.id('_storage'),
    fileName: v.string(),
    vendorName: v.string(),
    invoiceDate: v.string(),
    amountGbp: v.number(),
    description: v.optional(v.string()),
    receiptStorageIds: v.array(v.id('_storage')),
  },
  handler: async (ctx, args) => {
    const user = await requireFounder(ctx)
    const startupIds = await getFounderStartupIds(ctx, user._id)

    // Enrich wide event with business context
    enrichEvent(ctx, { userId: user._id, fileName: args.fileName, amountGbp: args.amountGbp })

    if (startupIds.length === 0) {
      throw new ConvexError('No startup associated with your account')
    }

    const startupId = startupIds[0]
    const startup = await ctx.db.get(startupId)
    if (!startup) throw new ConvexError('Startup not found')

    enrichEvent(ctx, { startupId, startupName: startup.name })

    // Validate at least one receipt
    if (args.receiptStorageIds.length === 0) {
      throw new ConvexError('At least one receipt is required')
    }

    // Validate filename format and naming convention
    const nameValidation = validateInvoiceFileName(args.fileName, startup.name)
    if (!nameValidation.valid) {
      throw new ConvexError(nameValidation.error)
    }

    // Enforce sequential invoice numbering (rejected and legacy batched-into invoices don't count).
    const existingInvoices = await ctx.db
      .query('invoices')
      .withIndex('by_startupId', (q) => q.eq('startupId', startupId))
      .collect()

    const expectedNext = computeNextInvoiceNumber(existingInvoices)

    const invoiceNum = extractInvoiceNumber(args.fileName)
    if (!invoiceNum || invoiceNum !== expectedNext) {
      throw new ConvexError(
        `Invoice number must be ${expectedNext}. Please name your file "${startup.name} Invoice ${expectedNext}.pdf".`
      )
    }

    // Generate structured receipt filenames server-side
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    const receiptFileNames =
      args.receiptStorageIds.length === 1
        ? [`${startup.name} Receipt ${expectedNext}.pdf`]
        : args.receiptStorageIds.map(
            (_, i) => `${startup.name} Receipt ${expectedNext}-${letters[i]}.pdf`
          )

    // Validate amount against available balance, including approved commitments.
    const milestones = await ctx.db
      .query('milestones')
      .withIndex('by_startupId', (q) => q.eq('startupId', startupId))
      .collect()
    const adjustments = await ctx.db
      .query('fundingAdjustments')
      .withIndex('by_startupId', (q) => q.eq('startupId', startupId))
      .collect()
    const cohort = await ctx.db.get(startup.cohortId)
    const approvedMilestones = milestones
      .filter((m) => m.status === 'approved')
      .reduce((sum, m) => sum + m.amount, 0)
    const adjustmentTotals = sumAdjustments(adjustments)
    const invoiceTotals = computeInvoiceFundingTotals(existingInvoices)
    const available = computeStartupFunding({
      baseline: cohort?.baseFunding ?? 0,
      approvedMilestones,
      topUps: adjustmentTotals.topUps,
      deductions: adjustmentTotals.deductions,
      committedInvoices: invoiceTotals.committed,
      deployedInvoices: invoiceTotals.deployed,
    }).available

    if (available <= 0) {
      throw new ConvexError(
        'No available funding. Complete milestones to unlock funding before submitting invoices.'
      )
    }
    if (args.amountGbp > available) {
      throw new ConvexError(
        `Amount exceeds available balance. You have £${available.toFixed(2)} available.`
      )
    }

    // Verify the caller uploaded every storage blob they are about to attach,
    // then consume the claims. Stops a founder from attaching another user's
    // leaked storage ID to their own invoice (the getFileUrl whitelist alone
    // doesn't help if arbitrary IDs can be whitelisted at create time).
    const allStorageIds = [args.storageId, ...args.receiptStorageIds]
    const now = Date.now()
    for (const sid of allStorageIds) {
      const claim = await ctx.db
        .query('storageClaims')
        .withIndex('by_storageId', (q) => q.eq('storageId', sid))
        .unique()
      if (!claim || claim.uploaderUserId !== user._id) {
        throw new ConvexError('Upload not claimed by caller')
      }
      if (now - claim.createdAt > STORAGE_CLAIM_TTL_MS) {
        throw new ConvexError('Upload claim expired — please re-upload the file')
      }
      await ctx.db.delete(claim._id)
    }

    const invoiceId = await ctx.db.insert('invoices', {
      startupId,
      uploadedByUserId: user._id,
      vendorName: args.vendorName,
      invoiceDate: args.invoiceDate,
      amountGbp: args.amountGbp,
      description: args.description,
      storageId: args.storageId,
      fileName: args.fileName,
      // Array fields for multiple receipts
      receiptStorageIds: args.receiptStorageIds,
      receiptFileNames,
      // Backward compat: first receipt in legacy fields
      receiptStorageId: args.receiptStorageIds[0],
      receiptFileName: receiptFileNames[0],
      status: 'submitted',
    })

    // Notify admins about new invoice submission
    await ctx.scheduler.runAfter(0, internal.notifications.notifyInvoiceSubmitted, {
      cohortId: startup.cohortId,
      startupName: startup.name,
      vendorName: args.vendorName,
      amountGbp: args.amountGbp,
    })

    return invoiceId
  },
})

/**
 * Get the founder's startup name and the expected next invoice number.
 */
export const getFounderInvoiceInfo = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireFounder(ctx)
    const startupIds = await getFounderStartupIds(ctx, user._id)
    if (startupIds.length === 0) return null
    const startup = await ctx.db.get(startupIds[0])
    if (!startup) return null

    const invoices = await ctx.db
      .query('invoices')
      .withIndex('by_startupId', (q) => q.eq('startupId', startupIds[0]))
      .collect()

    return {
      startupName: startup.name,
      nextInvoiceNumber: computeNextInvoiceNumber(invoices),
    }
  },
})

/**
 * List invoices for the current founder.
 */
export const listForFounder = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireFounder(ctx)
    const startupIds = await getFounderStartupIds(ctx, user._id)

    if (startupIds.length === 0) {
      return { invoices: [], pendingCount: 0 }
    }

    const allInvoices = []
    for (const startupId of startupIds) {
      const invoices = await ctx.db
        .query('invoices')
        .withIndex('by_startupId', (q) => q.eq('startupId', startupId))
        .collect()
      allInvoices.push(...invoices)
    }

    // Preserve the legacy ledger view: show generated batch invoices, hide their components.
    const visibleInvoices = allInvoices.filter((i) => !i.batchedIntoId)

    // Sort newest first
    visibleInvoices.sort((a, b) => b._creationTime - a._creationTime)

    const pendingCount = visibleInvoices.filter(
      (i) => i.status === 'submitted' || i.status === 'under_review'
    ).length

    return { invoices: visibleInvoices, pendingCount }
  },
})

/**
 * List all invoices (admin view), optionally filtered by startup or status.
 */
export const listForAdmin = query({
  args: {
    startupId: v.optional(v.id('startups')),
    status: v.optional(
      v.union(
        v.literal('submitted'),
        v.literal('under_review'),
        v.literal('approved'),
        v.literal('rejected'),
        v.literal('paid')
      )
    ),
  },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx)

    let invoices

    if (args.startupId) {
      await requireAdminForStartup(ctx, args.startupId)
      invoices = await ctx.db
        .query('invoices')
        .withIndex('by_startupId', (q) => q.eq('startupId', args.startupId!))
        .collect()
    } else if (args.status) {
      invoices = await ctx.db
        .query('invoices')
        .withIndex('by_status', (q) => q.eq('status', args.status!))
        .collect()
    } else {
      invoices = await ctx.db.query('invoices').collect()
    }

    const accessibleCohortIds = await getAdminAccessibleCohortIds(ctx, admin)
    if (accessibleCohortIds !== null) {
      const allowed = new Set(accessibleCohortIds)
      const startups = await ctx.db.query('startups').collect()
      const allowedStartupIds = new Set(
        startups.filter((startup) => allowed.has(startup.cohortId)).map((startup) => startup._id)
      )
      invoices = invoices.filter((invoice) => allowedStartupIds.has(invoice.startupId))
    }

    // Apply both filters if needed
    if (args.startupId && args.status) {
      invoices = invoices.filter((i) => i.status === args.status)
    }

    // Preserve the legacy ledger view: show generated batch invoices, hide their components.
    invoices = invoices.filter((i) => !i.batchedIntoId)

    invoices.sort((a, b) => b._creationTime - a._creationTime)

    const enriched = await Promise.all(
      invoices.map(async (inv) => {
        const startup = await ctx.db.get(inv.startupId)
        return { ...inv, startupName: startup?.name }
      })
    )
    return enriched
  },
})

/**
 * Get the next submitted invoice (for auto-navigation after approval).
 * If startupId is provided, looks within that startup first.
 * Otherwise finds the next submitted invoice across all startups in the cohort.
 */
export const getNextSubmitted = query({
  args: {
    cohortId: v.id('cohorts'),
    excludeId: v.id('invoices'),
    startupId: v.optional(v.id('startups')),
  },
  handler: async (ctx, args) => {
    await requireAdminForCohort(ctx, args.cohortId)

    if (args.startupId) {
      const { startup } = await requireAdminForStartup(ctx, args.startupId)
      if (startup.cohortId !== args.cohortId) {
        throw new Error('Startup does not belong to this cohort')
      }
      // Find next submitted invoice for this specific startup
      const invoices = await ctx.db
        .query('invoices')
        .withIndex('by_startupId', (q) => q.eq('startupId', args.startupId!))
        .collect()
      const next = invoices
        .filter((i) => i.status === 'submitted' && i._id !== args.excludeId && !i.batchedIntoId)
        .sort((a, b) => a._creationTime - b._creationTime)
      if (next.length > 0) return next[0]._id
    }

    // Find next submitted invoice across all startups in the cohort
    const startups = await ctx.db
      .query('startups')
      .withIndex('by_cohortId', (q) => q.eq('cohortId', args.cohortId))
      .collect()

    const candidates = []
    for (const startup of startups) {
      const invoices = await ctx.db
        .query('invoices')
        .withIndex('by_startupId', (q) => q.eq('startupId', startup._id))
        .collect()
      candidates.push(
        ...invoices.filter(
          (i) => i.status === 'submitted' && i._id !== args.excludeId && !i.batchedIntoId
        )
      )
    }
    candidates.sort((a, b) => a._creationTime - b._creationTime)
    return candidates.length > 0 ? candidates[0]._id : null
  },
})

/**
 * Get a single invoice by ID. Gated on startup access: admins see all,
 * founders only invoices for startups they belong to.
 */
export const getById = query({
  args: { id: v.id('invoices') },
  handler: async (ctx, args) => {
    const invoice = await ctx.db.get(args.id)
    if (!invoice) return null
    await requireStartupAccess(ctx, invoice.startupId)
    return invoice
  },
})

/**
 * Update invoice status (admin: approve, reject, mark paid).
 */
export const updateStatus = mutation({
  args: {
    id: v.id('invoices'),
    status: v.union(
      v.literal('under_review'),
      v.literal('approved'),
      v.literal('rejected'),
      v.literal('paid')
    ),
    adminComment: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const invoice = await ctx.db.get(args.id)
    if (!invoice) throw new Error('Invoice not found')

    // Every financial state transition (approved/rejected/paid) requires
    // approve_invoices permission scoped to this startup. `under_review`
    // is a lightweight triage action any admin can take.
    const startup = await ctx.db.get(invoice.startupId)
    if (!startup) throw new Error('Startup not found')

    let admin
    if (args.status === 'approved' || args.status === 'rejected' || args.status === 'paid') {
      admin = await requireAdminWithPermission(
        ctx,
        startup.cohortId,
        'approve_invoices',
        startup._id
      )
    } else {
      const result = await requireAdminForStartup(ctx, invoice.startupId)
      admin = result.user
    }

    // Validate status transitions
    if (!isValidTransition(invoice.status, args.status)) {
      throw new Error(`Cannot change status from "${invoice.status}" to "${args.status}"`)
    }

    const patch: Record<string, unknown> = {
      status: args.status,
    }

    if (args.adminComment !== undefined) {
      patch.adminComment = args.adminComment?.trim() || undefined
    }

    if (args.status === 'approved') {
      patch.approvedByAdminId = admin._id
      patch.approvedAt = new Date().toISOString()
    }

    if (args.status === 'paid') {
      patch.paidAt = new Date().toISOString()
    }

    await ctx.db.patch(args.id, patch)

    // Send to Xero on approval
    if (args.status === 'approved') {
      await ctx.scheduler.runAfter(0, internal.invoices.sendToXero, { invoiceId: args.id })
    }

    // Notify founder about invoice status change
    if (args.status === 'approved' || args.status === 'rejected') {
      await ctx.scheduler.runAfter(0, internal.notifications.notifyInvoiceStatusChanged, {
        userId: invoice.uploadedByUserId,
        fileName: invoice.fileName,
        status: args.status,
      })
    }

    // Notify founder when invoice is marked as paid
    if (args.status === 'paid') {
      const startup = await ctx.db.get(invoice.startupId)
      await ctx.scheduler.runAfter(0, internal.notifications.notifyInvoicePaid, {
        userId: invoice.uploadedByUserId,
        fileName: invoice.fileName,
        amountGbp: invoice.amountGbp,
        cohortId: startup?.cohortId,
      })
    }
  },
})

/**
 * Batch mark multiple approved invoices as paid (admin).
 */
export const batchMarkPaid = mutation({
  args: { ids: v.array(v.id('invoices')) },
  handler: async (ctx, args) => {
    // Each invoice must pass the scoped approve_invoices check before
    // it can be marked paid. A user with a grant on one startup cannot
    // batch-mark invoices on another startup in the same cohort.
    for (const id of args.ids) {
      const invoice = await ctx.db.get(id)
      if (!invoice) throw new Error(`Invoice ${id} not found`)
      if (invoice.status !== 'approved') throw new Error(`Invoice ${id} is not approved`)
      const startup = await ctx.db.get(invoice.startupId)
      if (!startup) throw new Error(`Startup for invoice ${id} not found`)
      await requireAdminWithPermission(ctx, startup.cohortId, 'approve_invoices', startup._id)
      await ctx.db.patch(id, {
        status: 'paid',
        paidAt: new Date().toISOString(),
      })

      // Notify founder about payment
      await ctx.scheduler.runAfter(0, internal.notifications.notifyInvoicePaid, {
        userId: invoice.uploadedByUserId,
        fileName: invoice.fileName,
        amountGbp: invoice.amountGbp,
        cohortId: startup.cohortId,
      })
    }
  },
})

/**
 * Internal query: get invoice data + startup name for the Xero action.
 */
export const getInvoiceForXero = internalQuery({
  args: { invoiceId: v.id('invoices') },
  handler: async (ctx, args) => {
    const invoice = await ctx.db.get(args.invoiceId)
    if (!invoice) return null
    const startup = await ctx.db.get(invoice.startupId)
    return { invoice, startupName: startup?.name ?? 'Unknown' }
  },
})

/**
 * Internal action: send invoice + receipt PDFs to Xero via Resend email.
 */
export const sendToXero = internalAction({
  args: { invoiceId: v.id('invoices') },
  handler: async (ctx, args) => {
    const data = await ctx.runQuery(internal.invoices.getInvoiceForXero, {
      invoiceId: args.invoiceId,
    })
    if (!data) throw new Error('Invoice not found for Xero send')

    const { invoice, startupName } = data
    const xeroBillsEmail = process.env.XERO_BILLS_EMAIL
    const xeroReceiptsEmail = process.env.XERO_RECEIPTS_EMAIL
    const fromEmail = process.env.FROM_EMAIL

    if (!xeroBillsEmail || !xeroReceiptsEmail) {
      console.log('Xero email addresses not configured, skipping Xero send')
      return
    }
    if (!fromEmail) throw new Error('FROM_EMAIL environment variable is not set')

    const { Resend } = await import('resend')
    const resend = new Resend(process.env.RESEND_API_KEY)

    // Extract invoice number from filename
    const invoiceNumMatch = invoice.fileName.match(/Invoice (\d+)\.pdf$/i)
    const invoiceNum = invoiceNumMatch?.[1] ?? '0'

    // Use Resend's `path` option — Resend fetches the file from the URL directly,
    // so we never load PDFs into the Convex action's 64MB memory.
    const invoiceFileUrl = await ctx.storage.getUrl(invoice.storageId)
    if (!invoiceFileUrl) throw new Error('Invoice file URL not found')

    // Send invoice to Xero bills, with backoff on Resend rate limits.
    // Concurrent approvals (or any 429 spike) shouldn't drop the email and
    // leave the DB stamped 'approved' with nothing in Xero.
    await withResendRetry(
      () =>
        resend.emails.send({
          from: fromEmail,
          to: xeroBillsEmail,
          subject: `${startupName} Invoice ${invoiceNum}`,
          text: `Invoice ${invoiceNum} from ${startupName}`,
          attachments: [{ filename: invoice.fileName, path: invoiceFileUrl }],
        }),
      { label: `send invoice ${startupName} #${invoiceNum} to Xero` }
    )

    // Collect receipt storage IDs (handle both old single and new array format).
    // For legacy batch invoices, merge original invoice files + receipts for Xero.
    const originalIds: string[] = invoice.originalInvoiceStorageIds ?? []
    const originalNames: string[] = invoice.originalInvoiceFileNames ?? []

    const renamedOriginalNames = originalNames.map((name) => {
      const origMatch = name.match(/Invoice (\d+)\.pdf$/i)
      if (!origMatch) return name
      return `${startupName} Batch ${invoiceNum} - Original Invoice ${origMatch[1]}.pdf`
    })

    const receiptIds: string[] = [
      ...originalIds,
      ...(invoice.receiptStorageIds ??
        (invoice.receiptStorageId ? [invoice.receiptStorageId] : [])),
    ]
    const receiptNames: string[] = [
      ...renamedOriginalNames,
      ...(invoice.receiptFileNames ?? (invoice.receiptFileName ? [invoice.receiptFileName] : [])),
    ]

    // Send all receipts in a single email — Resend fetches each via URL
    const receiptAttachments: Array<{ filename: string; path: string }> = []
    for (let i = 0; i < receiptIds.length; i++) {
      const receiptFileUrl = await ctx.storage.getUrl(receiptIds[i] as Id<'_storage'>)
      if (!receiptFileUrl) continue
      receiptAttachments.push({
        filename: receiptNames[i] || `Receipt ${i + 1}.pdf`,
        path: receiptFileUrl,
      })
    }

    if (receiptAttachments.length > 0) {
      await withResendRetry(
        () =>
          resend.emails.send({
            from: fromEmail,
            to: xeroReceiptsEmail,
            subject: `${startupName} Receipts for Invoice ${invoiceNum}`,
            text: `Receipts for Invoice ${invoiceNum} from ${startupName}`,
            attachments: receiptAttachments,
          }),
        { label: `send receipts ${startupName} #${invoiceNum} to Xero` }
      )
    }
  },
})

/**
 * Get component invoices for a legacy batch invoice. Silently drops any invoice
 * the caller cannot access so a malformed ID list doesn't break the view
 * for legitimate callers.
 */
export const getComponentInvoices = query({
  args: { ids: v.array(v.id('invoices')) },
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx)
    const isSuperAdmin = user.role === 'super_admin'

    const results = []
    for (const id of args.ids) {
      const inv = await ctx.db.get(id)
      if (!inv) continue
      if (!isSuperAdmin) {
        try {
          await requireStartupAccess(ctx, inv.startupId)
        } catch {
          continue
        }
      }
      results.push({
        _id: inv._id,
        vendorName: inv.vendorName,
        amountGbp: inv.amountGbp,
        invoiceDate: inv.invoiceDate,
        fileName: inv.fileName,
        storageId: inv.storageId,
        description: inv.description,
      })
    }
    return results
  },
})
