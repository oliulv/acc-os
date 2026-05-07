import { Card, CardContent } from '@/components/ui/card'

export const CATEGORY_COLORS: Record<string, string> = {
  revenue: 'bg-emerald-500',
  traffic: 'bg-blue-500',
  github: 'bg-purple-500',
  updates: 'bg-orange-500',
}

export const CATEGORY_LABELS: Record<string, string> = {
  revenue: 'MRR',
  traffic: 'Traffic',
  github: 'GitHub',
  updates: 'Updates',
}

export const CATEGORY_WEIGHTS: Record<string, number> = {
  revenue: 35,
  traffic: 25,
  github: 25,
  updates: 15,
}

const CATEGORY_DETAILS: Record<string, { signal: string; measurement: string; example: string }> = {
  revenue: {
    signal: 'Monthly Recurring Revenue growth',
    measurement:
      'Your MRR from Stripe subscriptions. We snapshot it each week and compare to last week to measure momentum — MRR itself is always a monthly figure.',
    example: 'If your MRR was £5,000 last week and £6,000 this week, that is 20% growth.',
  },
  traffic: {
    signal: 'Session growth rate',
    measurement: 'Week-over-week % change in unique sessions from your website tracker',
    example: 'Doubling visitors in a week scores higher than steady high traffic',
  },
  github: {
    signal: 'Shipping velocity',
    measurement:
      'Commits (10 pts) + PRs opened (25 pts) + Issues (15 pts), 4-week rolling window with daily temporal decay',
    example: '5 commits + 2 PRs + 1 issue = 115 pts raw for that day, decayed by recency',
  },
  updates: {
    signal: 'Weekly update submitted',
    measurement:
      'Binary (submitted or not) + streak bonus: +10% per consecutive week, up to +80% at 8 weeks',
    example: 'Submit every week for 8 weeks = nearly double the base score',
  },
}

export function ScoringExplainerContent() {
  return (
    <Card>
      <CardContent className="pt-6 space-y-6">
        {/* Category breakdown table */}
        <div>
          <h3 className="font-semibold mb-3">How each category is scored</h3>
          <div className="border overflow-hidden">
            <table className="min-w-full text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground w-28">
                    Category
                  </th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground w-16">
                    Weight
                  </th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                    What we measure
                  </th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground hidden md:table-cell">
                    Example
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {Object.entries(CATEGORY_DETAILS).map(([key, detail]) => (
                  <tr key={key}>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className={`h-2.5 w-2.5 shrink-0 ${CATEGORY_COLORS[key]}`} />
                        <span className="font-medium">{CATEGORY_LABELS[key]}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">{CATEGORY_WEIGHTS[key]}%</td>
                    <td className="px-3 py-2.5">
                      <p className="font-medium text-xs text-muted-foreground mb-0.5">
                        {detail.signal}
                      </p>
                      <p>{detail.measurement}</p>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground hidden md:table-cell">
                      {detail.example}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            <strong>Only active Stripe subscriptions count toward MRR.</strong> One-off payments,
            invoices, consulting revenue, usage-based billing, and anything outside Stripe
            subscriptions are not tracked on the leaderboard.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            <strong>Growth-only.</strong> Every week of positive growth earns points. A flat or
            declining week earns 0 — never negative. A bad week can&apos;t erase points an earlier
            growth week earned. Time still erodes them via decay.
          </p>
        </div>

        {/* Scoring mechanics */}
        <div>
          <h3 className="font-semibold mb-3">How your score is calculated</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="border p-3 space-y-1">
              <h4 className="font-medium text-sm">Rolling 4-Week Window</h4>
              <p className="text-sm text-muted-foreground">
                Only the last 4 weeks of activity count. Old work expires so the leaderboard
                reflects who is shipping <em>now</em>.
              </p>
            </div>
            <div className="border p-3 space-y-1">
              <h4 className="font-medium text-sm">Temporal Decay</h4>
              <p className="text-sm text-muted-foreground">
                Recent activity is worth more. This week = 100%, last week = ~81%, 2 weeks ago =
                ~66%, 3 weeks ago = ~53%.
              </p>
            </div>
            <div className="border p-3 space-y-1">
              <h4 className="font-medium text-sm">Qualification Gate</h4>
              <p className="text-sm text-muted-foreground">
                Need data in at least 3 of 4 categories to earn the &quot;Qualified&quot; tag (extra
                funding eligibility). Categories you haven&apos;t connected are simply excluded
                &mdash; no penalty.
              </p>
            </div>
            <div className="border p-3 space-y-1">
              <h4 className="font-medium text-sm">Admin Favorite</h4>
              <p className="text-sm text-muted-foreground">
                The admin picks up to 2 favorite updates per week. Favoriting gives the startup a
                small score boost that fades over the next 28 days &mdash; recent favorites matter
                more, and multiple favorites in the window stack.
              </p>
            </div>
            <div className="border p-3 space-y-1">
              <h4 className="font-medium text-sm">Rank Change Arrows</h4>
              <p className="text-sm text-muted-foreground">
                Shows whether your rank moved up or down compared to last week. Green arrow = you
                climbed, red arrow = you dropped.
              </p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
