'use client'

import { useState, useMemo } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { useQuery, useAction } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { KpiCard } from '@/components/analytics/kpi-card'
import { MetricAreaChart } from '@/components/analytics/metric-area-chart'
import { VelocityScore } from '@/components/analytics/velocity-score'
import { ContributionCalendar } from '@/components/analytics/contribution-calendar'
import { SocialCard } from '@/components/analytics/social-card'
import { GithubTeamStatus } from '@/components/analytics/github-team-status'
import {
  RestrictedContributionsBanner,
  sumRestrictedContributions,
} from '@/components/analytics/restricted-contributions-banner'
import {
  ArrowLeft,
  RefreshCw,
  Plug,
  CreditCard,
  Eye,
  Share2,
  Ship,
  LayoutDashboard,
  Users,
  User,
  ExternalLink,
} from 'lucide-react'
import { toast } from 'sonner'

type AnalyticsTab = 'overview' | 'stripe' | 'traffic' | 'social' | 'shipping'

function computeGrowth(data: Array<{ value: number }> | undefined | null): number {
  if (!data || data.length < 2) return 0
  const recent = data[data.length - 1].value
  const previous = data[Math.max(0, data.length - 8)]?.value ?? data[0].value
  if (previous === 0) return 0
  return ((recent - previous) / previous) * 100
}

function sumLastNDays(data: Array<{ value: number }> | undefined | null, n: number): number {
  if (!data || data.length === 0) return 0
  return data.slice(-n).reduce((sum, d) => sum + d.value, 0)
}

// Rolling 7-day sum vs prior 7-day sum. Right metric for daily counts
// (sessions, pageviews) where comparing two single days is noisy.
// Returns undefined when data has fewer than 14 days — the KpiCard then
// hides the growth indicator instead of showing a misleading "+0.0%".
function computeRolling7dGrowth(
  data: Array<{ value: number }> | undefined | null
): number | undefined {
  if (!data || data.length < 14) return undefined
  const last7 = data.slice(-7).reduce((sum, d) => sum + d.value, 0)
  const prior7 = data.slice(-14, -7).reduce((sum, d) => sum + d.value, 0)
  if (prior7 === 0) return last7 > 0 ? 100 : 0
  return ((last7 - prior7) / prior7) * 100
}

function toSparkline(data: Array<{ value: number }> | undefined | null): Array<{ value: number }> {
  if (!data) return []
  return data.slice(-14).map((d) => ({ value: d.value }))
}

function formatGBP(v: number, decimals = 0): string {
  return `£${v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`
}

