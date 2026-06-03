import { describe, it, expect } from 'bun:test'
import { isValidTransition, computeNextInvoiceNumber, VALID_TRANSITIONS } from './invoiceLogic'

describe('invoiceLogic', () => {
  describe('isValidTransition', () => {
    it('should allow submitted -> approved', () => {
      expect(isValidTransition('submitted', 'approved')).toBe(true)
    })

    it('should allow submitted -> rejected', () => {
      expect(isValidTransition('submitted', 'rejected')).toBe(true)
    })

    it('should allow submitted -> under_review', () => {
      expect(isValidTransition('submitted', 'under_review')).toBe(true)
    })

    it('should allow under_review -> approved', () => {
      expect(isValidTransition('under_review', 'approved')).toBe(true)
    })

    it('should allow under_review -> rejected', () => {
      expect(isValidTransition('under_review', 'rejected')).toBe(true)
    })

    it('should allow approved -> paid', () => {
      expect(isValidTransition('approved', 'paid')).toBe(true)
    })

    it('should reject paid -> submitted (terminal state)', () => {
      expect(isValidTransition('paid', 'submitted')).toBe(false)
    })

    it('should reject rejected -> approved (terminal state)', () => {
      expect(isValidTransition('rejected', 'approved')).toBe(false)
    })

    it('should reject approved -> submitted (backward transition)', () => {
      expect(isValidTransition('approved', 'submitted')).toBe(false)
    })

    it('should return false for unknown source status', () => {
      expect(isValidTransition('nonexistent', 'approved')).toBe(false)
    })

    it('should have terminal states with no outgoing transitions', () => {
      expect(VALID_TRANSITIONS['rejected']).toEqual([])
      expect(VALID_TRANSITIONS['paid']).toEqual([])
    })

    it('should reject all transitions from terminal states', () => {
      const allStatuses = Object.keys(VALID_TRANSITIONS)
      for (const target of allStatuses) {
        expect(isValidTransition('rejected', target)).toBe(false)
        expect(isValidTransition('paid', target)).toBe(false)
      }
    })

    it('should reject self-transition on submitted', () => {
      expect(isValidTransition('submitted', 'submitted')).toBe(false)
    })
  })

  describe('computeNextInvoiceNumber', () => {
    it('should return 1 when there are no prior invoices', () => {
      expect(computeNextInvoiceNumber([])).toBe(1)
    })

    it('should return max + 1 for sequential invoices', () => {
      const invoices = [
        { fileName: 'Invoice 1.pdf', status: 'paid' },
        { fileName: 'Invoice 2.pdf', status: 'approved' },
      ]
      expect(computeNextInvoiceNumber(invoices)).toBe(3)
    })

    it('should return max + 1 even with gaps in sequence', () => {
      const invoices = [
        { fileName: 'Invoice 1.pdf', status: 'paid' },
        { fileName: 'Invoice 5.pdf', status: 'approved' },
      ]
      expect(computeNextInvoiceNumber(invoices)).toBe(6)
    })

    it('should exclude rejected invoices from the count', () => {
      const invoices = [
        { fileName: 'Invoice 1.pdf', status: 'paid' },
        { fileName: 'Invoice 2.pdf', status: 'rejected' },
        { fileName: 'Invoice 3.pdf', status: 'rejected' },
      ]
      // Only Invoice 1 counts (2 and 3 are rejected)
      expect(computeNextInvoiceNumber(invoices)).toBe(2)
    })

    it('should exclude legacy batched-into invoices from the count', () => {
      const invoices = [
        { fileName: 'Invoice 1.pdf', status: 'paid' },
        { fileName: 'Invoice 4.pdf', status: 'submitted', batchedIntoId: 'batch-abc' },
      ]
      // Only Invoice 1 counts (Invoice 4 is a legacy absorbed component)
      expect(computeNextInvoiceNumber(invoices)).toBe(2)
    })

    it('should handle invoices with non-matching file names', () => {
      const invoices = [
        { fileName: 'random-doc.pdf', status: 'paid' },
        { fileName: 'Invoice 3.pdf', status: 'approved' },
      ]
      // random-doc.pdf yields 0 and is filtered out; only Invoice 3 counts
      expect(computeNextInvoiceNumber(invoices)).toBe(4)
    })

    it('should handle case-insensitive file name matching', () => {
      const invoices = [{ fileName: 'invoice 7.PDF', status: 'paid' }]
      expect(computeNextInvoiceNumber(invoices)).toBe(8)
    })

    it('should return 1 when all invoices are rejected', () => {
      const invoices = [
        { fileName: 'Invoice 1.pdf', status: 'rejected' },
        { fileName: 'Invoice 2.pdf', status: 'rejected' },
        { fileName: 'Invoice 3.pdf', status: 'rejected' },
      ]
      expect(computeNextInvoiceNumber(invoices)).toBe(1)
    })

    it('should return 1 when all invoices are either legacy batched components or rejected', () => {
      const invoices = [
        { fileName: 'Invoice 1.pdf', status: 'rejected' },
        { fileName: 'Invoice 2.pdf', status: 'submitted', batchedIntoId: 'batch-xyz' },
        { fileName: 'Invoice 3.pdf', status: 'rejected' },
        { fileName: 'Invoice 4.pdf', status: 'approved', batchedIntoId: 'batch-abc' },
      ]
      expect(computeNextInvoiceNumber(invoices)).toBe(1)
    })

    it('should ignore invoices with empty fileName', () => {
      const invoices = [{ fileName: '', status: 'paid' }]
      expect(computeNextInvoiceNumber(invoices)).toBe(1)
    })

    it('should ignore invoices with non-matching fileName like receipt.pdf', () => {
      const invoices = [{ fileName: 'receipt.pdf', status: 'paid' }]
      expect(computeNextInvoiceNumber(invoices)).toBe(1)
    })
  })
})
