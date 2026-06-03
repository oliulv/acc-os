import { describe, it, expect } from 'bun:test'
import {
  canDeductFromBaseline,
  computeInvoiceFundingTotals,
  computeStartupFunding,
  computeTopUpPool,
} from './fundingMath'

describe('fundingMath', () => {
  it('caps baseline claimable by approved milestones', () => {
    const summary = computeStartupFunding({
      baseline: 5000,
      approvedMilestones: 8000,
      topUps: 0,
      deductions: 0,
      committedInvoices: 0,
      deployedInvoices: 0,
    })

    expect(summary.unlocked).toBe(5000)
    expect(summary.available).toBe(5000)
  })

  it('increases available immediately for top-ups', () => {
    const summary = computeStartupFunding({
      baseline: 5000,
      approvedMilestones: 1000,
      topUps: 1500,
      deductions: 0,
      committedInvoices: 0,
      deployedInvoices: 0,
    })

    expect(summary.entitlement).toBe(6500)
    expect(summary.available).toBe(2500)
  })

  it('lowers the baseline ceiling without clawing back unspent top-up cash', () => {
    const summary = computeStartupFunding({
      baseline: 5000,
      approvedMilestones: 5000,
      topUps: 1000,
      deductions: 750,
      committedInvoices: 0,
      deployedInvoices: 0,
    })

    // Effective baseline 4250, all of it unlocked, plus the 1000 top-up.
    expect(summary.entitlement).toBe(5250)
    expect(summary.available).toBe(5250)
  })

  it('deducts from the baseline beyond the currently-available balance (regression)', () => {
    // Repro of the funding-modal bug: only 119 available, but admin deducts 500
    // from the 5000 baseline ceiling. The deduction must be allowed and must NOT
    // touch the cash already unlocked.
    const before = computeStartupFunding({
      baseline: 5000,
      approvedMilestones: 1500,
      topUps: 0,
      deductions: 0,
      committedInvoices: 0,
      deployedInvoices: 1381,
    })
    expect(before.available).toBe(119)
    expect(before.entitlement).toBe(5000)
    // 500 > available (119) but <= baseline headroom (5000): allowed.
    expect(canDeductFromBaseline(before, 500)).toBe(true)

    const after = computeStartupFunding({
      baseline: 5000,
      approvedMilestones: 1500,
      topUps: 0,
      deductions: 500,
      committedInvoices: 0,
      deployedInvoices: 1381,
    })
    expect(after.entitlement).toBe(4500) // ceiling dropped
    expect(after.unlocked).toBe(1500) // unlocked unchanged
    expect(after.available).toBe(119) // cash untouched
  })

  it('claws back unlocked cash only when the deduction cuts below what is unlocked', () => {
    const after = computeStartupFunding({
      baseline: 5000,
      approvedMilestones: 1500,
      topUps: 0,
      deductions: 4000, // effective baseline 1000, below the 1500 unlocked
      committedInvoices: 0,
      deployedInvoices: 0,
    })
    expect(after.entitlement).toBe(1000)
    expect(after.unlocked).toBe(1000) // unlocked clamped down to the new ceiling
    expect(after.available).toBe(1000)
  })

  it('caps deductions at the baseline headroom, not the available balance', () => {
    const summary = computeStartupFunding({
      baseline: 5000,
      approvedMilestones: 1500,
      topUps: 0,
      deductions: 0,
      committedInvoices: 0,
      deployedInvoices: 1381,
    })
    expect(canDeductFromBaseline(summary, 5000)).toBe(true)
    expect(canDeductFromBaseline(summary, 5001)).toBe(false)
    expect(canDeductFromBaseline(summary, 0)).toBe(false)
  })

  it('caps deductions at remaining baseline, never into the top-up portion', () => {
    // baseline 5000, topUp 1000 -> entitlement 6000. A deduction must be capped at
    // the 5000 baseline headroom, NOT the 6000 entitlement, otherwise the extra 1000
    // would be recorded and returned to the pool as phantom money (see computeTopUpPool).
    const summary = computeStartupFunding({
      baseline: 5000,
      approvedMilestones: 5000,
      topUps: 1000,
      deductions: 0,
      committedInvoices: 0,
      deployedInvoices: 0,
    })
    expect(summary.entitlement).toBe(6000)
    expect(canDeductFromBaseline(summary, 5000)).toBe(true)
    expect(canDeductFromBaseline(summary, 5001)).toBe(false) // would bite into top-up
  })

  it('caps the second deduction at the remaining baseline after the first', () => {
    // Already deducted 2000 of a 5000 baseline -> only 3000 headroom left.
    const summary = computeStartupFunding({
      baseline: 5000,
      approvedMilestones: 5000,
      topUps: 0,
      deductions: 2000,
      committedInvoices: 0,
      deployedInvoices: 0,
    })
    expect(canDeductFromBaseline(summary, 3000)).toBe(true)
    expect(canDeductFromBaseline(summary, 3001)).toBe(false)
  })

  it('protects approved and paid invoices from availability', () => {
    const summary = computeStartupFunding({
      baseline: 5000,
      approvedMilestones: 5000,
      topUps: 500,
      deductions: 0,
      committedInvoices: 1200,
      deployedInvoices: 1500,
    })

    expect(summary.committed).toBe(1200)
    expect(summary.deployed).toBe(1500)
    expect(summary.available).toBe(2800)
  })

  it('moves an invoice from committed to deployed without double counting', () => {
    const approved = computeStartupFunding({
      baseline: 5000,
      approvedMilestones: 5000,
      topUps: 0,
      deductions: 0,
      committedInvoices: 2000,
      deployedInvoices: 0,
    })
    const paid = computeStartupFunding({
      baseline: 5000,
      approvedMilestones: 5000,
      topUps: 0,
      deductions: 0,
      committedInvoices: 0,
      deployedInvoices: 2000,
    })

    expect(approved.available).toBe(3000)
    expect(paid.available).toBe(3000)
  })

  it('excludes legacy batched component invoices from committed and deployed totals', () => {
    const totals = computeInvoiceFundingTotals([
      { status: 'approved', amountGbp: 500, batchedIntoId: 'batch' },
      { status: 'paid', amountGbp: 750, batchedIntoId: 'batch' },
      { status: 'approved', amountGbp: 1000 },
      { status: 'paid', amountGbp: 2000 },
    ])

    expect(totals).toEqual({ committed: 1000, deployed: 2000 })
  })

  it('decreases top-up pool on allocation and increases it on deduction', () => {
    expect(
      computeTopUpPool({
        totalAllocation: 70000,
        baselinePerStartup: 5000,
        includedStartupCount: 12,
        topUpsAllocated: 2500,
        deductionsReturned: 500,
      })
    ).toBe(8000)
  })
})
