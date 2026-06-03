/** Valid invoice status transitions (state machine). */
export const VALID_TRANSITIONS: Record<string, string[]> = {
  submitted: ['approved', 'rejected', 'under_review'],
  under_review: ['approved', 'rejected'],
  approved: ['paid'],
  rejected: [],
  paid: [],
}

export function isValidTransition(from: string, to: string): boolean {
  const allowed = VALID_TRANSITIONS[from] ?? []
  return allowed.includes(to)
}

/**
 * Compute the next sequential invoice number from existing invoices.
 * Rejected and legacy batched-into invoices are excluded from the count.
 */
export function computeNextInvoiceNumber(
  existingInvoices: Array<{ fileName: string; status: string; batchedIntoId?: string | null }>
): number {
  const existingNumbers = existingInvoices
    .filter((inv) => inv.status !== 'rejected' && !inv.batchedIntoId)
    .map((inv) => {
      const match = inv.fileName.match(/Invoice (\d+)\.pdf$/i)
      return match ? parseInt(match[1], 10) : 0
    })
    .filter((n) => n > 0)
  const maxExisting = existingNumbers.length > 0 ? Math.max(...existingNumbers) : 0
  return maxExisting + 1
}
