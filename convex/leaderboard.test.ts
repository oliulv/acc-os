import { describe, it, expect } from 'bun:test'
import {
  assembleCategoryRaw,
  assignRanks,
  deriveFavorites,
  type StartupRawData,
} from './leaderboard'
import { ROLLING_WEEKS, computeVelocityScore } from './lib/scoring'

// ── Fixture helpers ──────────────────────────────────────────────────

const NOW = new Date('2026-04-21T12:00:00.000Z')

// Week 0 (current): starts Mon 2026-04-20 UTC. Each week is 7 days earlier.
// We build ROLLING_WEEKS + 1 = 5 weeks for assembleCategoryRaw.
function buildWeeks(count: number) {
  const weeks: Array<{ start: Date; end: Date; weekOf: string }> = []
  // Start from the Monday of NOW week and walk back.
  const weekZeroMonday = '2026-04-20'
  for (let i = 0; i < count; i++) {
    const start = new Date(`${weekZeroMonday}T00:00:00.000Z`)
    start.setUTCDate(start.getUTCDate() - i * 7)
    const end = new Date(start)
    end.setUTCDate(end.getUTCDate() + 7)
    const weekOf = start.toISOString().slice(0, 10)
    weeks.push({ start, end, weekOf })
  }
  return weeks
}

function emptyRaw(overrides: Partial<StartupRawData> = {}): StartupRawData {
  return {
    startup: { _id: 'startups:empty' as any, name: 'Empty', cohortId: 'cohorts:c1' as any } as any,
    mrrMetrics: [],
    sessionMetrics: [],
    velocityCalendar: {},
    weeklyUpdates: [],
    ...overrides,
  }
}

function mrrSnapshot(isoTimestamp: string, value: number): any {
  return { timestamp: isoTimestamp, value }
}

function sessionEvent(isoTimestamp: string, value: number): any {
  return { timestamp: isoTimestamp, value }
}

// ── assembleCategoryRaw ──────────────────────────────────────────────

