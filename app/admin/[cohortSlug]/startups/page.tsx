'use client'

import { useParams, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { useQuery, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Plus,
  Building2,
  Edit,
  BarChart3,
  ExternalLink,
  Flame,
  ChevronDown,
  ChevronUp,
  Info,
  Settings2,
} from 'lucide-react'
import { useState, useMemo, useEffect } from 'react'
import { toast } from 'sonner'
import { RankChangeArrow } from '@/components/leaderboard/momentum-arrow'
import {
  ScoringExplainerContent,
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  CATEGORY_WEIGHTS,
} from '@/components/leaderboard/scoring-explainer'
import { cn } from '@/lib/utils'

function formatCompactCurrency(value: number): string {
  if (value >= 1000) return `£${(value / 1000).toFixed(1)}k`
  return `£${value.toLocaleString('en-GB')}`
}

function FundingMiniBar({
  unlocked,
  deployed,
  total,
}: {
  unlocked: number
  deployed: number
  total: number
}) {
  if (total <= 0) return <span className="text-xs text-muted-foreground">—</span>
  const unlockedPct = Math.min(100, (unlocked / total) * 100)
  const deployedPct = Math.min(100, (deployed / total) * 100)
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-2 w-20 overflow-hidden bg-muted">
        <div
          className="absolute inset-y-0 left-0 bg-emerald-500/30"
          style={{ width: `${unlockedPct}%` }}
        />
        <div
          className="absolute inset-y-0 left-0 bg-blue-600"
          style={{ width: `${deployedPct}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {formatCompactCurrency(unlocked)}
      </span>
    </div>
  )
}

function IntegrationDots({
  status,
}: {
  status?: { stripe: boolean; github: boolean; tracker: boolean }
}) {
  if (!status) return null
  const dots = [
    { key: 'stripe', label: 'Stripe', connected: status.stripe },
    { key: 'github', label: 'GitHub', connected: status.github },
    { key: 'tracker', label: 'Tracker', connected: status.tracker },
  ]
  return (
    <div className="flex items-center gap-1.5">
      {dots.map((dot) => (
        <div
          key={dot.key}
          title={`${dot.label}: ${dot.connected ? 'Connected' : 'Not connected'}`}
          className={cn('h-2 w-2 rounded-full', dot.connected ? 'bg-emerald-500' : 'bg-muted')}
        />
      ))}
    </div>
  )
}

function explainZeroScore(
  key: string,
  cat: { raw: number; normalized: number; weighted: number; active: boolean }
): string {
  const trackingNoun: Record<string, string> = {
    revenue: 'MRR',
    traffic: 'sessions',
    github: 'commits, PRs, or issues',
    updates: 'a weekly update',
  }
  const noun = trackingNoun[key] ?? 'data'
  if (!cat.active) {
    return `No ${noun} in the last 28 days, so this category isn't scored yet.`
  }
  return 'Tracked, but no week-over-week growth in the last 4 weeks. Growth weeks earn points; flat or down weeks earn 0.'
}

function ScoreBar({ value, maxValue, color }: { value: number; maxValue: number; color: string }) {
  const width = maxValue > 0 ? Math.min((value / maxValue) * 100, 100) : 0
  return (
    <div className="h-2 w-full bg-muted overflow-hidden">
      <div
        className={`h-full ${color} transition-all duration-500`}
        style={{ width: `${width}%` }}
      />
    </div>
  )
}

function ExpandableRow({
  entry,
  maxScore,
  cohortSlug,
  router,
}: {
  entry: any
  maxScore: number
  cohortSlug: string
  router: ReturnType<typeof useRouter>
}) {
  const [expanded, setExpanded] = useState(false)
  const href = `/admin/${cohortSlug}/startups/${entry.startupSlug ?? entry.startupId}`

  return (
    <>
      <tr
        className={`cursor-pointer hover:bg-muted/50 transition-colors ${
          entry.excludeFromMetrics ? 'opacity-50' : ''
        }`}
        onClick={() => setExpanded(!expanded)}
      >
        <td className="px-4 py-3 whitespace-nowrap text-sm font-medium">
          {entry.rank ? (
            <span className="inline-flex h-7 w-7 items-center justify-center bg-primary text-primary-foreground text-xs font-bold">
              {entry.rank}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
        <td className="px-4 py-3 whitespace-nowrap">
          <div className="flex items-center gap-3">
            {entry.startupLogoUrl && (
              <Image
                src={entry.startupLogoUrl}
                alt={entry.startupName}
                width={32}
                height={32}
                className="h-8 w-8 rounded-full"
              />
            )}
            <span className="text-sm font-medium">{entry.startupName}</span>
            {entry.excludeFromMetrics && (
              <Badge variant="warning" className="text-xs">
                Excluded
              </Badge>
            )}
          </div>
        </td>
        <td className="px-4 py-3">
          <div className="flex gap-1 items-center">
            {Object.entries(entry.categories).map(([key, cat]: [string, any]) => (
              <div
                key={key}
                className="w-12"
                title={`${CATEGORY_LABELS[key]}: ${cat.weighted.toFixed(1)}`}
              >
                <ScoreBar
                  value={cat.weighted}
                  maxValue={maxScore * 0.4}
                  color={CATEGORY_COLORS[key]}
                />
              </div>
            ))}
          </div>
        </td>
        <td className="px-4 py-3 whitespace-nowrap text-sm font-bold text-right">
          <span className="inline-flex items-center gap-1.5">
            {entry.totalScore.toFixed(1)}
            <RankChangeArrow rankChange={entry.rankChange} />
          </span>
        </td>
        <td className="px-4 py-3 whitespace-nowrap text-center text-sm">
          {entry.updateStreak > 0 && (
            <span className="inline-flex items-center gap-1">
              <Flame className="h-3.5 w-3.5 text-orange-500" />
              {entry.updateStreak}
            </span>
          )}
        </td>
        <td className="px-4 py-3 whitespace-nowrap">
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation()
                router.push(`${href}/analytics`)
              }}
              title="Analytics"
            >
              <BarChart3 className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation()
                router.push(`${href}/edit`)
              }}
              title="Edit"
            >
              <Edit className="h-4 w-4" />
            </Button>
            {expanded ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} className="px-4 py-4 bg-muted/30">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {Object.entries(entry.categories).map(([key, cat]: [string, any]) => (
                <div key={key} className="space-y-1">
                  <div className="flex items-center gap-2">
                    <div className={`h-2.5 w-2.5 ${CATEGORY_COLORS[key]}`} />
                    <span className="text-xs font-medium">{CATEGORY_LABELS[key]}</span>
                    <span className="text-xs text-muted-foreground ml-auto">
                      {CATEGORY_WEIGHTS[key]}%
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Raw: {cat.raw.toFixed(1)} | Norm: {cat.normalized.toFixed(1)} | Score:{' '}
                    {cat.weighted.toFixed(2)}
                  </div>
                  {cat.weighted < 0.005 && (
                    <div className="text-[11px] text-muted-foreground italic">
                      {explainZeroScore(key, cat)}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-3 flex gap-4 text-xs text-muted-foreground">
              <span>Active categories: {entry.activeCategories}/4</span>
              {entry.favoriteMultiplier > 1 && (
                <span className="text-yellow-600">
                  Favorite boost: x{entry.favoriteMultiplier.toFixed(3)}
                </span>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

export default function StartupsPage() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const cohortSlug = params.cohortSlug as string

  const storageKey = `admin-startups-view:${cohortSlug}`

  // Always initialize to 'overview' so server render and client hydration agree.
  // The effect below drives the real value from URL/sessionStorage post-mount.
  const [view, setView] = useState<'overview' | 'leaderboard'>('overview')

  // Sync view state with URL + sessionStorage. Re-runs on cohort switch so the
  // new cohort reads its own cached preference, not the previous cohort's.
  useEffect(() => {
    const fromUrl = searchParams.get('view')
    if (fromUrl === 'leaderboard' || fromUrl === 'overview') {
      setView(fromUrl)
      return
    }
    let cached: string | null = null
    try {
      cached = window.sessionStorage.getItem(storageKey)
    } catch {
      /* sessionStorage unavailable (privacy mode) — fall through */
    }
    if (cached === 'leaderboard' || cached === 'overview') {
      setView(cached)
      const nextParams = new URLSearchParams(searchParams.toString())
      nextParams.set('view', cached)
      router.replace(`?${nextParams.toString()}`, { scroll: false })
      return
    }
    setView('overview')
  }, [cohortSlug, searchParams, storageKey, router])

  const handleViewChange = (next: 'overview' | 'leaderboard') => {
    setView(next)
    try {
      window.sessionStorage.setItem(storageKey, next)
    } catch {
      /* noop */
    }
    const nextParams = new URLSearchParams(searchParams.toString())
    nextParams.set('view', next)
    router.replace(`?${nextParams.toString()}`, { scroll: false })
  }

  const cohort = useQuery(api.cohorts.getBySlug, { slug: cohortSlug })
  const startups = useQuery(api.startups.list, cohort ? { cohortId: cohort._id } : 'skip')
  const fundingOverview = useQuery(
    api.funding.dashboardForAdmin,
    cohort ? { cohortId: cohort._id } : 'skip'
  )
  const integrationStatus = useQuery(
    api.integrations.statusByCohort,
    cohort ? { cohortId: cohort._id } : 'skip'
  )
  const leaderboard = useQuery(
    api.leaderboard.computeLeaderboard,
    cohort ? { cohortId: cohort._id } : 'skip'
  )

  const [showExplainer, setShowExplainer] = useState(false)
  const [showConfig, setShowConfig] = useState(false)
  const [pValue, setPValue] = useState(0.7)
  const updateP = useMutation(api.leaderboard.updateNormalizationPower)

  // Sync slider with server value once loaded
  useEffect(() => {
    if (leaderboard?.normalizationPower != null) {
      setPValue(leaderboard.normalizationPower)
    }
  }, [leaderboard?.normalizationPower])

  const maxScore = useMemo(() => {
    if (!leaderboard?.ranked?.length) return 10
    return Math.max(...leaderboard.ranked.map((r: any) => r.totalScore), 1)
  }, [leaderboard])

  const currentUser = useQuery(api.users.current)
  const isSuperAdmin = currentUser?.role === 'super_admin'

  // Build a lookup of funding data by startup ID
  const fundingByStartupId = useMemo(() => {
    const map: Record<string, { unlocked: number; deployed: number; entitlement: number }> = {}
    if (fundingOverview?.startups) {
      for (const s of fundingOverview.startups) {
        map[s.startupId] = {
          unlocked: s.unlocked,
          deployed: s.deployed,
          entitlement: s.entitlement,
        }
      }
    }
    return map
  }, [fundingOverview])

  const isLoading = cohort === undefined || (cohort && startups === undefined)

  if (cohort === null) {
    router.push('/admin/cohorts')
    return null
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-48 mb-2" />
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  const startupCount = startups?.length ?? 0
  const totalAllocation = fundingOverview?.cohort.fundingBudget ?? 0
  const baselinePer = fundingOverview?.cohort.baseFunding ?? 0

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight font-display">Startups</h1>
          <p className="text-muted-foreground">
            {startupCount} startup{startupCount !== 1 ? 's' : ''} in {cohort!.label}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {view === 'leaderboard' && (
            <>
              <Button variant="outline" size="sm" onClick={() => setShowExplainer(!showExplainer)}>
                <Info className="mr-2 h-4 w-4" />
                How scoring works
                {showExplainer ? (
                  <ChevronUp className="ml-2 h-4 w-4" />
                ) : (
                  <ChevronDown className="ml-2 h-4 w-4" />
                )}
              </Button>
              {isSuperAdmin && (
                <Button variant="outline" size="sm" onClick={() => setShowConfig(!showConfig)}>
                  <Settings2 className="mr-2 h-4 w-4" />
                  Config
                </Button>
              )}
            </>
          )}
          <Link href={`/admin/${cohortSlug}/startups/new`}>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Create Startup
            </Button>
          </Link>
        </div>
      </div>

      {/* Segmented control */}
      <div className="inline-flex items-center border bg-muted p-1 gap-1">
        <button
          onClick={() => handleViewChange('overview')}
          className={cn(
            'px-4 py-1.5 text-sm font-medium transition-colors cursor-pointer',
            view === 'overview'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          Overview
        </button>
        <button
          onClick={() => handleViewChange('leaderboard')}
          className={cn(
            'px-4 py-1.5 text-sm font-medium transition-colors cursor-pointer',
            view === 'leaderboard'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          Leaderboard
        </button>
      </div>

      {/* ─── OVERVIEW MODE ─── */}
      {view === 'overview' && (
        <>
          {startups && startups.length > 0 ? (
            <div className="bg-card border overflow-hidden overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Startup</TableHead>
                    <TableHead>Sector</TableHead>
                    <TableHead>Website</TableHead>
                    <TableHead>Funding</TableHead>
                    <TableHead>Integrations</TableHead>
                    <TableHead className="w-24"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...startups]
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((startup) => {
                      const href = `/admin/${cohortSlug}/startups/${startup.slug || startup._id}`
                      const funding = fundingByStartupId[startup._id]
                      const intStatus = integrationStatus?.[startup._id]
                      return (
                        <TableRow
                          key={startup._id}
                          className="cursor-pointer transition-colors hover:bg-muted/50"
                          onClick={() => router.push(href)}
                        >
                          <TableCell>
                            <div className="flex items-center gap-3">
                              {startup.logoUrl && (
                                <Image
                                  src={startup.logoUrl}
                                  alt={startup.name}
                                  width={32}
                                  height={32}
                                  className="h-8 w-8 rounded-full"
                                />
                              )}
                              <span className="text-sm font-medium">{startup.name}</span>
                              {startup.excludeFromMetrics === true && (
                                <Badge variant="warning" className="text-xs">
                                  Excluded
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <span className="text-sm text-muted-foreground">
                              {startup.sector || '—'}
                            </span>
                          </TableCell>
                          <TableCell>
                            {startup.websiteUrl ? (
                              <a
                                href={startup.websiteUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {startup.websiteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            ) : (
                              <span className="text-sm text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <FundingMiniBar
                              unlocked={funding?.unlocked ?? 0}
                              deployed={funding?.deployed ?? 0}
                              total={
                                funding?.entitlement ??
                                (totalAllocation > 0 && startupCount > 0
                                  ? totalAllocation / startupCount
                                  : baselinePer)
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <IntegrationDots status={intStatus} />
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  router.push(`${href}/analytics`)
                                }}
                                title="Analytics"
                              >
                                <BarChart3 className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  router.push(`${href}/edit`)
                                }}
                                title="Edit"
                              >
                                <Edit className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState
              icon={<Building2 className="h-6 w-6" />}
              title="No startups enrolled"
              description="There are no startups enrolled in this cohort yet. Create a startup to start tracking their progress."
              action={
                <Link href={`/admin/${cohortSlug}/startups/new`}>
                  <Button>
                    <Plus className="mr-2 h-4 w-4" />
                    Create Startup
                  </Button>
                </Link>
              }
            />
          )}
        </>
      )}

      {/* ─── LEADERBOARD MODE ─── */}
      {view === 'leaderboard' && (
        <>
          {showExplainer && <ScoringExplainerContent />}

          {showConfig && isSuperAdmin && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Normalization Power (p)</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-4">
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    More compressed
                  </span>
                  <input
                    type="range"
                    min={0.3}
                    max={1.0}
                    step={0.05}
                    value={pValue}
                    onChange={(e) => setPValue(Number(e.target.value))}
                    className="flex-1"
                  />
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    More linear
                  </span>
                  <span className="text-sm font-mono font-bold w-10 text-right">
                    {pValue.toFixed(2)}
                  </span>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={async () => {
                      try {
                        await updateP({ cohortId: cohort!._id, normalizationPower: pValue })
                        toast.success('Normalization power updated')
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : 'Failed')
                      }
                    }}
                  >
                    Apply
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setPValue(0.7)}>
                    Reset to default (0.70)
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Current: {leaderboard?.normalizationPower?.toFixed(2) ?? '0.70'}. Changes
                  recalculate all scores retroactively.
                </p>
              </CardContent>
            </Card>
          )}

          {leaderboard === undefined ? (
            <Skeleton className="h-96 w-full" />
          ) : (leaderboard?.ranked?.length ?? 0) + (leaderboard?.unranked?.length ?? 0) === 0 ? (
            <EmptyState
              icon={<Building2 className="h-6 w-6" />}
              title="No startups enrolled"
              description="Invite startups to start tracking their progress."
              action={
                <Link href={`/admin/${cohortSlug}/startups/new`}>
                  <Button>
                    <Plus className="mr-2 h-4 w-4" />
                    Create Startup
                  </Button>
                </Link>
              }
            />
          ) : (
            <>
              {/* Leaderboard table */}
              <div className="bg-card border overflow-hidden overflow-x-auto">
                <table className="min-w-full divide-y divide-border">
                  <thead className="bg-muted">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider w-12">
                        Rank
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        Startup
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        Score Breakdown
                      </th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider w-20">
                        Score
                      </th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider w-16">
                        Streak
                      </th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-muted-foreground uppercase tracking-wider w-24" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {leaderboard?.ranked?.map((entry: any) => (
                      <ExpandableRow
                        key={entry.startupId}
                        entry={entry}
                        maxScore={maxScore}
                        cohortSlug={cohortSlug}
                        router={router}
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Unranked section */}
              {leaderboard?.unranked && leaderboard.unranked.length > 0 && (
                <div className="space-y-3">
                  <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                    Unranked ({leaderboard.unranked.length})
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    These startups don&apos;t yet meet the 3-of-5 category activity requirement for
                    the Qualified tag.
                  </p>
                  <div className="bg-card border overflow-hidden">
                    <table className="min-w-full divide-y divide-border">
                      <tbody className="divide-y divide-border">
                        {leaderboard.unranked.map((entry: any) => {
                          const href = `/admin/${cohortSlug}/startups/${entry.startupSlug ?? entry.startupId}`
                          return (
                            <tr key={entry.startupId} className="opacity-60">
                              <td className="px-4 py-3 w-12">
                                <span className="text-muted-foreground text-sm">—</span>
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-3">
                                  {entry.startupLogoUrl && (
                                    <Image
                                      src={entry.startupLogoUrl}
                                      alt={entry.startupName}
                                      width={32}
                                      height={32}
                                      className="h-8 w-8 rounded-full"
                                    />
                                  )}
                                  <span className="text-sm">{entry.startupName}</span>
                                  <Badge variant="outline" className="text-xs">
                                    {entry.activeCategories}/4 active
                                  </Badge>
                                  {entry.excludeFromMetrics && (
                                    <Badge variant="warning" className="text-xs">
                                      Excluded
                                    </Badge>
                                  )}
                                </div>
                              </td>
                              <td className="px-4 py-3 text-right text-sm text-muted-foreground">
                                {entry.totalScore.toFixed(1)}
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-1">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => router.push(`${href}/analytics`)}
                                    title="Analytics"
                                  >
                                    <BarChart3 className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => router.push(`${href}/edit`)}
                                    title="Edit"
                                  >
                                    <Edit className="h-4 w-4" />
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Legend */}
              <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                  <div key={key} className="flex items-center gap-1.5">
                    <div className={`h-2 w-2 ${CATEGORY_COLORS[key]}`} />
                    {label} ({CATEGORY_WEIGHTS[key]}%)
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
