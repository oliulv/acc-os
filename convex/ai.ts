import { action } from './functions'
import { v } from 'convex/values'
import type { Id } from './_generated/dataModel'
import type { ActionCtx } from './_generated/server'

async function fetchStorageAsBase64(
  ctx: { storage: ActionCtx['storage'] },
  storageId: Id<'_storage'>
): Promise<string> {
  const url = await ctx.storage.getUrl(storageId)
  if (!url) throw new Error(`Could not get URL for storage ID ${storageId}`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to fetch file from storage`)
  const buffer = await response.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/**
 * Extract structured invoice data from uploaded PDFs using Gemini Flash 3 via OpenRouter.
 * Handles multi-currency invoices and converts everything to GBP.
 */
export const extractInvoiceData = action({
  args: {
    invoiceStorageId: v.id('_storage'),
    receiptStorageIds: v.array(v.id('_storage')),
  },
  handler: async (ctx, args) => {
    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY is not configured')
    }

    const invoiceBase64 = await fetchStorageAsBase64(ctx, args.invoiceStorageId)
    const receiptBase64s = await Promise.all(
      args.receiptStorageIds.map((id) => fetchStorageAsBase64(ctx, id))
    )

    // Build content parts using inline base64 data URIs (OpenAI vision format)
    const contentParts: Array<Record<string, unknown>> = [
      {
        type: 'text',
        text: `You are an invoice data extraction assistant. Extract the following from the provided PDF documents and respond ONLY with valid JSON (no markdown, no explanation):

{
  "vendorNames": "comma-separated vendor name(s) extracted ONLY from the receipt PDFs (NOT the invoice)",
  "description": "brief description of what was purchased, based on the receipts",
  "invoiceDate": "YYYY-MM-DD format, the date on the invoice",
  "invoiceCurrency": "ISO 4217 currency code found on the invoice (e.g. GBP, USD, EUR, NOK)",
  "totalAmountOriginal": <number - the total amount in the ORIGINAL currency as shown on the invoice>,
  "receiptCurrencies": ["ISO 4217 currency code for each receipt"],
  "receiptAmountsOriginal": [<number for each receipt PDF, the amount in its ORIGINAL currency>]
}

IMPORTANT:
- The first PDF is the INVOICE — a reimbursement request from a startup to an accelerator. It is NOT from a vendor. Do NOT extract vendor names from it.
- The remaining PDFs are RECEIPTS — these are proof-of-purchase documents from vendors/suppliers. Extract vendor names and descriptions from these.
- Extract amounts as numbers (no currency symbols).
- Identify the currency from each document. Look for currency symbols (£, $, €, kr), ISO codes, or context clues.
- If the currency is ambiguous, default to GBP.
- If you cannot determine a value, use null.`,
      },
      {
        type: 'image_url',
        image_url: {
          url: `data:application/pdf;base64,${invoiceBase64}`,
        },
      },
    ]

    receiptBase64s.forEach((b64) => {
      contentParts.push({
        type: 'image_url',
        image_url: {
          url: `data:application/pdf;base64,${b64}`,
        },
      })
    })

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-3-flash-preview',
        messages: [
          {
            role: 'user',
            content: contentParts,
          },
        ],
        temperature: 0,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`OpenRouter API error: ${response.status} ${errorText}`)
    }

    const data = await response.json()
    const rawContent = data.choices?.[0]?.message?.content ?? ''

    // Parse JSON from the response (handle possible markdown wrapping)
    let jsonStr = rawContent.trim()
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
    }

    let parsed: {
      vendorNames: string | null
      description: string | null
      invoiceDate: string | null
      invoiceCurrency: string | null
      totalAmountOriginal: number | null
      receiptCurrencies: (string | null)[]
      receiptAmountsOriginal: (number | null)[]
    }

    try {
      parsed = JSON.parse(jsonStr)
    } catch {
      throw new Error(`Failed to parse AI response as JSON: ${jsonStr.slice(0, 200)}`)
    }

    const invoiceCurrency = (parsed.invoiceCurrency ?? 'GBP').toUpperCase()
    const totalOriginal =
      typeof parsed.totalAmountOriginal === 'number' ? parsed.totalAmountOriginal : 0

    const receiptCurrencies = (parsed.receiptCurrencies ?? []).map((c) =>
      c ? c.toUpperCase() : 'GBP'
    )
    const receiptAmountsOriginal = (parsed.receiptAmountsOriginal ?? []).map((a) =>
      typeof a === 'number' ? a : 0
    )

    // Determine if any currency conversion is needed
    const allCurrencies = [invoiceCurrency, ...receiptCurrencies]
    const hasNonGbp = allCurrencies.some((c) => c !== 'GBP')

    // Fetch exchange rates if needed (using exchangerate.host free API)
    const rates: Record<string, number> = { GBP: 1 }
    if (hasNonGbp) {
      const uniqueCurrencies = [...new Set(allCurrencies.filter((c) => c !== 'GBP'))]
      try {
        // Use frankfurter.dev (free, no key required, ECB rates)
        const rateRes = await fetch(
          `https://api.frankfurter.dev/v1/latest?base=GBP&symbols=${uniqueCurrencies.join(',')}`
        )
        if (rateRes.ok) {
          const rateData = await rateRes.json()
          // frankfurter returns rates FROM base, so GBP->USD = X means 1 GBP = X USD
          // We need the inverse: to convert USD -> GBP, divide by the rate
          for (const [currency, rate] of Object.entries(rateData.rates ?? {})) {
            rates[currency] = rate as number
          }
        }
      } catch {
        // If rate fetch fails, we'll flag it and let the user convert manually
      }
    }

    function toGbp(amount: number, currency: string): number {
      if (currency === 'GBP') return amount
      const rate = rates[currency]
      if (!rate) return amount // Can't convert, return as-is
      return Math.round((amount / rate) * 100) / 100
    }

    const totalAmountGbp = toGbp(totalOriginal, invoiceCurrency)
    const receiptAmountsGbp = receiptAmountsOriginal.map((amount, i) =>
      toGbp(amount, receiptCurrencies[i] ?? 'GBP')
    )

    // Programmatic math: sum receipt amounts in GBP
    const receiptTotalGbp = receiptAmountsGbp.reduce((sum, a) => sum + a, 0)

    // Check if any currencies couldn't be converted
    const unconvertedCurrencies = allCurrencies.filter((c) => c !== 'GBP' && !rates[c])

    return {
      vendorNames: parsed.vendorNames ?? '',
      description: parsed.description ?? '',
      invoiceDate: parsed.invoiceDate ?? '',
      // Original currency info
      invoiceCurrency,
      totalAmountOriginal: totalOriginal,
      receiptCurrencies,
      receiptAmountsOriginal,
      // GBP converted amounts
      totalAmountGbp,
      receiptAmountsGbp,
      receiptTotalGbp,
      // Flags
      amountMismatch: Math.abs(totalAmountGbp - receiptTotalGbp) > 0.01,
      currencyConverted: hasNonGbp && unconvertedCurrencies.length === 0,
      unconvertedCurrencies,
    }
  },
})