export default function AdminStartupAnalyticsPage() {
  const params = useParams()
  const cohortSlug = params.cohortSlug as string
  const slug = params.slug as string

  const [range, setRange] = useState('30')
  const [shippingRange, setShippingRange] = useState('max')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [activeTab, setActiveTab] = useState<AnalyticsTab>('overview')
  // 'team' = whole team with per-founder breakdown, or a founder name for individual view
  const [shippingView, setShippingView] = useState<string>('team')
  const [mountTime] = useState(() => Date.now())

  const startup = useQuery(api.startups.getBySlug, { slug })
  const startupId = startup?._id

  const integrationStatus = useQuery(
    api.integrations.statusForAdmin,
    startupId ? { startupId } : 'skip'
  )

  const startDate = useMemo(() => {
    if (range === 'max') return undefined
    const d = new Date()
    d.setDate(d.getDate() - parseInt(range))
    return d.toISOString()
  }, [range])

  const tsArgs = startupId
    ? { startupId, window: 'daily' as const, ...(startDate ? { startDate } : {}) }
    : null
  const latArgs = startupId ? { startupId, window: 'daily' as const } : null

  // Stripe
  const mrr = useQuery(
    api.metrics.timeSeries,
    tsArgs ? { ...tsArgs, provider: 'stripe' as const, metricKey: 'mrr' } : 'skip'
  )
  const revenue = useQuery(
    api.metrics.timeSeries,
    tsArgs ? { ...tsArgs, provider: 'stripe' as const, metricKey: 'total_revenue' } : 'skip'
  )
  const arr = useQuery(
    api.metrics.getLatest,
    latArgs ? { ...latArgs, provider: 'stripe' as const, metricKey: 'arr' } : 'skip'
  )
  const arpu = useQuery(
    api.metrics.getLatest,
    latArgs ? { ...latArgs, provider: 'stripe' as const, metricKey: 'arpu' } : 'skip'
  )
  const nrr = useQuery(
    api.metrics.getLatest,
    latArgs ? { ...latArgs, provider: 'stripe' as const, metricKey: 'nrr' } : 'skip'
  )
  const ltv = useQuery(
    api.metrics.getLatest,
    latArgs ? { ...latArgs, provider: 'stripe' as const, metricKey: 'ltv' } : 'skip'
  )
  const activeCustomers = useQuery(
    api.metrics.getLatest,
    latArgs ? { ...latArgs, provider: 'stripe' as const, metricKey: 'active_customers' } : 'skip'
  )
  const activeSubscriptions = useQuery(
    api.metrics.getLatest,
    latArgs
      ? { ...latArgs, provider: 'stripe' as const, metricKey: 'active_subscriptions' }
      : 'skip'
  )
  const trialConversion = useQuery(
    api.metrics.getLatest,
    latArgs
      ? { ...latArgs, provider: 'stripe' as const, metricKey: 'trial_conversion_rate' }
      : 'skip'
  )
  const paymentFailure = useQuery(
    api.metrics.getLatest,
    latArgs
      ? { ...latArgs, provider: 'stripe' as const, metricKey: 'payment_failure_rate' }
      : 'skip'
  )
  const churnRate = useQuery(
    api.metrics.getLatest,
    latArgs ? { ...latArgs, provider: 'stripe' as const, metricKey: 'monthly_churn_rate' } : 'skip'
  )

  // Tracker
  const sessions = useQuery(
    api.metrics.timeSeries,
    tsArgs ? { ...tsArgs, provider: 'tracker' as const, metricKey: 'sessions' } : 'skip'
  )
  const pageviews = useQuery(
    api.metrics.timeSeries,
    tsArgs ? { ...tsArgs, provider: 'tracker' as const, metricKey: 'pageviews' } : 'skip'
  )

  // GitHub — always fetch max, filter client-side for instant range switching
  const velocityTimeSeriesRaw = useQuery(
    api.metrics.getVelocityTimeSeries,
    startupId ? { startupId } : 'skip'
  )
  const velocityBreakdown = useQuery(
    api.metrics.getVelocityBreakdown,
    startupId ? { startupId } : 'skip'
  )
  const contributionCalendar = useQuery(
    api.metrics.getContributionCalendar,
    startupId ? { startupId } : 'skip'
  )

  // Per-founder GitHub data — always fetch max, filter client-side
  const velocityPerFounderRaw = useQuery(
    api.metrics.getVelocityTimeSeriesPerFounder,
    startupId ? { startupId } : 'skip'
  )
  const perFounderStats = useQuery(
    api.metrics.getPerFounderGithubStats,
    startupId ? { startupId } : 'skip'
  )

  // Client-side range filtering for instant dropdown switching
  const velocityTimeSeries = useMemo(() => {
    if (!velocityTimeSeriesRaw) return velocityTimeSeriesRaw
    if (shippingRange === 'max') return velocityTimeSeriesRaw
    const cutoff = new Date(mountTime)
    cutoff.setDate(cutoff.getDate() - parseInt(shippingRange))
    const cutoffStr = cutoff.toISOString()
    return velocityTimeSeriesRaw.filter((d) => d.timestamp >= cutoffStr)
  }, [velocityTimeSeriesRaw, shippingRange, mountTime])

  const velocityPerFounder = useMemo(() => {
    if (!velocityPerFounderRaw) return velocityPerFounderRaw
    if (shippingRange === 'max') return velocityPerFounderRaw
    const cutoff = new Date(mountTime)
    cutoff.setDate(cutoff.getDate() - parseInt(shippingRange))
    const cutoffStr = cutoff.toISOString()
    const filtered: Record<string, Array<{ timestamp: string; value: number }>> = {}
    for (const [name, series] of Object.entries(velocityPerFounderRaw)) {
      filtered[name] = series.filter((d) => d.timestamp >= cutoffStr)
    }
    return filtered
  }, [velocityPerFounderRaw, shippingRange, mountTime])

  // Social — latest
  const twitterFollowers = useQuery(
    api.metrics.getLatest,
    latArgs ? { ...latArgs, provider: 'apify' as const, metricKey: 'twitter_followers' } : 'skip'
  )
  const instagramFollowers = useQuery(
    api.metrics.getLatest,
    latArgs ? { ...latArgs, provider: 'apify' as const, metricKey: 'instagram_followers' } : 'skip'
  )
  const linkedinFollowers = useQuery(
    api.metrics.getLatest,
    latArgs ? { ...latArgs, provider: 'apify' as const, metricKey: 'linkedin_followers' } : 'skip'
  )

  // Social — time series
  const twitterFollowerTs = useQuery(
    api.metrics.timeSeries,
    tsArgs ? { ...tsArgs, provider: 'apify' as const, metricKey: 'twitter_followers' } : 'skip'
  )
  const instagramFollowerTs = useQuery(
    api.metrics.timeSeries,
    tsArgs ? { ...tsArgs, provider: 'apify' as const, metricKey: 'instagram_followers' } : 'skip'
  )
  const linkedinFollowerTs = useQuery(
    api.metrics.timeSeries,
    tsArgs ? { ...tsArgs, provider: 'apify' as const, metricKey: 'linkedin_followers' } : 'skip'
  )

  const syncMetrics = useAction(api.metrics.syncMetricsForStartup)

  const handleRefresh = async () => {
    if (!startupId) return
    setIsRefreshing(true)
    try {
      await syncMetrics({ startupId })
      toast.success('Metrics synced')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to sync')
    } finally {
      setIsRefreshing(false)
    }
  }

  const isLoading = startup === undefined || integrationStatus === undefined
  const hasStripe = integrationStatus?.stripe !== null
  const hasTracker = integrationStatus?.tracker !== null
  const hasGithub = integrationStatus?.github !== null
  const hasSocial = (integrationStatus?.social?.length ?? 0) > 0
  const hasAny = hasStripe || hasTracker || hasGithub || hasSocial

  const latestMrr = mrr?.length ? mrr[mrr.length - 1].value : 0
  const sessionsLast7 = sumLastNDays(sessions, 7)
  const pageviewsLast7 = sumLastNDays(pageviews, 7)
  const latestVelocity = velocityTimeSeries?.length
    ? velocityTimeSeries[velocityTimeSeries.length - 1].value
    : 0
  const totalFollowers =
    (twitterFollowers ?? 0) + (instagramFollowers ?? 0) + (linkedinFollowers ?? 0)

  const tabItems: { key: AnalyticsTab; label: string; icon: React.ReactNode }[] = [
    { key: 'overview', label: 'Overview', icon: <LayoutDashboard className="h-4 w-4" /> },
    { key: 'stripe', label: 'Revenue', icon: <CreditCard className="h-4 w-4" /> },
    { key: 'traffic', label: 'Traffic', icon: <Eye className="h-4 w-4" /> },
    { key: 'social', label: 'Social', icon: <Share2 className="h-4 w-4" /> },
    { key: 'shipping', label: 'Shipping', icon: <Ship className="h-4 w-4" /> },
  ]

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-48 mb-2" />
        <div className="grid grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-80 w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-4">
        <Link href={`/admin/${cohortSlug}/startups/${slug}`}>
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Startup
          </Button>
        </Link>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight font-display">Analytics</h1>
            <p className="text-muted-foreground">
              {startup?.name ? `${startup.name} performance metrics` : 'Startup metrics'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative group">
              <Select value={range} onValueChange={setRange} disabled={activeTab === 'shipping'}>
                <SelectTrigger
                  className={`w-[160px] ${activeTab === 'shipping' ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">Last 7 days</SelectItem>
                  <SelectItem value="30">Last 30 days</SelectItem>
                  <SelectItem value="90">Last 3 months</SelectItem>
                  <SelectItem value="180">Last 6 months</SelectItem>
                  <SelectItem value="365">Last 12 months</SelectItem>
                  <SelectItem value="max">Max</SelectItem>
                </SelectContent>
              </Select>
              {activeTab === 'shipping' && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1.5 bg-popover border rounded-md shadow-md text-xs text-muted-foreground whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
                  Shipping has its own time range below
                </div>
              )}
            </div>
            <Button variant="outline" onClick={handleRefresh} disabled={isRefreshing}>
              <RefreshCw className={`h-4 w-4 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
              Sync
            </Button>
          </div>
        </div>
      </div>

      {/* Sync status */}
      {integrationStatus?.stripe?.lastSyncedAt && (
        <p className="text-xs text-muted-foreground">
          Last synced: {new Date(integrationStatus.stripe.lastSyncedAt).toLocaleString()}
          {integrationStatus.stripe.syncError && (
            <span className="text-destructive ml-4">
              Error: {integrationStatus.stripe.syncError}
            </span>
          )}
        </p>
      )}

      {!hasAny && (
        <EmptyState
          icon={<Plug className="h-6 w-6" />}
          title="No integrations connected"
          description="Metrics will appear once the startup connects integrations."
        />
      )}

      {hasAny && (
        <>
          {/* Tabs */}
          <div className="border-b">
            <nav className="flex gap-4">
              {tabItems.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`flex items-center gap-2 px-4 py-3 border-b-2 transition-colors cursor-pointer ${
                    activeTab === tab.key
                      ? 'border-primary text-primary font-medium'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </nav>
          </div>

          {/* ── Overview Tab ──────────────────────────────────── */}
          {activeTab === 'overview' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {hasStripe && (
                  <KpiCard
                    title="MRR"
                    value={formatGBP(latestMrr, 2)}
                    change={computeGrowth(mrr)}
                    sparklineData={toSparkline(mrr)}
                    color="hsl(var(--chart-1))"
                  />
                )}
                {hasTracker && (
                  <KpiCard
                    title="Sessions"
                    subtitle="last 7 days"
                    value={sessionsLast7.toLocaleString()}
                    change={computeRolling7dGrowth(sessions)}
                    changeLabel="vs prior 7 days"
                    sparklineData={toSparkline(sessions)}
                    color="hsl(var(--chart-2))"
                  />
                )}
                {hasGithub && (
                  <KpiCard
                    title="Velocity"
                    value={`${latestVelocity} pts`}
                    change={computeGrowth(velocityTimeSeries)}
                    sparklineData={toSparkline(velocityTimeSeries)}
                    color="hsl(var(--chart-3))"
                  />
                )}
                {hasSocial && (
                  <KpiCard
                    title="Followers"
                    value={totalFollowers.toLocaleString()}
                    color="hsl(var(--chart-4))"
                  />
                )}
              </div>

              {hasStripe && mrr && mrr.length > 0 && (
                <MetricAreaChart
                  title="MRR"
                  description="Monthly recurring revenue"
                  data={mrr.map((d) => ({ timestamp: d.timestamp, value: d.value }))}
                  formatValue={(v) => formatGBP(v)}
                  color="hsl(var(--chart-1))"
                />
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {hasTracker && sessions && sessions.length > 0 && (
                  <MetricAreaChart
                    title="Traffic"
                    data={sessions.map((d) => ({ timestamp: d.timestamp, value: d.value }))}
                    color="hsl(var(--chart-2))"
                    height={250}
                  />
                )}
                {hasGithub && <VelocityScore breakdown={velocityBreakdown?.team ?? null} />}
              </div>

              {hasSocial && integrationStatus?.social && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {integrationStatus.social.map((profile: any) => {
                    const followers =
                      profile.platform === 'twitter'
                        ? (twitterFollowers ?? 0)
                        : profile.platform === 'instagram'
                          ? (instagramFollowers ?? 0)
                          : profile.platform === 'linkedin'
                            ? (linkedinFollowers ?? 0)
                            : 0
                    return (
                      <SocialCard
                        key={profile._id}
                        platform={profile.platform}
                        handle={profile.handle}
                        followers={followers}
                      />
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── Revenue (Stripe) Tab ─────────────────────────── */}
          {activeTab === 'stripe' && (
            <div className="space-y-4">
              {!hasStripe ? (
                <EmptyState
                  icon={<CreditCard className="h-6 w-6" />}
                  title="Stripe not connected"
                  description="Revenue metrics will appear once the startup connects Stripe."
                />
              ) : (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <KpiCard
                      title="MRR"
                      value={formatGBP(latestMrr, 2)}
                      change={computeGrowth(mrr)}
                      sparklineData={toSparkline(mrr)}
                      color="hsl(var(--chart-1))"
                    />
                    <KpiCard title="ARR" value={formatGBP(arr ?? 0)} color="hsl(var(--chart-1))" />
                    <KpiCard
                      title="Active Customers"
                      value={(activeCustomers ?? 0).toLocaleString()}
                      color="hsl(var(--chart-2))"
                    />
                    <KpiCard
                      title="Active Subscriptions"
                      value={(activeSubscriptions ?? 0).toLocaleString()}
                      color="hsl(var(--chart-3))"
                    />
                  </div>

                  {mrr && mrr.length > 0 && (
                    <MetricAreaChart
                      title="Monthly Recurring Revenue"
                      description="MRR from active subscriptions"
                      data={mrr.map((d) => ({ timestamp: d.timestamp, value: d.value }))}
                      formatValue={(v) => formatGBP(v)}
                      color="hsl(var(--chart-1))"
                    />
                  )}

                  {revenue && revenue.length > 0 && (
                    <MetricAreaChart
                      title="Total Revenue"
                      description="Cumulative paid invoice revenue"
                      data={revenue.map((d) => ({ timestamp: d.timestamp, value: d.value }))}
                      formatValue={(v) => formatGBP(v)}
                      color="hsl(var(--chart-2))"
                    />
                  )}

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <Card>
                      <CardContent className="pt-6">
                        <p className="text-sm text-muted-foreground">ARPU</p>
                        <p className="text-xl font-bold">{formatGBP(arpu ?? 0, 2)}</p>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="pt-6">
                        <p className="text-sm text-muted-foreground">NRR</p>
                        <p className="text-xl font-bold">
                          {nrr != null && nrr !== -1 ? `${nrr.toFixed(1)}%` : '—'}
                        </p>
                        {(nrr == null || nrr === -1) && (
                          <p className="text-xs text-muted-foreground">Needs 2+ months</p>
                        )}
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="pt-6">
                        <p className="text-sm text-muted-foreground">LTV</p>
                        <p className="text-xl font-bold">
                          {ltv != null && ltv !== -1 ? formatGBP(ltv) : '—'}
                        </p>
                        {(ltv == null || ltv === -1) && (
                          <p className="text-xs text-muted-foreground">Needs churn data</p>
                        )}
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="pt-6">
                        <p className="text-sm text-muted-foreground">Monthly Churn</p>
                        <p className="text-xl font-bold">
                          {churnRate != null && churnRate !== -1 ? `${churnRate.toFixed(1)}%` : '—'}
                        </p>
                        {(churnRate == null || churnRate === -1) && (
                          <p className="text-xs text-muted-foreground">Needs 2+ months</p>
                        )}
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="pt-6">
                        <p className="text-sm text-muted-foreground">Trial Conversion</p>
                        <p className="text-xl font-bold">
                          {trialConversion != null && trialConversion !== -1
                            ? `${trialConversion.toFixed(1)}%`
                            : '—'}
                        </p>
                        {(trialConversion == null || trialConversion === -1) && (
                          <p className="text-xs text-muted-foreground">No trials detected</p>
                        )}
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="pt-6">
                        <p className="text-sm text-muted-foreground">Payment Failure</p>
                        <p className="text-xl font-bold">
                          {paymentFailure != null && paymentFailure !== -1
                            ? `${paymentFailure.toFixed(1)}%`
                            : '—'}
                        </p>
                        {(paymentFailure == null || paymentFailure === -1) && (
                          <p className="text-xs text-muted-foreground">No invoice data</p>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Traffic Tab ───────────────────────────────────── */}
          {activeTab === 'traffic' && (
            <div className="space-y-4">
              {!hasTracker ? (
                <EmptyState
                  icon={<Eye className="h-6 w-6" />}
                  title="Tracker not set up"
                  description="Traffic data will appear once the startup installs the tracker."
                />
              ) : (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    <KpiCard
                      title="Sessions"
                      subtitle="last 7 days"
                      value={sessionsLast7.toLocaleString()}
                      change={computeRolling7dGrowth(sessions)}
                      changeLabel="vs prior 7 days"
                      sparklineData={toSparkline(sessions)}
                      color="hsl(var(--chart-2))"
                    />
                    <KpiCard
                      title="Pageviews"
                      subtitle="last 7 days"
                      value={pageviewsLast7.toLocaleString()}
                      change={computeRolling7dGrowth(pageviews)}
                      changeLabel="vs prior 7 days"
                      sparklineData={toSparkline(pageviews)}
                      color="hsl(var(--chart-3))"
                    />
                  </div>

                  {sessions && sessions.length > 0 && (
                    <MetricAreaChart
                      title="Sessions"
                      description="Unique sessions per day"
                      data={sessions.map((d) => ({ timestamp: d.timestamp, value: d.value }))}
                      color="hsl(var(--chart-2))"
                    />
                  )}

                  {pageviews && pageviews.length > 0 && (
                    <MetricAreaChart
                      title="Pageviews"
                      description="Total page views per day"
                      data={pageviews.map((d) => ({ timestamp: d.timestamp, value: d.value }))}
                      color="hsl(var(--chart-3))"
                    />
                  )}
                </>
              )}
            </div>
          )}

          {/* ── Social Tab ────────────────────────────────────── */}
          {activeTab === 'social' && (
            <div className="space-y-4">
              {!hasSocial ? (
                <EmptyState
                  icon={<Share2 className="h-6 w-6" />}
                  title="No social profiles"
                  description="Social data will appear once the startup adds their handles."
                />
              ) : (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {integrationStatus?.social?.map((profile: any) => {
                      const followers =
                        profile.platform === 'twitter'
                          ? (twitterFollowers ?? 0)
                          : profile.platform === 'instagram'
                            ? (instagramFollowers ?? 0)
                            : profile.platform === 'linkedin'
                              ? (linkedinFollowers ?? 0)
                              : 0
                      return (
                        <SocialCard
                          key={profile._id}
                          platform={profile.platform}
                          handle={profile.handle}
                          followers={followers}
                        />
                      )
                    })}
                  </div>

                  {twitterFollowerTs && twitterFollowerTs.length > 0 && (
                    <MetricAreaChart
                      title="X (Twitter) Followers"
                      data={twitterFollowerTs.map((d) => ({
                        timestamp: d.timestamp,
                        value: d.value,
                      }))}
                      color="#000000"
                    />
                  )}
                  {linkedinFollowerTs && linkedinFollowerTs.length > 0 && (
                    <MetricAreaChart
                      title="LinkedIn Followers"
                      data={linkedinFollowerTs.map((d) => ({
                        timestamp: d.timestamp,
                        value: d.value,
                      }))}
                      color="#0a66c2"
                    />
                  )}
                  {instagramFollowerTs && instagramFollowerTs.length > 0 && (
                    <MetricAreaChart
                      title="Instagram Followers"
                      data={instagramFollowerTs.map((d) => ({
                        timestamp: d.timestamp,
                        value: d.value,
                      }))}
                      color="#e1306c"
                    />
                  )}
                </>
              )}
            </div>
          )}

          {/* ── Shipping Tab ──────────────────────────────────── */}
          {activeTab === 'shipping' && (
            <div className="space-y-4">
              {!hasGithub ? (
                <EmptyState
                  icon={<Ship className="h-6 w-6" />}
                  title="GitHub not connected"
                  description="Shipping data will appear once the startup connects GitHub."
                />
              ) : (
                <>
                  <RestrictedContributionsBanner
                    restrictedCount={sumRestrictedContributions(perFounderStats)}
                  />
                  {/* GitHub connection overview */}
                  {integrationStatus?.founders && integrationStatus.founders.length > 0 && (
                    <GithubTeamStatus
                      founders={integrationStatus.founders}
                      githubConnections={integrationStatus.githubConnections ?? []}
                    />
                  )}

                  {/* Team / Per Founder selector */}
                  {(integrationStatus?.githubConnections?.length ?? 0) > 1 && (
                    <div className="flex items-center gap-2">
                      <Select value={shippingView} onValueChange={setShippingView}>
                        <SelectTrigger className="w-[200px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="team">
                            <span className="flex items-center gap-1.5">
                              <Users className="h-3.5 w-3.5" />
                              Whole Team
                            </span>
                          </SelectItem>
                          {integrationStatus?.githubConnections?.map((conn) => (
                            <SelectItem key={conn._id} value={conn.accountName ?? conn._id}>
                              <span className="flex items-center gap-1.5">
                                <User className="h-3.5 w-3.5" />@{conn.accountName ?? 'Unknown'}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {shippingView !== 'team' &&
                        integrationStatus?.githubConnections?.some(
                          (conn) => conn.accountName === shippingView
                        ) && (
                          <Button asChild variant="ghost" size="icon" title="Open GitHub profile">
                            <a
                              href={`https://github.com/${shippingView}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label="Open GitHub profile"
                            >
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          </Button>
                        )}
                    </div>
                  )}

                  <VelocityScore
                    breakdown={
                      shippingView !== 'team' && velocityBreakdown?.perFounder?.[shippingView]
                        ? velocityBreakdown.perFounder[shippingView]
                        : (velocityBreakdown?.team ?? null)
                    }
                    perFounderBreakdown={
                      shippingView === 'team' ? velocityBreakdown?.perFounder : undefined
                    }
                  />

                  <MetricAreaChart
                    title="Shipping Activity"
                    description="Daily velocity score — 4-week rolling window with temporal decay"
                    data={
                      shippingView !== 'team' && velocityPerFounder?.[shippingView]
                        ? velocityPerFounder[shippingView]
                        : (velocityTimeSeries ?? []).map((d) => ({
                            timestamp: d.timestamp,
                            value: d.value,
                          }))
                    }
                    color="hsl(var(--chart-3))"
                    formatValue={(v) => `${v.toLocaleString()} pts`}
                    range={shippingRange}
                    onRangeChange={setShippingRange}
                    rangeOptions={[
                      { value: '7', label: 'Last 7 days' },
                      { value: '30', label: 'Last 30 days' },
                      { value: '90', label: 'Last 3 months' },
                      { value: '180', label: 'Last 6 months' },
                      { value: '365', label: 'Last 12 months' },
                      { value: 'max', label: 'Max' },
                    ]}
                    multiSeries={
                      shippingView === 'team' && velocityPerFounder ? velocityPerFounder : undefined
                    }
                  />

                  {shippingView === 'team' && (
                    <ContributionCalendar
                      weeks={contributionCalendar ?? []}
                      title={
                        (integrationStatus?.githubConnections?.length ?? 0) > 1
                          ? 'Team Contribution Calendar'
                          : undefined
                      }
                    />
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