describe('assembleCategoryRaw', () => {
  it('1. empty raw → all perCatRaw = 0, all perCatActive = false', () => {
    const weeks = buildWeeks(ROLLING_WEEKS + 1)
    const result = assembleCategoryRaw(emptyRaw(), weeks, NOW)
    for (const key of ['revenue', 'traffic', 'github', 'updates'] as const) {
      expect(result.perCatRaw[key]).toBe(0)
      expect(result.perCatActive[key]).toBe(false)
    }
    expect(result.updateStreak).toBe(0)
  })

  it('2. revenue: MRR snapshot > 0 within window → active, raw non-zero', () => {
    const weeks = buildWeeks(ROLLING_WEEKS + 1)
    // Last week's MRR = 100; previous week's MRR = 50 → +100% growth
    const thisWeekTs = new Date(weeks[0].start.getTime() + 86400_000).toISOString() // Tue
    const prevWeekTs = new Date(weeks[1].start.getTime() + 86400_000).toISOString()
    const raw = emptyRaw({
      mrrMetrics: [mrrSnapshot(thisWeekTs, 100), mrrSnapshot(prevWeekTs, 50)] as any,
    })
    const result = assembleCategoryRaw(raw, weeks, NOW)
    expect(result.perCatActive.revenue).toBe(true)
    expect(result.perCatRaw.revenue).toBeGreaterThan(0)
  })

  it('3. revenue: all MRR snapshots older than 28d → inactive, raw = 0', () => {
    const weeks = buildWeeks(ROLLING_WEEKS + 1)
    // Snapshot 60 days ago — outside window
    const oldTs = new Date(NOW.getTime() - 60 * 86400_000).toISOString()
    const raw = emptyRaw({
      mrrMetrics: [mrrSnapshot(oldTs, 500)] as any,
    })
    const result = assembleCategoryRaw(raw, weeks, NOW)
    expect(result.perCatActive.revenue).toBe(false)
    expect(result.perCatRaw.revenue).toBe(0)
  })

  it('4. traffic: sessions > 0 in current week → active, raw reflects growth', () => {
    const weeks = buildWeeks(ROLLING_WEEKS + 1)
    const thisWeekTs = new Date(weeks[0].start.getTime() + 86400_000).toISOString()
    const prevWeekTs = new Date(weeks[1].start.getTime() + 86400_000).toISOString()
    const raw = emptyRaw({
      sessionMetrics: [sessionEvent(thisWeekTs, 200), sessionEvent(prevWeekTs, 100)] as any,
    })
    const result = assembleCategoryRaw(raw, weeks, NOW)
    expect(result.perCatActive.traffic).toBe(true)
    expect(result.perCatRaw.traffic).toBeGreaterThan(0)
  })

  it('5. github: single commit 3 days ago → active, raw matches computeVelocityScore', () => {
    const weeks = buildWeeks(ROLLING_WEEKS + 1)
    const threeDaysAgo = new Date(NOW.getTime() - 3 * 86400_000)
    threeDaysAgo.setUTCHours(0, 0, 0, 0)
    const dateStr = threeDaysAgo.toISOString().slice(0, 10)
    const calendar = { [dateStr]: { commits: 1, prs: 0, issues: 0 } }
    const raw = emptyRaw({ velocityCalendar: calendar })
    const result = assembleCategoryRaw(raw, weeks, NOW)
    expect(result.perCatActive.github).toBe(true)
    expect(result.perCatRaw.github).toBe(computeVelocityScore(calendar, NOW))
  })

  it('5b. github off-by-one: commit day 27 → active; commit day 28 → inactive', () => {
    // Loop iterates `daysAgo < ACTIVE_WINDOW_DAYS` (28), so day 27 is the
    // last included day. Pins this boundary so a future refactor can't
    // silently flip the off-by-one.
    const weeks = buildWeeks(ROLLING_WEEKS + 1)
    const dayAt = (daysAgo: number) => {
      const d = new Date(NOW.getTime())
      d.setUTCHours(0, 0, 0, 0)
      d.setUTCDate(d.getUTCDate() - daysAgo)
      return d.toISOString().slice(0, 10)
    }
    const cal27 = { [dayAt(27)]: { commits: 1, prs: 0, issues: 0 } }
    const cal28 = { [dayAt(28)]: { commits: 1, prs: 0, issues: 0 } }
    expect(
      assembleCategoryRaw(emptyRaw({ velocityCalendar: cal27 }), weeks, NOW).perCatActive.github
    ).toBe(true)
    expect(
      assembleCategoryRaw(emptyRaw({ velocityCalendar: cal28 }), weeks, NOW).perCatActive.github
    ).toBe(false)
  })

  it('4b. revenue: zero-to-positive growth week (prev=0, cur>0) → growth=+100 contributes', () => {
    // computeGrowthRate returns +100 (capped at zero-to-positive). The
    // decayed sum should include it; guards against a regression that
    // treats the null-growth-both-zero case the same as zero-to-positive.
    const weeks = buildWeeks(ROLLING_WEEKS + 1)
    const thisWeekTs = new Date(weeks[0].start.getTime() + 86400_000).toISOString()
    // No MRR snapshot in the prev week → prevMrr = 0, this week = 500
    const raw = emptyRaw({
      mrrMetrics: [mrrSnapshot(thisWeekTs, 500)] as any,
    })
    const result = assembleCategoryRaw(raw, weeks, NOW)
    expect(result.perCatActive.revenue).toBe(true)
    expect(result.perCatRaw.revenue).toBeGreaterThan(99)
    expect(result.perCatRaw.revenue).toBeLessThanOrEqual(100)
  })

  it('6. updates: 4 consecutive submitted weeks → active, raw > 0, streak matches', () => {
    const weeks = buildWeeks(ROLLING_WEEKS + 1)
    const updates = weeks.slice(0, 4).map((w, i) => ({
      weekOf: w.weekOf,
      isFavorite: false,
      _creationTime: w.start.getTime() + 86400_000 * i,
    })) as any
    const raw = emptyRaw({ weeklyUpdates: updates })
    const result = assembleCategoryRaw(raw, weeks, NOW)
    expect(result.perCatActive.updates).toBe(true)
    expect(result.perCatRaw.updates).toBeGreaterThan(0)
  })

  // ── T3: traffic/updates inactive-side tests (mirrors #3 for revenue) ──

  it('12. traffic: all session events older than 28d → inactive, raw = 0', () => {
    const weeks = buildWeeks(ROLLING_WEEKS + 1)
    const oldTs = new Date(NOW.getTime() - 60 * 86400_000).toISOString()
    const raw = emptyRaw({
      sessionMetrics: [sessionEvent(oldTs, 500)] as any,
    })
    const result = assembleCategoryRaw(raw, weeks, NOW)
    expect(result.perCatActive.traffic).toBe(false)
    expect(result.perCatRaw.traffic).toBe(0)
  })

  it('14. growth-only: declining traffic week earns 0 points, not negative', () => {
    // Casero-style scenario: huge spike 3 weeks ago, traffic returned to
    // baseline. Old behavior summed negative growth, dragging trafficRaw
    // negative for ~4 weeks. New behavior: declines earn 0, only positive
    // weeks contribute. The +22% wk0 growth must produce strictly positive raw.
    const weeks = buildWeeks(ROLLING_WEEKS + 1)
    // Real-shape input: 7 daily rows per week. Catches week-bucketing bugs
    // a single per-week aggregate would miss.
    const dailyRows = (weekIdx: number, total: number) => {
      const perDay = total / 7
      return Array.from({ length: 7 }, (_, day) =>
        sessionEvent(
          new Date(weeks[weekIdx].start.getTime() + day * 86400_000).toISOString(),
          perDay
        )
      )
    }
    // wk0=93, wk1=76, wk2=105, wk3=1635, wk4=795 (matches Casero prod data)
    const raw = emptyRaw({
      sessionMetrics: [
        ...dailyRows(0, 93),
        ...dailyRows(1, 76),
        ...dailyRows(2, 105),
        ...dailyRows(3, 1635),
        ...dailyRows(4, 795),
      ] as any,
    })
    const result = assembleCategoryRaw(raw, weeks, NOW)
    expect(result.perCatActive.traffic).toBe(true)
    // Only growth weeks contribute. wk0 vs wk1 = +22.4% (×1.0).
    // wk3 vs wk4 = +105.7% (×decay). Negative weeks earn 0.
    // Pin the exact value so a future change to the model can't silently
    // shift this without updating the expectation.
    expect(result.perCatRaw.traffic).toBeCloseTo(78.4, 0)
  })

  it('15. growth-only: revenue decline does not drag the score below zero', () => {
    const weeks = buildWeeks(ROLLING_WEEKS + 1)
    const ts = (i: number) => new Date(weeks[i].start.getTime() + 86400_000).toISOString()
    // MRR halves every week — every comparison is negative.
    const raw = emptyRaw({
      mrrMetrics: [
        mrrSnapshot(ts(0), 100),
        mrrSnapshot(ts(1), 200),
        mrrSnapshot(ts(2), 400),
        mrrSnapshot(ts(3), 800),
        mrrSnapshot(ts(4), 1600),
      ] as any,
    })
    const result = assembleCategoryRaw(raw, weeks, NOW)
    expect(result.perCatActive.revenue).toBe(true)
    expect(result.perCatRaw.revenue).toBe(0)
  })

  it('13. updates: submitted update only outside window → inactive, raw = 0', () => {
    const weeks = buildWeeks(ROLLING_WEEKS + 1)
    // Build weeks extends back 5 weeks; add a 6-weeks-ago weekOf that
    // doesn't match any weeks[i] in the rolling window.
    const farMonday = new Date(`${weeks[0].weekOf}T00:00:00.000Z`)
    farMonday.setUTCDate(farMonday.getUTCDate() - 6 * 7)
    const farWeekOf = farMonday.toISOString().slice(0, 10)
    const raw = emptyRaw({
      weeklyUpdates: [{ weekOf: farWeekOf, isFavorite: false }] as any,
    })
    const result = assembleCategoryRaw(raw, weeks, NOW)
    expect(result.perCatActive.updates).toBe(false)
    expect(result.perCatRaw.updates).toBe(0)
  })
})

