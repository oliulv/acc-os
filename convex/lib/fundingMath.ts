export type FundingAdjustmentInput = {
  type: 'top_up' | 'deduction'
  amount: number
}

export type FundingInvoiceInput = {
  status: string
  amountGbp: number
  batchedIntoId?: unknown
}

export type StartupFundingInput = {
  baseline: number
  approvedMilestones: number
  topUps: number
  deductions: number
  committedInvoices: number
  deployedInvoices: number
}

export type StartupFundingSummary = {
  baseline: number
  topUp: number
  deductions: number
  entitlement: number
  unlocked: number
  claimable: number
  committed: number
  deployed: number
  available: number
}

function positive(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100
}

export function sumAdjustments(adjustments: FundingAdjustmentInput[]) {
  return adjustments.reduce(
    (totals, adjustment) => {
      const amount = positive(adjustment.amount)
      if (adjustment.type === 'top_up') totals.topUps += amount
      if (adjustment.type === 'deduction') totals.deductions += amount
      return totals
    },
    { topUps: 0, deductions: 0 }
  )
}

export function computeInvoiceFundingTotals(invoices: FundingInvoiceInput[]) {
  return invoices.reduce(
    (totals, invoice) => {
      if (invoice.batchedIntoId) return totals
      const amount = positive(invoice.amountGbp)
      if (invoice.status === 'approved') totals.committed += amount
      if (invoice.status === 'paid') totals.deployed += amount
      return totals
    },
    { committed: 0, deployed: 0 }
  )
}

export function computeStartupFunding(input: StartupFundingInput): StartupFundingSummary {
  const baseline = positive(input.baseline)
  const approvedMilestones = positive(input.approvedMilestones)
  const topUp = positive(input.topUps)
  const deductions = positive(input.deductions)
  const committed = positive(input.committedInvoices)
  const deployed = positive(input.deployedInvoices)

  // A deduction lowers the baseline ceiling (how much the startup can unlock from
  // milestones), not the cash they have already unlocked. Cash only shrinks when the
  // reduced ceiling drops below what milestones have already unlocked.
  const effectiveBaseline = Math.max(0, baseline - deductions)
  const unlocked = Math.min(approvedMilestones, effectiveBaseline)
  const claimable = Math.max(0, unlocked + topUp)
  const entitlement = Math.max(0, effectiveBaseline + topUp)
  const available = Math.max(0, claimable - committed - deployed)

  return {
    baseline: roundCurrency(baseline),
    topUp: roundCurrency(topUp),
    deductions: roundCurrency(deductions),
    entitlement: roundCurrency(entitlement),
    unlocked: roundCurrency(unlocked),
    claimable: roundCurrency(claimable),
    committed: roundCurrency(committed),
    deployed: roundCurrency(deployed),
    available: roundCurrency(available),
  }
}

export function computeTopUpPool(input: {
  totalAllocation: number
  baselinePerStartup: number
  includedStartupCount: number
  topUpsAllocated: number
  deductionsReturned: number
}): number {
  const totalAllocation = positive(input.totalAllocation)
  const baselineReserve = positive(input.baselinePerStartup) * positive(input.includedStartupCount)
  const topUpsAllocated = positive(input.topUpsAllocated)
  const deductionsReturned = positive(input.deductionsReturned)
  return roundCurrency(totalAllocation - baselineReserve - topUpsAllocated + deductionsReturned)
}

// A deduction can only reduce the baseline ceiling, so it is capped at the baseline
// headroom still remaining after prior deductions, NOT the entitlement (which includes
// top-ups). Capping at entitlement would let a deduction exceed the baseline it can
// actually reduce, recording a deduction larger than the freed reserve and inflating
// the cohort top-up pool when that reserve is returned.
export function canDeductFromBaseline(
  summary: Pick<StartupFundingSummary, 'baseline' | 'deductions'>,
  amount: number
) {
  const normalized = roundCurrency(positive(amount))
  const remainingBaseline = Math.max(0, positive(summary.baseline) - positive(summary.deductions))
  return normalized > 0 && normalized <= remainingBaseline
}
