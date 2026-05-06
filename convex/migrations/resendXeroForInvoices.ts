import { internalAction, internalQuery } from '../functions'
import { internal } from '../_generated/api'
import { v } from 'convex/values'
import type { Id } from '../_generated/dataModel'

/**
 * One-shot Xero re-send. Mirrors `invoices.sendToXero` but with explicit
 * per-invoice control over which emails go out and a paced loop that stays
 * under Resend's 2 req/sec rate limit. Use after a batch of approvals
 * partially delivered (e.g. some bills landed, receipts didn't).
 *
 * Args:
 *   bills:    invoice IDs to re-send the bill PDF for
 *   receipts: invoice IDs to re-send the receipt PDFs for
 *   delayMs:  pause between sends (default 1000ms = 1 req/sec, well under
 *             Resend's 2 req/sec default)
 *
 * Run: npx convex run --prod migrations/resendXeroForInvoices:run \
 *        '{"bills":["..."],"receipts":["..."]}'
 *
 * Idempotency note: re-sending a bill creates a duplicate email in the Xero
 * bills inbox. Only include IDs whose bill did NOT deliver. Receipts are
 * normally safer to re-send wholesale because the partial-failure mode is
 * "all or none" — but verify in the Resend dashboard first.
 */
export const run = internalAction({
  args: {
    bills: v.array(v.id('invoices')),
    receipts: v.array(v.id('invoices')),
    delayMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const xeroBillsEmail = process.env.XERO_BILLS_EMAIL
    const xeroReceiptsEmail = process.env.XERO_RECEIPTS_EMAIL
    const fromEmail = process.env.FROM_EMAIL
    if (!fromEmail) throw new Error('FROM_EMAIL not set')
    if (args.bills.length > 0 && !xeroBillsEmail) {
      throw new Error('XERO_BILLS_EMAIL not set')
    }
    if (args.receipts.length > 0 && !xeroReceiptsEmail) {
      throw new Error('XERO_RECEIPTS_EMAIL not set')
    }

    const { Resend } = await import('resend')
    const resend = new Resend(process.env.RESEND_API_KEY)
    const delayMs = args.delayMs ?? 1000

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

    // Send a single Resend payload, retrying on rate-limit errors with
    // exponential backoff. Treats any error message containing "rate" or
    // "limit" or HTTP 429 as retryable. Other errors throw immediately.
    async function sendWithRetry(
      payload: Parameters<typeof resend.emails.send>[0],
      label: string
    ): Promise<void> {
      const maxAttempts = 6
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const { error } = await resend.emails.send(payload)
        if (!error) return
        const msg = error.message ?? String(error)
        const retryable =
          /rate|limit|429|too many/i.test(msg) ||
          (error as { statusCode?: number }).statusCode === 429
        if (!retryable || attempt === maxAttempts) {
          throw new Error(`[${label}] ${msg}`)
        }
        const backoffMs = delayMs * Math.pow(2, attempt - 1)
        console.log(
          `[${label}] rate-limited (attempt ${attempt}/${maxAttempts}), waiting ${backoffMs}ms`
        )
        await sleep(backoffMs)
      }
    }

    type SendItem = { kind: 'bill' | 'receipts'; invoiceId: Id<'invoices'> }
    const queue: SendItem[] = [
      ...args.bills.map((id) => ({ kind: 'bill' as const, invoiceId: id })),
      ...args.receipts.map((id) => ({ kind: 'receipts' as const, invoiceId: id })),
    ]

    const results: Array<{
      kind: string
      invoiceId: string
      status: 'sent' | 'skipped' | 'error'
      detail?: string
    }> = []

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i]
      const data = await ctx.runQuery(internal.invoices.getInvoiceForXero, {
        invoiceId: item.invoiceId,
      })
      if (!data) {
        results.push({
          kind: item.kind,
          invoiceId: String(item.invoiceId),
          status: 'error',
          detail: 'invoice not found',
        })
        continue
      }
      const { invoice, startupName } = data
      const invoiceNumMatch = invoice.fileName.match(/Invoice (\d+)\.pdf$/i)
      const invoiceNum = invoiceNumMatch?.[1] ?? '0'

      if (item.kind === 'bill') {
        const fileUrl = await ctx.storage.getUrl(invoice.storageId)
        if (!fileUrl) {
          results.push({
            kind: 'bill',
            invoiceId: String(item.invoiceId),
            status: 'error',
            detail: 'storage URL missing',
          })
          continue
        }
        await sendWithRetry(
          {
            from: fromEmail!,
            to: xeroBillsEmail!,
            subject: `${startupName} Invoice ${invoiceNum}`,
            text: `Invoice ${invoiceNum} from ${startupName}`,
            attachments: [{ filename: invoice.fileName, path: fileUrl }],
          },
          `bill ${startupName} #${invoiceNum}`
        )
        results.push({
          kind: 'bill',
          invoiceId: String(item.invoiceId),
          status: 'sent',
          detail: `${startupName} Invoice ${invoiceNum}`,
        })
      } else {
        // Receipts: same logic as `sendToXero` for batch + non-batch.
        const originalIds: string[] = invoice.originalInvoiceStorageIds ?? []
        const originalNames: string[] = invoice.originalInvoiceFileNames ?? []
        const renamedOriginalNames = originalNames.map((name) => {
          const m = name.match(/Invoice (\d+)\.pdf$/i)
          if (!m) return name
          return `${startupName} Batch ${invoiceNum} - Original Invoice ${m[1]}.pdf`
        })
        const receiptIds: string[] = [
          ...originalIds,
          ...(invoice.receiptStorageIds ??
            (invoice.receiptStorageId ? [invoice.receiptStorageId] : [])),
        ]
        const receiptNames: string[] = [
          ...renamedOriginalNames,
          ...(invoice.receiptFileNames ??
            (invoice.receiptFileName ? [invoice.receiptFileName] : [])),
        ]
        const attachments = []
        for (let r = 0; r < receiptIds.length; r++) {
          const url = await ctx.storage.getUrl(receiptIds[r] as Id<'_storage'>)
          if (!url) continue
          attachments.push({
            filename: receiptNames[r] || `Receipt ${r + 1}.pdf`,
            path: url,
          })
        }
        if (attachments.length === 0) {
          results.push({
            kind: 'receipts',
            invoiceId: String(item.invoiceId),
            status: 'skipped',
            detail: 'no receipt files',
          })
          continue
        }
        await sendWithRetry(
          {
            from: fromEmail!,
            to: xeroReceiptsEmail!,
            subject: `${startupName} Receipts for Invoice ${invoiceNum}`,
            text: `Receipts for Invoice ${invoiceNum} from ${startupName}`,
            attachments,
          },
          `receipts ${startupName} #${invoiceNum}`
        )
        results.push({
          kind: 'receipts',
          invoiceId: String(item.invoiceId),
          status: 'sent',
          detail: `${startupName} Invoice ${invoiceNum} (${attachments.length} files)`,
        })
      }

      // Pace between sends. Skip the wait after the last item.
      if (i < queue.length - 1) await sleep(delayMs)
    }

    const summary = {
      total: results.length,
      sent: results.filter((r) => r.status === 'sent').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      errored: results.filter((r) => r.status === 'error').length,
      results,
    }
    console.log(JSON.stringify(summary, null, 2))
    return summary
  },
})