// ── deriveFavorites ──────────────────────────────────────────────────

describe('deriveFavorites', () => {
  it('empty list → count 0, hasAny false', () => {
    const result = deriveFavorites([], NOW)
    expect(result.favorites).toHaveLength(0)
    expect(result.count).toBe(0)
    expect(result.hasAny).toBe(false)
  })

  it('favorites outside 28-day window are excluded', () => {
    const weekOfOld = '2026-01-01' // > 28 days ago
    const weekOfRecent = '2026-04-13'
    const result = deriveFavorites(
      [
        { weekOf: weekOfOld, isFavorite: true },
        { weekOf: weekOfRecent, isFavorite: true },
      ],
      NOW
    )
    expect(result.count).toBe(1)
    expect(result.hasAny).toBe(true)
    expect(result.favorites[0].daysAgo).toBeLessThanOrEqual(28)
  })

  it('non-favorite updates are ignored', () => {
    const result = deriveFavorites(
      [
        { weekOf: '2026-04-13', isFavorite: false },
        { weekOf: '2026-04-06', isFavorite: undefined },
      ],
      NOW
    )
    expect(result.count).toBe(0)
  })

  it('favorite exactly 28 days ago is included (boundary is inclusive)', () => {
    // deriveFavorites uses `daysAgo <= FAVORITE_WINDOW_DAYS` (inclusive),
    // then the scorer's own clamp further filters. Lock the boundary here.
    const twentyEightDaysAgo = new Date(NOW.getTime() - 28 * 86400_000)
    // Set the weekOf to a date that's exactly 28 days before NOW at midnight.
    const weekOfStr = twentyEightDaysAgo.toISOString().slice(0, 10)
    const result = deriveFavorites([{ weekOf: weekOfStr, isFavorite: true }], NOW)
    // daysAgo may be slightly less than 28 depending on time-of-day rounding.
    expect(result.count).toBe(1)
  })

  it('malformed weekOf is skipped, not thrown', () => {
    expect(() =>
      deriveFavorites(
        [
          { weekOf: 'not-a-date', isFavorite: true },
          { weekOf: '', isFavorite: true },
        ],
        NOW
      )
    ).not.toThrow()
    const result = deriveFavorites(
      [
        { weekOf: 'not-a-date', isFavorite: true },
        { weekOf: '', isFavorite: true },
      ],
      NOW
    )
    expect(result.count).toBe(0)
  })

  it('future weekOf (negative daysAgo) is included by deriveFavorites; scorer clamps', () => {
    // deriveFavorites itself doesn't filter negative daysAgo; it passes them
    // through to the scorer where Math.max(0, daysAgo) clamps. This test
    // pins that contract so a future change can't silently drop future-dated
    // rows at the collection boundary.
    const oneDayFuture = new Date(NOW.getTime() + 86400_000).toISOString().slice(0, 10)
    const result = deriveFavorites([{ weekOf: oneDayFuture, isFavorite: true }], NOW)
    expect(result.count).toBe(1)
    expect(result.favorites[0].daysAgo).toBeLessThan(0)
  })
})

