'use client'

import { useQuery, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { HowItWorks } from '@/components/ui/how-it-works'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  FileText,
  AlertCircle,
  ExternalLink,
  Users,
  Plus,
  Search,
  ChevronDown,
  ChevronRight,
  Check,
  ChevronsUpDown,
  DollarSign,
  Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  getInvoiceStatusLabel,
  getInvoiceStatusVariant,
  matchesInvoiceStatusFilter,
  type InvoiceStatus,
  type InvoiceStatusFilter,
} from '@/lib/invoice-status'
import { toast } from 'sonner'
import type { Id } from '@/convex/_generated/dataModel'

export default function AdminInvoicesPage() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const cohortSlug = params.cohortSlug as string
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<InvoiceStatusFilter>('all')
  const [startupFilter, setStartupFilter] = useState<string>('all')
  const [startupFilterOpen, setStartupFilterOpen] = useState(false)
  const [showPending, setShowPending] = useState(true)
  const [showPaid, setShowPaid] = useState(true)
  const [showApproved, setShowApproved] = useState(searchParams.get('showApproved') === '1')
  const [showRejected, setShowRejected] = useState(false)

  // Inline mark paid state
  const [markingPaidId, setMarkingPaidId] = useState<string | null>(null)
  const [selectedApprovedIds, setSelectedApprovedIds] = useState<Set<string>>(new Set())
  const [isBatchMarking, setIsBatchMarking] = useState(false)

  const updateStatus = useMutation(api.invoices.updateStatus)
  const batchMarkPaid = useMutation(api.invoices.batchMarkPaid)

  const cohort = useQuery(api.cohorts.getBySlug, { slug: cohortSlug })
  const startups = useQuery(api.startups.list, cohort ? { cohortId: cohort._id } : 'skip')
  const allInvoices = useQuery(api.invoices.listForAdmin, {})

  // Build a startup ID set and name lookup for this cohort
  const startupIdSet = useMemo(() => {
    if (!startups) return new Set<string>()
    return new Set(startups.map((s) => s._id))
  }, [startups])

  const startupNameMap = useMemo(() => {
    if (!startups) return new Map<string, string>()
    return new Map(startups.map((s) => [s._id, s.name]))
  }, [startups])

  // Filter invoices to only those belonging to startups in this cohort
  const cohortInvoices = useMemo(() => {
    if (!allInvoices || !startups) return undefined
    return allInvoices.filter((invoice) => startupIdSet.has(invoice.startupId))
  }, [allInvoices, startups, startupIdSet])

  const normalizedQuery = searchQuery.trim().toLowerCase()

  // Apply search, status, and startup filters
  const filteredInvoices = useMemo(() => {
    if (!cohortInvoices) return undefined
    return cohortInvoices.filter((invoice) => {
      const status = invoice.status as InvoiceStatus
      const startupName = startupNameMap.get(invoice.startupId) ?? ''
      const matchesSearch =
        normalizedQuery.length === 0 ||
        invoice.vendorName.toLowerCase().includes(normalizedQuery) ||
        (invoice.fileName || '').toLowerCase().includes(normalizedQuery) ||
        startupName.toLowerCase().includes(normalizedQuery)
      const matchesStatus = matchesInvoiceStatusFilter(status, statusFilter)
      const matchesStartup = startupFilter === 'all' || invoice.startupId === startupFilter
      return matchesSearch && matchesStatus && matchesStartup
    })
  }, [cohortInvoices, normalizedQuery, startupNameMap, statusFilter, startupFilter])

  // Group invoices by status
  const groupedInvoices = useMemo(() => {
    if (!filteredInvoices) return null

    const pending = filteredInvoices
      .filter((i) => i.status === 'submitted' || i.status === 'under_review')
      .sort((a, b) => b._creationTime - a._creationTime)

    const paid = filteredInvoices
      .filter((i) => i.status === 'paid')
      .sort((a, b) => b._creationTime - a._creationTime)

    const approved = filteredInvoices
      .filter((i) => i.status === 'approved')
      .sort((a, b) => b._creationTime - a._creationTime)

    const rejected = filteredInvoices
      .filter((i) => i.status === 'rejected')
      .sort((a, b) => b._creationTime - a._creationTime)

    return { pending, paid, approved, rejected }
  }, [filteredInvoices])

  // Auto-collapse/expand based on count transitions
  const prevPendingCount = useRef<number | null>(null)
  const prevApprovedCount = useRef<number | null>(null)

  useEffect(() => {
    if (!groupedInvoices) return

    const pendingCount = groupedInvoices.pending.length
    const approvedCount = groupedInvoices.approved.length

    // On first data load, if no pending but has approved, auto-expand approved
    if (prevPendingCount.current === null && pendingCount === 0 && approvedCount > 0) {
      setShowApproved(true)
    }

    if (prevPendingCount.current !== null && prevPendingCount.current > 0 && pendingCount === 0) {
      setShowPending(false)
      setShowApproved(true)
    }

    if (
      prevApprovedCount.current !== null &&
      prevApprovedCount.current > 0 &&
      approvedCount === 0
    ) {
      if (groupedInvoices.pending.length === 0) {
        setShowApproved(false)
        setShowPaid(true)
      }
    }

    prevPendingCount.current = pendingCount
    prevApprovedCount.current = approvedCount
  }, [groupedInvoices])

  // Derive valid selected IDs — only keep IDs that are still in the approved list
  const validSelectedApprovedIds = useMemo(() => {
    if (!groupedInvoices) return selectedApprovedIds
    const approvedIds = new Set(groupedInvoices.approved.map((i) => i._id))
    const filtered = new Set<string>()
    selectedApprovedIds.forEach((id) => {
      if (approvedIds.has(id as Id<'invoices'>)) filtered.add(id)
    })
    return filtered.size === selectedApprovedIds.size ? selectedApprovedIds : filtered
  }, [groupedInvoices, selectedApprovedIds])

  const isLoading = cohort === undefined || startups === undefined || allInvoices === undefined

  // Redirect if cohort not found (returned null)
  if (cohort === null) {
    router.push('/admin/cohorts')
    return null
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <Skeleton className="h-9 w-48 mb-2" />
          <Skeleton className="h-5 w-64" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  // If no startups, show empty state with call to action
  if (startups.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight font-display">Invoice Review</h1>
          <p className="text-muted-foreground">
            Review and approve startup expense reimbursements for {cohort.label}
          </p>
        </div>
        <EmptyState
          icon={<Users className="h-6 w-6" />}
          title="No startups enrolled"
          description="There are no startups enrolled in this cohort yet. Invite startups to get started with invoice submissions."
          action={
            <Link href={`/admin/${cohortSlug}/startups`}>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                View Startups
              </Button>
            </Link>
          }
        />
      </div>
    )
  }

  const pendingCount = groupedInvoices?.pending.length ?? 0

  async function handleMarkPaid(invoiceId: string) {
    setMarkingPaidId(invoiceId)
    try {
      await updateStatus({ id: invoiceId as Id<'invoices'>, status: 'paid' })
      toast.success('Invoice marked as paid')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to mark as paid')
    } finally {
      setMarkingPaidId(null)
    }
  }

  async function handleBatchMarkPaid() {
    if (validSelectedApprovedIds.size === 0) return
    setIsBatchMarking(true)
    try {
      await batchMarkPaid({
        ids: Array.from(validSelectedApprovedIds) as Id<'invoices'>[],
      })
      toast.success(
        `${validSelectedApprovedIds.size} invoice${validSelectedApprovedIds.size !== 1 ? 's' : ''} marked as paid`
      )
      setSelectedApprovedIds(new Set())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to mark invoices as paid')
    } finally {
      setIsBatchMarking(false)
    }
  }

  function toggleApprovedSelection(id: string) {
    setSelectedApprovedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  function toggleAllApproved() {
    if (!groupedInvoices) return
    const allIds = groupedInvoices.approved.map((i) => i._id)
    if (validSelectedApprovedIds.size === allIds.length) {
      setSelectedApprovedIds(new Set())
    } else {
      setSelectedApprovedIds(new Set(allIds))
    }
  }

  function renderInvoiceTable(invoices: typeof filteredInvoices) {
    if (!invoices || invoices.length === 0) return null
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Startup</TableHead>
            <TableHead>Vendor</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-12"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invoices.map((invoice) => (
            <TableRow
              key={invoice._id}
              className="cursor-pointer transition-colors hover:bg-muted/50"
              onClick={() => router.push(`/admin/${cohortSlug}/invoices/${invoice._id}`)}
            >
              <TableCell className="font-medium">
                {startupNameMap.get(invoice.startupId) || 'Unknown'}
              </TableCell>
              <TableCell>
                <span className="flex items-center gap-1.5">
                  {invoice.vendorName}
                  {invoice.isBatched && invoice.batchedFromIds && (
                    <Badge variant="info" className="text-[10px] px-1.5 py-0">
                      Batched ({invoice.batchedFromIds.length})
                    </Badge>
                  )}
                </span>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {new Date(invoice.invoiceDate).toLocaleDateString('en-GB', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}
              </TableCell>
              <TableCell className="font-mono text-sm">
                £{Number(invoice.amountGbp).toFixed(2)}
              </TableCell>
              <TableCell>
                <Badge variant={getInvoiceStatusVariant(invoice.status as InvoiceStatus)}>
                  {getInvoiceStatusLabel(invoice.status as InvoiceStatus)}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    router.push(`/admin/${cohortSlug}/invoices/${invoice._id}`)
                  }}
                >
                  Review
                  <ExternalLink className="ml-2 h-3 w-3" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    )
  }

  function renderApprovedInvoiceTable(invoices: typeof filteredInvoices) {
    if (!invoices || invoices.length === 0) return null
    const allSelected = invoices.length > 0 && validSelectedApprovedIds.size === invoices.length
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                checked={allSelected}
                onCheckedChange={toggleAllApproved}
                aria-label="Select all"
              />
            </TableHead>
            <TableHead>Startup</TableHead>
            <TableHead>Vendor</TableHead>
            <TableHead>Date</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-28"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invoices.map((invoice) => (
            <TableRow
              key={invoice._id}
              className="cursor-pointer transition-colors hover:bg-muted/50"
              onClick={() => router.push(`/admin/${cohortSlug}/invoices/${invoice._id}`)}
            >
              <TableCell onClick={(e) => e.stopPropagation()}>
                <Checkbox
                  checked={validSelectedApprovedIds.has(invoice._id)}
                  onCheckedChange={() => toggleApprovedSelection(invoice._id)}
                  aria-label={`Select ${invoice.vendorName}`}
                />
              </TableCell>
              <TableCell className="font-medium">
                {startupNameMap.get(invoice.startupId) || 'Unknown'}
              </TableCell>
              <TableCell>
                <span className="flex items-center gap-1.5">
                  {invoice.vendorName}
                  {invoice.isBatched && invoice.batchedFromIds && (
                    <Badge variant="info" className="text-[10px] px-1.5 py-0">
                      Batched ({invoice.batchedFromIds.length})
                    </Badge>
                  )}
                </span>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {new Date(invoice.invoiceDate).toLocaleDateString('en-GB', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}
              </TableCell>
              <TableCell className="font-mono text-sm">
                £{Number(invoice.amountGbp).toFixed(2)}
              </TableCell>
              <TableCell>
                <Badge variant={getInvoiceStatusVariant(invoice.status as InvoiceStatus)}>
                  {getInvoiceStatusLabel(invoice.status as InvoiceStatus)}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={markingPaidId === invoice._id}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleMarkPaid(invoice._id)
                  }}
                >
                  {markingPaidId === invoice._id ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  ) : (
                    <DollarSign className="mr-1 h-3 w-3" />
                  )}
                  Mark Paid
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    )
  }

  function renderCollapsibleSection(
    label: string,
    invoices: NonNullable<typeof filteredInvoices>,
    show: boolean,
    setShow: (v: boolean) => void,
    badgeVariant: 'warning' | 'success' | 'secondary' | 'destructive',
    renderFn: (invoices: typeof filteredInvoices) => React.ReactNode,
    headerExtra?: React.ReactNode
  ) {
    if (invoices.length === 0) return null
    return (
      <Card>
        <CardHeader className={show ? 'pb-3' : 'py-4'}>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShow(!show)}
              className="flex items-center gap-2 flex-1 text-left cursor-pointer"
            >
              {show ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
              <Badge variant={badgeVariant}>{invoices.length}</Badge>
              <CardTitle className="text-base">{label}</CardTitle>
            </button>
            {headerExtra}
          </div>
        </CardHeader>
        {show && <CardContent>{renderFn(invoices)}</CardContent>}
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight font-display">Invoice Review</h1>
        <p className="text-muted-foreground">
          Review and approve startup expense reimbursements for {cohort.label}
        </p>
      </div>

      <HowItWorks title="How reimbursements work">
        <p>
          <strong className="text-foreground">
            Founders deploy unlocked funding through reimbursements.
          </strong>{' '}
          They submit PDF invoices and receipts for legitimate business expenses. We can only
          approve expenses related to their startup which we deem appropriate and in good faith.
        </p>
        <p>
          <strong className="text-foreground">Naming rules:</strong> Invoices must be named{' '}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
            StartupName Invoice N.pdf
          </code>
          . Receipt filenames are generated automatically by the system. Multiple receipts per
          invoice are supported. Founders cannot submit incorrectly named invoices or duplicate
          numbers — this is enforced before submission to keep Xero clean.
        </p>
        <p>
          Founders cannot submit invoices exceeding their available balance (unlocked minus
          deployed). Larger invoices are preferred as they reduce admin overhead.
        </p>
      </HowItWorks>

      {/* Pending Alert */}
      {pendingCount > 0 && (
        <Card className="border-amber-200 bg-amber-50/50">
          <div className="flex items-center gap-3 p-4">
            <AlertCircle className="h-5 w-5 text-amber-600" />
            <div>
              <p className="font-medium text-amber-900">
                {pendingCount} invoice{pendingCount !== 1 ? 's' : ''} pending review
              </p>
              <p className="text-sm text-amber-700">Review required to process reimbursements</p>
            </div>
          </div>
        </Card>
      )}

      {/* Search + Filters */}
      <div className="grid gap-3 md:grid-cols-[1fr_220px_220px]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search startup, vendor, or file"
            className="pl-9"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(value) => setStatusFilter(value as InvoiceStatusFilter)}
        >
          <SelectTrigger>
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All states</SelectItem>
            <SelectItem value="submitted">Submitted</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
            <SelectItem value="paid">Paid</SelectItem>
          </SelectContent>
        </Select>
        <Popover open={startupFilterOpen} onOpenChange={setStartupFilterOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={startupFilterOpen}
              className="justify-between font-normal"
            >
              {startupFilter === 'all'
                ? 'All startups'
                : (startups?.find((s) => s._id === startupFilter)?.name ?? 'All startups')}
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent>
            <Command>
              <CommandInput placeholder="Search startup..." />
              <CommandList>
                <CommandEmpty>No startup found.</CommandEmpty>
                <CommandGroup>
                  <CommandItem
                    value="all"
                    onSelect={() => {
                      setStartupFilter('all')
                      setStartupFilterOpen(false)
                    }}
                  >
                    <Check
                      className={cn(
                        'mr-2 h-4 w-4',
                        startupFilter === 'all' ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    All startups
                  </CommandItem>
                  {startups?.map((s) => (
                    <CommandItem
                      key={s._id}
                      value={s.name}
                      onSelect={() => {
                        setStartupFilter(s._id)
                        setStartupFilterOpen(false)
                      }}
                    >
                      <Check
                        className={cn(
                          'mr-2 h-4 w-4',
                          startupFilter === s._id ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                      {s.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      {groupedInvoices &&
      (groupedInvoices.pending.length > 0 ||
        groupedInvoices.paid.length > 0 ||
        groupedInvoices.approved.length > 0 ||
        groupedInvoices.rejected.length > 0) ? (
        <div className="space-y-6">
          {/* Pending Review */}
          {renderCollapsibleSection(
            'Pending Review',
            groupedInvoices.pending,
            showPending,
            setShowPending,
            'warning',
            renderInvoiceTable
          )}

          {/* Approved - with checkboxes and mark paid */}
          {renderCollapsibleSection(
            'Approved',
            groupedInvoices.approved,
            showApproved,
            setShowApproved,
            'secondary',
            renderApprovedInvoiceTable,
            validSelectedApprovedIds.size > 0 ? (
              <Button
                size="sm"
                disabled={isBatchMarking}
                onClick={(e) => {
                  e.stopPropagation()
                  handleBatchMarkPaid()
                }}
              >
                {isBatchMarking ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <DollarSign className="mr-1 h-3 w-3" />
                )}
                Mark {validSelectedApprovedIds.size} Paid
              </Button>
            ) : undefined
          )}

          {/* Paid */}
          {renderCollapsibleSection(
            'Paid',
            groupedInvoices.paid,
            showPaid,
            setShowPaid,
            'success',
            renderInvoiceTable
          )}

          {/* Rejected */}
          {renderCollapsibleSection(
            'Rejected',
            groupedInvoices.rejected,
            showRejected,
            setShowRejected,
            'destructive',
            renderInvoiceTable
          )}
        </div>
      ) : (
        <EmptyState
          icon={<FileText className="h-6 w-6" />}
          title={
            (cohortInvoices?.length ?? 0) > 0 ? 'No invoices match your filters' : 'No invoices yet'
          }
          description={
            (cohortInvoices?.length ?? 0) > 0
              ? 'Try adjusting the search term or selected state.'
              : 'Invoices submitted by startups in this cohort will appear here for review.'
          }
        />
      )}
    </div>
  )
}