/**
 * Convenience helper: list every invoice approved within the last `minutes`,
 * with the fields needed to identify "which bills already delivered" by
 * matching against the Resend dashboard. Use as a dry-run before resend.
 *
 * Run: npx convex run --prod migrations/resendXeroForInvoices:listRecentApprovals \
 *        '{"minutes":30}'
 */
export const listRecentApprovals = internalQuery({
  args: { minutes: v.number() },
  handler: async (ctx, args) => {
    const cutoffMs = Date.now() - args.minutes * 60 * 1000
    const cutoffIso = new Date(cutoffMs).toISOString()
    const approved = await ctx.db
      .query('invoices')
      .withIndex('by_status', (q) => q.eq('status', 'approved'))
      .collect()
    const recent = approved.filter((i) => (i.approvedAt ?? '') >= cutoffIso)
    const enriched = await Promise.all(
      recent.map(async (i) => {
        const startup = await ctx.db.get(i.startupId)
        const numMatch = i.fileName.match(/Invoice (\d+)\.pdf$/i)
        return {
          _id: i._id,
          startupName: startup?.name ?? 'Unknown',
          invoiceNum: numMatch?.[1] ?? '?',
          fileName: i.fileName,
          amountGbp: i.amountGbp,
          approvedAt: i.approvedAt,
          subjectLine: `${startup?.name ?? 'Unknown'} Invoice ${numMatch?.[1] ?? '?'}`,
        }
      })
    )
    enriched.sort((a, b) => (a.approvedAt ?? '').localeCompare(b.approvedAt ?? ''))
    return enriched
  },
})
