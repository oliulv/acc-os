'use client'

import { useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { useQuery, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { logClientError } from '@/lib/logging'
import Link from 'next/link'
import Image from 'next/image'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { BankDetailsDialog } from '@/components/bank-details-dialog'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  ArrowLeft,
  Edit,
  UserPlus,
  Target,
  Users,
  Mail,
  ExternalLink,
  Plug,
  RotateCw,
  Trash2,
  Send,
  Clock,
  CheckCircle,
  Plus,
  GripVertical,
  FileText,
  Landmark,
  PlusCircle,
  MinusCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import type { Doc } from '@/convex/_generated/dataModel'

type Milestone = Doc<'milestones'>
type Invoice = Doc<'invoices'>

type AdjustmentMode = 'top_up' | 'deduction'

function formatCurrency(value: number): string {
  return `£${value.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`
}

function getInitials(name: string) {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

function InvoiceCard({ invoice, cohortSlug }: { invoice: Invoice; cohortSlug: string }) {
  return (
    <Link
      href={`/admin/${cohortSlug}/invoices/${invoice._id}`}
      className="flex items-center gap-3 border px-3 py-2.5 hover:bg-muted/50"
    >
      <div className="flex-shrink-0">
        {invoice.status === 'paid' ? (
          <CheckCircle className="h-4 w-4 text-green-600" />
        ) : invoice.status === 'approved' ? (
          <CheckCircle className="h-4 w-4 text-blue-600" />
        ) : invoice.status === 'rejected' ? (
          <FileText className="h-4 w-4 text-red-600" />
        ) : (
          <Clock className="h-4 w-4 text-amber-600" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium truncate">{invoice.vendorName}</p>
          <Badge
            variant={
              invoice.status === 'paid'
                ? 'success'
                : invoice.status === 'approved'
                  ? 'secondary'
                  : invoice.status === 'rejected'
                    ? 'destructive'
                    : 'warning'
            }
            className="shrink-0 text-[10px] px-1.5 py-0"
          >
            {invoice.status === 'under_review' ? 'under review' : invoice.status}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {'\u00A3'}
          {invoice.amountGbp.toLocaleString('en-GB')}
        </p>
      </div>
    </Link>
  )
}

function SortableMilestoneCard({
  milestone,
  cohortSlug,
}: {
  milestone: Milestone
  cohortSlug: string
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: milestone._id,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-3 border px-3 py-2.5">
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing touch-none p-1 hover:bg-muted rounded flex-shrink-0"
      >
        <GripVertical className="h-4 w-4 text-muted-foreground" />
      </button>
      <div className="flex-shrink-0">
        {milestone.status === 'approved' ? (
          <CheckCircle className="h-4 w-4 text-green-600" />
        ) : milestone.status === 'submitted' ? (
          <Clock className="h-4 w-4 text-amber-600" />
        ) : milestone.status === 'changes_requested' ? (
          <RotateCw className="h-4 w-4 text-orange-600" />
        ) : (
          <Send className="h-4 w-4 text-muted-foreground" />
        )}
      </div>
      <Link
        href={`/admin/${cohortSlug}/milestones/${milestone._id}`}
        className="flex-1 min-w-0 hover:underline"
      >
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium truncate">{milestone.title}</p>
          <Badge
            variant={
              milestone.status === 'approved'
                ? 'success'
                : milestone.status === 'submitted' || milestone.status === 'changes_requested'
                  ? 'warning'
                  : 'secondary'
            }
            className="shrink-0 text-[10px] px-1.5 py-0"
          >
            {milestone.status === 'changes_requested' ? 'changes requested' : milestone.status}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {'\u00A3'}
          {milestone.amount.toLocaleString('en-GB')}
        </p>
      </Link>
    </div>
  )
}

export default function StartupDetailPage() {
  const params = useParams()
  const cohortSlug = params.cohortSlug as string
  const slug = params.slug as string

  const cohort = useQuery(api.cohorts.getBySlug, { slug: cohortSlug })
  const currentUser = useQuery(api.users.current)
  const isSuperAdmin = currentUser?.role === 'super_admin'
  const startup = useQuery(api.startups.getBySlug, { slug })
  const milestones = useQuery(
    api.milestones.listByStartup,
    startup ? { startupId: startup._id } : 'skip'
  )
  const invoicesData = useQuery(
    api.invoices.listForAdmin,
    startup ? { startupId: startup._id } : 'skip'
  )
  const teamData = useQuery(
    api.invitations.listTeamAndPending,
    startup ? { startupId: startup._id } : 'skip'
  )
  const startupProfile = useQuery(
    api.startups.getProfileByStartupId,
    startup ? { startupId: startup._id } : 'skip'
  )
  const founderProfiles = useQuery(
    api.startups.getFounderProfilesByStartupId,
    startup ? { startupId: startup._id } : 'skip'
  )
  const bankDetails = useQuery(
    api.bankDetails.getByStartupId,
    startup ? { startupId: startup._id } : 'skip'
  )
  const fundingSummary = useQuery(
    api.funding.summaryForAdminStartup,
    startup ? { startupId: startup._id } : 'skip'
  )
  const allocateTopUp = useMutation(api.funding.allocateTopUp)
  const deductAvailableFunding = useMutation(api.funding.deductAvailableFunding)

  const createInvitation = useMutation(api.invitations.create)
  const resendInvitation = useMutation(api.invitations.resend)
  const removeFounder = useMutation(api.invitations.removeFounder)
  const removeTeamMember = useMutation(api.invitations.removeTeamMember)
  const reorderMilestones = useMutation(api.milestones.reorder)

  const [showBankDetailsDialog, setShowBankDetailsDialog] = useState(false)
  const [showInviteDialog, setShowInviteDialog] = useState(false)
  const [showFundingAdjustmentDialog, setShowFundingAdjustmentDialog] = useState(false)
  const [adjustmentMode, setAdjustmentMode] = useState<AdjustmentMode>('top_up')
  const [adjustmentAmount, setAdjustmentAmount] = useState('')
  const [adjustmentNote, setAdjustmentNote] = useState('')
  const [isWritingAdjustment, setIsWritingAdjustment] = useState(false)
  const [inviteFullName, setInviteFullName] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteExpiresInDays, setInviteExpiresInDays] = useState('')
  const [isInviting, setIsInviting] = useState(false)
  const [resendingId, setResendingId] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  // Funding values come from the shared Convex read model.
  const milestoneList = useMemo(() => milestones ?? [], [milestones])
  const potential = fundingSummary?.potential ?? 0
  const baseline = fundingSummary?.baseline ?? 0
  const topUp = fundingSummary?.topUp ?? 0
  const deductions = fundingSummary?.deductions ?? 0
  const entitlement = fundingSummary?.entitlement ?? 0
  const unlocked = fundingSummary?.unlocked ?? 0
  const claimable = fundingSummary?.claimable ?? 0
  const deployed = fundingSummary?.deployed ?? 0
  const committed = fundingSummary?.committed ?? 0
  const available = fundingSummary?.available ?? 0
  const cappedDeployed = Math.max(0, Math.min(deployed, claimable))
  const deployedPct = claimable > 0 ? (cappedDeployed / claimable) * 100 : 0
  const committedPct =
    claimable > 0 ? (Math.min(committed, claimable - cappedDeployed) / claimable) * 100 : 0

  // Quick stats
  const pendingInvoices = (invoicesData ?? []).filter(
    (i) => i.status === 'submitted' || i.status === 'under_review'
  ).length
  const approvedMilestones = milestoneList.filter((m) => m.status === 'approved').length
  const parsedAdjustmentAmount = Number(adjustmentAmount)
  const normalizedAdjustmentAmount =
    Number.isFinite(parsedAdjustmentAmount) && parsedAdjustmentAmount > 0
      ? Math.round(parsedAdjustmentAmount * 100) / 100
      : 0
  const topUpPool = fundingSummary?.topUpPool ?? 0
  const adjustmentIsTopUp = adjustmentMode === 'top_up'
  // Deduction model mirrors computeStartupFunding (convex/lib/fundingMath.ts): a
  // deduction lowers the baseline ceiling, so cash already unlocked is untouched
  // unless the reduced ceiling drops below what milestones have unlocked. `baseline`
  // is the raw cohort base; `deductions` already reflects prior deductions, so the new
  // amount stacks on top of them.
  const remainingBaseline = Math.max(0, baseline - deductions)
  const deductedBaseline = Math.max(0, baseline - deductions - normalizedAdjustmentAmount)
  const deductedUnlocked = Math.min(unlocked, deductedBaseline)
  const deductedClaimable = Math.max(0, deductedUnlocked + topUp)
  const previewAvailable = adjustmentIsTopUp
    ? available + normalizedAdjustmentAmount
    : Math.max(0, deductedClaimable - committed - deployed)
  const previewEntitlement = adjustmentIsTopUp
    ? entitlement + normalizedAdjustmentAmount
    : Math.max(0, deductedBaseline + topUp)
  const previewPool = adjustmentIsTopUp
    ? topUpPool - normalizedAdjustmentAmount
    : topUpPool + normalizedAdjustmentAmount
  // A deduction reaching below already-unlocked funding claws back cash the startup
  // could already spend, not just future headroom — worth flagging to the admin.
  const deductionClawsBackCash = !adjustmentIsTopUp && previewAvailable < available
  const adjustmentError =
    normalizedAdjustmentAmount <= 0
      ? 'Enter an amount greater than zero'
      : adjustmentNote.trim().length === 0
        ? 'Add a founder-visible note'
        : adjustmentIsTopUp && normalizedAdjustmentAmount > topUpPool
          ? `Top-up exceeds the remaining pool of ${formatCurrency(topUpPool)}`
          : !adjustmentIsTopUp && normalizedAdjustmentAmount > remainingBaseline
            ? `Deduction exceeds the startup's remaining baseline of ${formatCurrency(remainingBaseline)}`
            : null

  async function handleFundingAdjustment() {
    if (!cohort || !startup || adjustmentError) {
      if (adjustmentError) toast.error(adjustmentError)
      return
    }

    setIsWritingAdjustment(true)
    try {
      const payload = {
        cohortId: cohort._id,
        startupId: startup._id,
        amount: normalizedAdjustmentAmount,
        note: adjustmentNote.trim(),
        appUrl: window.location.origin,
      }
      if (adjustmentIsTopUp) {
        await allocateTopUp(payload)
        toast.success('Top-up allocated')
      } else {
        await deductAvailableFunding(payload)
        toast.success('Funding deducted')
      }
      setAdjustmentAmount('')
      setAdjustmentNote('')
      setShowFundingAdjustmentDialog(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to write funding adjustment')
    } finally {
      setIsWritingAdjustment(false)
    }
  }

  async function handleInvite() {
    if (!inviteFullName.trim() || !inviteEmail.trim() || !startup) return
    const expiresInDays = Number.parseInt(inviteExpiresInDays, 10)
    if (Number.isNaN(expiresInDays) || expiresInDays < 1 || expiresInDays > 30) {
      toast.error('Expires In must be between 1 and 30 days')
      return
    }

    setIsInviting(true)
    try {
      await createInvitation({
        startupId: startup._id,
        email: inviteEmail.trim(),
        fullName: inviteFullName.trim(),
        expiresInDays,
        appUrl: window.location.origin,
      })
      toast.success('Invitation sent successfully')
      setShowInviteDialog(false)
      setInviteFullName('')
      setInviteEmail('')
      setInviteExpiresInDays('')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to send invitation')
    } finally {
      setIsInviting(false)
    }
  }

  async function handleResend(invitationId: string) {
    setResendingId(invitationId)
    try {
      await resendInvitation({ id: invitationId as any, appUrl: window.location.origin })
      toast.success('Invitation resent')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to resend invitation')
    } finally {
      setResendingId(null)
    }
  }

  async function handleRemoveTeamMember(profileId: string, name: string) {
    if (!confirm(`Remove ${name}? This deletes their founder profile and invitation.`)) return
    setRemovingId(profileId)
    try {
      await removeTeamMember({ id: profileId as any })
      toast.success(`${name} removed`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove founder')
    } finally {
      setRemovingId(null)
    }
  }

  async function handleCancelInvitation(invitationId: string, name: string) {
    if (!confirm(`Cancel invitation for ${name}?`)) return
    setRemovingId(invitationId)
    try {
      await removeFounder({ id: invitationId as any })
      toast.success(`Invitation for ${name} cancelled`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to cancel invitation')
    } finally {
      setRemovingId(null)
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id || !milestones) return
    const oldIndex = milestones.findIndex((m) => m._id === active.id)
    const newIndex = milestones.findIndex((m) => m._id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    const newOrder = arrayMove(milestones, oldIndex, newIndex)
    try {
      await reorderMilestones({ milestoneIds: newOrder.map((m) => m._id) })
      toast.success('Milestones reordered')
    } catch (error) {
      logClientError('Failed to reorder:', error)
      toast.error('Failed to reorder milestones')
    }
  }

  // Loading state
  if (startup === undefined || cohort === undefined || (startup && fundingSummary === undefined)) {
    return (
      <div className="space-y-6">
        <div className="space-y-4">
          <Skeleton className="h-9 w-36" />
          <div className="flex items-center justify-between">
            <div>
              <Skeleton className="h-9 w-64" />
              <Skeleton className="mt-1 h-5 w-32" />
            </div>
            <div className="flex gap-2">
              <Skeleton className="h-10 w-28" />
              <Skeleton className="h-10 w-36" />
              <Skeleton className="h-10 w-20" />
            </div>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="pt-6">
                <Skeleton className="h-8 w-24" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    )
  }

  // Not found
  if (startup === null || cohort === null) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <h1 className="text-2xl font-bold font-display">Startup not found</h1>
        <p className="mt-2 text-muted-foreground">
          The startup you are looking for does not exist or does not belong to this cohort.
        </p>
        <Link href={`/admin/${cohortSlug}/startups`} className="mt-4">
          <Button variant="outline">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Startups
          </Button>
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-4">
        <div>
          <Link href={`/admin/${cohortSlug}/startups`}>
            <Button variant="ghost" size="sm">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Startups
            </Button>
          </Link>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight font-display">{startup.name}</h1>
            <p className="text-muted-foreground">{cohort?.label || 'No cohort'}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setShowBankDetailsDialog(true)}>
              <Landmark className="mr-2 h-4 w-4" />
              Bank Details
            </Button>
            <Link href={`/admin/${cohortSlug}/startups/${slug}/analytics`}>
              <Button variant="outline">
                <Plug className="mr-2 h-4 w-4" />
                Analytics
              </Button>
            </Link>
            <Button variant="default" onClick={() => setShowInviteDialog(true)}>
              <UserPlus className="mr-2 h-4 w-4" />
              Invite Founder
            </Button>
            <Link href={`/admin/${cohortSlug}/startups/${slug}/edit`}>
              <Button variant="outline">
                <Edit className="mr-2 h-4 w-4" />
                Edit
              </Button>
            </Link>
          </div>
        </div>
      </div>

      {/* Funding metrics row */}
      <div className="grid gap-4 md:grid-cols-5">
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm font-medium text-muted-foreground flex items-center">
              Baseline
              <InfoTooltip text="The cohort baseline reserve for this startup." />
            </p>
            <p className="mt-1 text-2xl font-bold font-display text-muted-foreground">
              {formatCurrency(baseline)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm font-medium text-muted-foreground flex items-center">
              Top-up
              <InfoTooltip text="Additional funding directly awarded to this startup." />
            </p>
            <p className="mt-1 text-2xl font-bold font-display">{formatCurrency(topUp)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm font-medium text-muted-foreground flex items-center">
              Deductions
              <InfoTooltip text="Funding deducted from unspent available balance." />
            </p>
            <p className="mt-1 text-2xl font-bold font-display">{formatCurrency(deductions)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm font-medium text-muted-foreground flex items-center">
              Entitlement
              <InfoTooltip text="Baseline plus top-ups minus deductions." />
            </p>
            <p className="mt-1 text-2xl font-bold font-display text-blue-600">
              {formatCurrency(entitlement)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm font-medium text-muted-foreground flex items-center">
              Available
              <InfoTooltip text="Unlocked minus deployed. How much the startup can still claim." />
            </p>
            <p className="mt-1 text-2xl font-bold font-display text-green-600">
              {formatCurrency(available)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Funding utilization bar */}
      <Card>
        <CardContent className="space-y-3 pt-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">Funding utilization</p>
            <p className="text-xs text-muted-foreground">
              Deployed {formatCurrency(deployed)} of {formatCurrency(claimable)} claimable
            </p>
          </div>
          <div
            className={`relative h-3 overflow-hidden rounded-full ${claimable > 0 ? 'bg-emerald-500/25' : 'bg-muted'}`}
          >
            {claimable > 0 && (
              <>
                <div
                  className="absolute inset-y-0 left-0 bg-blue-600"
                  style={{ width: `${deployedPct}%` }}
                />
                {committed > 0 && (
                  <div
                    className="absolute inset-y-0 bg-violet-500"
                    style={{ left: `${deployedPct}%`, width: `${committedPct}%` }}
                  />
                )}
              </>
            )}
          </div>
          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-blue-600" />
              Deployed {formatCurrency(deployed)}
            </span>
            {committed > 0 && (
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-violet-500" />
                Committed {formatCurrency(committed)}
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-emerald-500/40" />
              Available {formatCurrency(available)}
            </span>
          </div>
        </CardContent>
      </Card>

      {isSuperAdmin && fundingSummary && (
        <Card>
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>Funding adjustments</CardTitle>
              <CardDescription>
                Top-ups and deductions that change this startup&apos;s entitlement.
              </CardDescription>
            </div>
            <Button onClick={() => setShowFundingAdjustmentDialog(true)}>
              <PlusCircle className="mr-2 h-4 w-4" />
              New adjustment
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="border bg-muted/40 px-3 py-2 text-sm">
                <p className="text-muted-foreground">Available</p>
                <p className="font-medium text-green-700">{formatCurrency(available)}</p>
              </div>
              <div className="border bg-muted/40 px-3 py-2 text-sm">
                <p className="text-muted-foreground">Entitlement</p>
                <p className="font-medium">{formatCurrency(entitlement)}</p>
              </div>
              <div className="border bg-muted/40 px-3 py-2 text-sm">
                <p className="text-muted-foreground">Top-up pool</p>
                <p className="font-medium">{formatCurrency(topUpPool)}</p>
              </div>
            </div>

            <div className="space-y-3">
              <h3 className="text-sm font-medium">Adjustment timeline</h3>
              {fundingSummary.adjustments.length > 0 ? (
                <div className="space-y-3">
                  {fundingSummary.adjustments.map((adjustment) => {
                    const isTopUp = adjustment.type === 'top_up'
                    return (
                      <div key={adjustment._id} className="border px-3 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-start gap-3">
                            <Avatar className="mt-0.5 h-8 w-8">
                              <AvatarImage src={adjustment.adminImageUrl ?? undefined} />
                              <AvatarFallback className="text-xs">
                                {getInitials(adjustment.adminName)}
                              </AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                              <p className="text-sm font-medium">
                                {isTopUp ? 'Top-up allocated' : 'Funding deducted'}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {adjustment.adminName} ·{' '}
                                {new Date(adjustment.createdAt).toLocaleDateString('en-GB', {
                                  day: 'numeric',
                                  month: 'short',
                                  year: 'numeric',
                                })}
                              </p>
                              <p className="mt-2 whitespace-pre-wrap text-sm">{adjustment.note}</p>
                            </div>
                          </div>
                          <span
                            className={`shrink-0 text-sm font-semibold ${
                              isTopUp ? 'text-green-700' : 'text-muted-foreground'
                            }`}
                          >
                            {isTopUp ? '+' : '-'}
                            {formatCurrency(adjustment.amount)}
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="border border-dashed p-4 text-sm text-muted-foreground">
                  No funding adjustments yet.
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={showFundingAdjustmentDialog} onOpenChange={setShowFundingAdjustmentDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Funding adjustment</DialogTitle>
            <DialogDescription>
              Allocate top-up funding or deduct unspent available funding. Notes are visible to
              founders.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 border">
              <button
                type="button"
                className={`flex h-10 items-center justify-center gap-2 text-sm font-medium ${
                  adjustmentMode === 'top_up'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background'
                }`}
                onClick={() => setAdjustmentMode('top_up')}
              >
                <PlusCircle className="h-4 w-4" />
                Allocate top-up
              </button>
              <button
                type="button"
                className={`flex h-10 items-center justify-center gap-2 text-sm font-medium ${
                  adjustmentMode === 'deduction'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background'
                }`}
                onClick={() => setAdjustmentMode('deduction')}
              >
                <MinusCircle className="h-4 w-4" />
                Deduct funding
              </button>
            </div>

            <div className="space-y-2">
              <Label htmlFor="funding-adjustment-amount">Amount (GBP)</Label>
              <Input
                id="funding-adjustment-amount"
                type="number"
                min="0.01"
                step="0.01"
                value={adjustmentAmount}
                onChange={(event) => setAdjustmentAmount(event.target.value)}
                placeholder="1000"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="funding-adjustment-note">Founder-visible note</Label>
              <Textarea
                id="funding-adjustment-note"
                value={adjustmentNote}
                onChange={(event) => setAdjustmentNote(event.target.value)}
                rows={3}
                placeholder="Explain why this funding changed."
              />
            </div>

            <div className="space-y-3 border bg-muted/30 p-4 text-sm">
              <p className="font-medium">Funding adjustment preview</p>
              <div className="grid gap-2">
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Available</span>
                  <span className="font-medium">
                    {formatCurrency(available)} → {formatCurrency(previewAvailable)}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Entitlement</span>
                  <span className="font-medium">
                    {formatCurrency(entitlement)} → {formatCurrency(previewEntitlement)}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Top-up pool</span>
                  <span className="font-medium">
                    {formatCurrency(topUpPool)} → {formatCurrency(previewPool)}
                  </span>
                </div>
              </div>
              {deductionClawsBackCash && (
                <p className="text-xs text-amber-700">
                  This deduction cuts below funding the startup has already unlocked, reducing the
                  cash they can currently spend.
                </p>
              )}
              {adjustmentNote.trim().length > 0 && (
                <div className="border-t pt-3">
                  <p className="text-xs text-muted-foreground">Note preview</p>
                  <p className="mt-1 whitespace-pre-wrap">{adjustmentNote}</p>
                </div>
              )}
            </div>

            {adjustmentError && normalizedAdjustmentAmount > 0 && (
              <p className="text-sm text-destructive">{adjustmentError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowFundingAdjustmentDialog(false)}
              disabled={isWritingAdjustment}
            >
              Cancel
            </Button>
            <Button
              onClick={handleFundingAdjustment}
              disabled={!!adjustmentError || isWritingAdjustment}
            >
              {isWritingAdjustment ? 'Saving...' : 'Confirm adjustment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Quick stats row */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pending Invoices</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-display">{pendingInvoices}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Milestones</CardTitle>
            <Target className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-display">
              {approvedMilestones}/{milestoneList.length}
            </div>
            <p className="text-xs text-muted-foreground">approved</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Founders</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-display">
              {teamData?.teamMembers.length || 0}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pending Invitations</CardTitle>
            <Mail className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-display">
              {teamData?.pendingInvitations.length || 0}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Milestones & Invoices 50/50 */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Milestones */}
        <Card className="flex flex-col">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Milestones</CardTitle>
                <CardDescription>Drag to reorder. Click to view details.</CardDescription>
              </div>
              <Link href={`/admin/${cohortSlug}/milestones/new?startup=${slug}`}>
                <Button size="sm">
                  <Plus className="mr-2 h-4 w-4" />
                  Create Milestone
                </Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent className="flex-1">
            {milestones && milestones.length > 0 ? (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <div className="max-h-[13rem] overflow-y-auto">
                  <div className="space-y-2">
                    <SortableContext
                      items={milestones.map((m) => m._id)}
                      strategy={verticalListSortingStrategy}
                    >
                      {milestones.map((milestone) => (
                        <SortableMilestoneCard
                          key={milestone._id}
                          milestone={milestone}
                          cohortSlug={cohortSlug}
                        />
                      ))}
                    </SortableContext>
                  </div>
                </div>
              </DndContext>
            ) : (
              <div className="flex items-center gap-3 border px-3 py-2.5">
                <div className="flex-shrink-0">
                  <CheckCircle className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">No milestones</p>
                  <p className="text-xs text-muted-foreground">No milestones assigned yet.</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Invoices */}
        <Card className="flex flex-col">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Invoices</CardTitle>
                <CardDescription>Click to review invoice details.</CardDescription>
              </div>
              <Link href={`/admin/${cohortSlug}/invoices`}>
                <Button size="sm" variant="outline">
                  View All
                </Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent className="flex-1 space-y-3">
            {invoicesData && invoicesData.filter((i) => i.status !== 'rejected').length > 0 ? (
              <div className="max-h-[13rem] overflow-y-auto">
                <div className="space-y-2">
                  {invoicesData
                    .filter((i) => i.status !== 'rejected')
                    .map((invoice) => (
                      <InvoiceCard key={invoice._id} invoice={invoice} cohortSlug={cohortSlug} />
                    ))}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3 border px-3 py-2.5">
                <div className="flex-shrink-0">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">No invoices</p>
                  <p className="text-xs text-muted-foreground">No invoices submitted yet.</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Startup Details */}
      <Card>
        <CardHeader>
          <CardTitle>Startup Details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          {startupProfile?.oneLiner && (
            <div className="md:col-span-2">
              <span className="text-sm font-medium text-muted-foreground">One Liner</span>
              <p className="mt-1">{startupProfile.oneLiner}</p>
            </div>
          )}
          {startupProfile?.description && (
            <div className="md:col-span-2">
              <span className="text-sm font-medium text-muted-foreground">Description</span>
              <p className="mt-1 text-sm whitespace-pre-wrap">{startupProfile.description}</p>
            </div>
          )}
          <div>
            <span className="text-sm font-medium text-muted-foreground">Sector</span>
            <p className="mt-1">{startupProfile?.industry || startup.sector || '-'}</p>
          </div>
          <div>
            <span className="text-sm font-medium text-muted-foreground">Location</span>
            <p className="mt-1">{startupProfile?.location || '-'}</p>
          </div>
          <div>
            <span className="text-sm font-medium text-muted-foreground">Website</span>
            <p className="mt-1">
              {startupProfile?.companyUrl || startup.websiteUrl ? (
                <a
                  href={startupProfile?.companyUrl || startup.websiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center"
                >
                  {startupProfile?.companyUrl || startup.websiteUrl}
                  <ExternalLink className="ml-1 h-3 w-3" />
                </a>
              ) : (
                '-'
              )}
            </p>
          </div>
          {startupProfile?.productUrl && (
            <div>
              <span className="text-sm font-medium text-muted-foreground">Product URL</span>
              <p className="mt-1">
                <a
                  href={startupProfile.productUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center"
                >
                  {startupProfile.productUrl}
                  <ExternalLink className="ml-1 h-3 w-3" />
                </a>
              </p>
            </div>
          )}
          {startupProfile?.initialCustomers !== undefined &&
            startupProfile.initialCustomers !== null && (
              <div>
                <span className="text-sm font-medium text-muted-foreground">Initial Customers</span>
                <p className="mt-1">{startupProfile.initialCustomers.toLocaleString('en-GB')}</p>
              </div>
            )}
          {startupProfile?.initialRevenue !== undefined &&
            startupProfile.initialRevenue !== null && (
              <div>
                <span className="text-sm font-medium text-muted-foreground">Initial Revenue</span>
                <p className="mt-1">
                  {'\u00A3'}
                  {startupProfile.initialRevenue.toLocaleString('en-GB')}
                </p>
              </div>
            )}
          {startup.notes && (
            <div className="md:col-span-2 border-t pt-4">
              <span className="text-sm font-medium text-muted-foreground">Internal Notes</span>
              <p className="mt-1 text-sm">{startup.notes}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Founder Profiles */}
      {founderProfiles && founderProfiles.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Founder Profiles</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            {founderProfiles.map((fp) => (
              <div key={fp._id} className="border p-4 space-y-2">
                <p className="font-medium">{fp.fullName}</p>
                {fp.bio && <p className="text-sm text-muted-foreground">{fp.bio}</p>}
                <div className="grid gap-1 text-sm">
                  {fp.linkedinUrl && (
                    <a
                      href={fp.linkedinUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline inline-flex items-center"
                    >
                      LinkedIn
                      <ExternalLink className="ml-1 h-3 w-3" />
                    </a>
                  )}
                  {fp.xUrl && (
                    <a
                      href={fp.xUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline inline-flex items-center"
                    >
                      X / Twitter
                      <ExternalLink className="ml-1 h-3 w-3" />
                    </a>
                  )}
                  {(fp.city || fp.country) && (
                    <p className="text-muted-foreground">
                      {[fp.city, fp.country].filter(Boolean).join(', ')}
                    </p>
                  )}
                  {fp.phone && <p className="text-muted-foreground">{fp.phone}</p>}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Founders & Invitations */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Founders & Invitations</CardTitle>
              <CardDescription>Team members and pending invitations</CardDescription>
            </div>
            <Button size="sm" onClick={() => setShowInviteDialog(true)}>
              <UserPlus className="mr-2 h-4 w-4" />
              Invite Founder
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Team Members */}
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-3">Team Members</h3>
            {teamData?.teamMembers && teamData.teamMembers.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {teamData.teamMembers.map((member) => (
                    <TableRow key={member._id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          {member.imageUrl ? (
                            <Image
                              src={member.imageUrl}
                              alt={member.fullName}
                              width={28}
                              height={28}
                              className="h-7 w-7 rounded-full object-cover"
                            />
                          ) : (
                            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                              {member.fullName
                                .split(' ')
                                .map((n) => n[0])
                                .join('')
                                .slice(0, 2)
                                .toUpperCase()}
                            </div>
                          )}
                          {member.fullName}
                        </div>
                      </TableCell>
                      <TableCell>{member.email}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveTeamMember(member._id, member.fullName)}
                          disabled={removingId === member._id}
                          title="Remove founder"
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="py-4 text-center text-sm text-muted-foreground">No team members yet</p>
            )}
          </div>

          {/* Pending Invitations */}
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-3">Pending Invitations</h3>
            {teamData?.pendingInvitations && teamData.pendingInvitations.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {teamData.pendingInvitations.map((invitation) => (
                    <TableRow key={invitation._id}>
                      <TableCell className="font-medium">{invitation.fullName}</TableCell>
                      <TableCell>{invitation.email}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(invitation.expiresAt).toLocaleDateString('en-GB', {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        })}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleResend(invitation._id)}
                            disabled={resendingId === invitation._id}
                          >
                            <RotateCw
                              className={`h-4 w-4 mr-1 ${resendingId === invitation._id ? 'animate-spin' : ''}`}
                            />
                            Resend
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              handleCancelInvitation(invitation._id, invitation.fullName)
                            }
                            disabled={removingId === invitation._id}
                            title="Cancel invitation"
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="py-4 text-center text-sm text-muted-foreground">
                No pending invitations
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <BankDetailsDialog
        open={showBankDetailsDialog}
        onOpenChange={setShowBankDetailsDialog}
        bankDetails={bankDetails}
        startupName={startup.name}
      />

      {/* Invite Founder Dialog */}
      <Dialog open={showInviteDialog} onOpenChange={setShowInviteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite Founder</DialogTitle>
            <DialogDescription>
              Send an invitation to join {startup.name} as a founder.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="invite-name">Full Name</Label>
              <Input
                id="invite-name"
                value={inviteFullName}
                onChange={(e) => setInviteFullName(e.target.value)}
                placeholder="Jane Doe"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="jane@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-expires">Expires In (Days)</Label>
              <Input
                id="invite-expires"
                type="number"
                min={1}
                max={30}
                placeholder="14"
                value={inviteExpiresInDays}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setInviteExpiresInDays(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">1-30 days, default: 14</p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowInviteDialog(false)
                setInviteFullName('')
                setInviteEmail('')
                setInviteExpiresInDays('')
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleInvite}
              disabled={isInviting || !inviteFullName.trim() || !inviteEmail.trim()}
            >
              {isInviting ? 'Sending...' : 'Send Invitation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
