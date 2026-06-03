import { describe, test, expect } from 'bun:test'
import { isStorageIdOnInvoice } from './invoiceAccess'

describe('isStorageIdOnInvoice', () => {
  test('matches the primary storageId', () => {
    expect(isStorageIdOnInvoice({ storageId: 's1' }, 's1')).toBe(true)
  })

  test('matches the legacy single receiptStorageId', () => {
    expect(isStorageIdOnInvoice({ storageId: 's1', receiptStorageId: 'r1' }, 'r1')).toBe(true)
  })

  test('matches any entry in receiptStorageIds', () => {
    const inv = { storageId: 's1', receiptStorageIds: ['r1', 'r2', 'r3'] }
    expect(isStorageIdOnInvoice(inv, 'r2')).toBe(true)
    expect(isStorageIdOnInvoice(inv, 'r3')).toBe(true)
  })

  test('matches any entry in originalInvoiceStorageIds for legacy batched invoices', () => {
    const inv = { storageId: 's1', originalInvoiceStorageIds: ['o1', 'o2'] }
    expect(isStorageIdOnInvoice(inv, 'o2')).toBe(true)
  })

  test('rejects unrelated storageId', () => {
    const inv = {
      storageId: 's1',
      receiptStorageId: 'r1',
      receiptStorageIds: ['r2'],
      originalInvoiceStorageIds: ['o1'],
    }
    expect(isStorageIdOnInvoice(inv, 'foreign')).toBe(false)
    expect(isStorageIdOnInvoice(inv, '')).toBe(false)
  })
})
