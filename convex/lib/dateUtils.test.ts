// Pin TZ so the tests produce the same week boundaries regardless of
// the developer's or CI machine's local timezone. getActiveWeekOf relies
// on getMonday's UTC math; this guards against a future revert.
process.env.TZ = 'UTC'

import { describe, test, expect } from 'bun:test'
import { getActiveWeekOf } from './dateUtils'

describe('getActiveWeekOf', () => {
  test('Monday 08:00 UTC (one hour before deadline) → previous Monday', () => {
    expect(getActiveWeekOf(new Date('2026-05-11T08:00:00.000Z'))).toBe('2026-05-04')
  })

  test('Monday 08:59:59 UTC (just before deadline) → previous Monday', () => {
    expect(getActiveWeekOf(new Date('2026-05-11T08:59:59.000Z'))).toBe('2026-05-04')
  })

  test('Monday 09:00:00 UTC (exactly at deadline) → flips to this Monday', () => {
    expect(getActiveWeekOf(new Date('2026-05-11T09:00:00.000Z'))).toBe('2026-05-11')
  })

  test('Monday 10:00 UTC (after deadline) → this Monday', () => {
    expect(getActiveWeekOf(new Date('2026-05-11T10:00:00.000Z'))).toBe('2026-05-11')
  })

  test('Wednesday 12:00 UTC (mid-week) → Monday of the same calendar week', () => {
    expect(getActiveWeekOf(new Date('2026-05-06T12:00:00.000Z'))).toBe('2026-05-04')
  })

  test('Sunday 23:00 UTC (just before new week) → same calendar week Monday', () => {
    expect(getActiveWeekOf(new Date('2026-05-10T23:00:00.000Z'))).toBe('2026-05-04')
  })
})