// ── assignRanks ──────────────────────────────────────────────────────

describe('assignRanks', () => {
  it('1. normal case: 3 startups, all in both maps → rankings correct, rankChange correct sign', () => {
    // Current: A=50, B=30, C=10 → ranks A=1, B=2, C=3
    // Previous: A=10, B=30, C=50 → ranks C=1, B=2, A=3
    // rankChange (prev - current): A = 3-1 = +2 (moved up), B = 2-2 = 0, C = 1-3 = -2
    const current = new Map([
      ['A', 50],
      ['B', 30],
      ['C', 10],
    ])
    const prev = new Map([
      ['A', 10],
      ['B', 30],
      ['C', 50],
    ])
    const qualified = new Set(['A', 'B', 'C'])
    const { rankings, rankChangeByStartup } = assignRanks(current, prev, qualified)
    expect(rankings.get('A')).toBe(1)
    expect(rankings.get('B')).toBe(2)
    expect(rankings.get('C')).toBe(3)
    expect(rankChangeByStartup.get('A')).toBe(2)
    expect(rankChangeByStartup.get('B')).toBe(0)
    expect(rankChangeByStartup.get('C')).toBe(-2)
  })

  it('2. empty prev → all rankChange = null', () => {
    const current = new Map([
      ['A', 50],
      ['B', 30],
    ])
    const prev = new Map<string, number>()
    const qualified = new Set(['A', 'B'])
    const { rankings, rankChangeByStartup } = assignRanks(current, prev, qualified)
    expect(rankings.size).toBe(2)
    expect(rankChangeByStartup.get('A')).toBeNull()
    expect(rankChangeByStartup.get('B')).toBeNull()
  })

  it('3. new startup appears only in current → rankChange = null for it', () => {
    const current = new Map([
      ['A', 50],
      ['B', 30],
      ['NEW', 20],
    ])
    const prev = new Map([
      ['A', 40],
      ['B', 20],
    ])
    const qualified = new Set(['A', 'B', 'NEW'])
    const { rankings, rankChangeByStartup } = assignRanks(current, prev, qualified)
    expect(rankings.get('NEW')).toBe(3)
    expect(rankChangeByStartup.get('NEW')).toBeNull()
    // A and B have prev ranks, so rankChange should be numeric
    expect(typeof rankChangeByStartup.get('A')).toBe('number')
    expect(typeof rankChangeByStartup.get('B')).toBe('number')
  })

  it('4. unqualified startup (not in qualified set) is not ranked', () => {
    const current = new Map([
      ['A', 50],
      ['B', 30],
      ['X', 100], // highest score but not qualified (e.g. excludeFromMetrics)
    ])
    const prev = new Map([
      ['A', 40],
      ['B', 20],
      ['X', 200],
    ])
    const qualified = new Set(['A', 'B']) // X not in set
    const { rankings, rankChangeByStartup } = assignRanks(current, prev, qualified)
    expect(rankings.has('X')).toBe(false)
    expect(rankChangeByStartup.has('X')).toBe(false)
    expect(rankings.get('A')).toBe(1)
    expect(rankings.get('B')).toBe(2)
  })
})
