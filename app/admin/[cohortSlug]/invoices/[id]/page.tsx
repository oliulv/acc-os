'use client'

import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import Link from 'next/link'
import { useState, useCallback, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  ArrowLeft,
  CheckCircle2,
  DollarSign,
  FileText,
  ExternalLink,
  Calendar,
  Building2,
  Landmark,
  User,
  TrendingDown,
  Eye,
} from 'lucide-react'
import { BankDetailsDialog } from '@/components/bank-details-dialog'
import { InvoiceActions } from './InvoiceActions'
import {
  getInvoiceStatusLabel,
  getInvoiceStatusVariant,
  type InvoiceStatus,
} from '@/lib/invoice-status'

function ReceiptLink({
  invoiceId,
  storageId,
  fileName,
  onPreview,
}: {
  invoiceId: Id<'invoices'>
  storageId: string
  fileName: string
  onPreview: (url: string, title: string) => void
}) {
  const url = useQuery(api.invoices.getFileUrl, {
    invoiceId,
    storageId: storageId as Id<'_storage'>,
  })
  if (!url) return <span className="text-sm text-muted-foreground">Loading file...</span>
  return (
    <div className="inline-flex items-center gap-2">
      <button
        onClick={() => onPreview(url, fileName)}
        className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-700 hover:underline cursor-pointer"
      >
        <FileText className="h-4 w-4" />
        {fileName}
        <Eye className="h-3 w-3" />
      </button>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-muted-foreground hover:text-foreground"
        title="Open in new tab"
      >
        <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  )
}

export default function InvoiceDetailPage() {
  const params = useParams<{ cohortSlug: string; id: string }>()
  const router = useRouter()
  const searchParams = useSearchParams()
  const cohortSlug = params.cohortSlug ?? ''
  const invoiceId = params.id as Id<'invoices'>

  const fromStartupId = searchParams.get('startupId') as Id<'startups'> | null

  const [pdfViewerUrl, setPdfViewerUrl] = useState<string | null>(null)
  const [pdfViewerTitle, setPdfViewerTitle] = useState('')
  const [showBankDetails, setShowBankDetails] = useState(false)

  const cohort = useQuery(api.cohorts.getBySlug, { slug: cohortSlug })
  const invoice = useQuery(api.invoices.getById, { id: invoiceId })
  const startup = useQuery(
    api.startups.getById,
    invoice?.startupId ? { id: invoice.startupId } : 'skip'
  )
  const fileUrl = useQuery(
    api.invoices.getFileUrl,
    invoice?.storageId ? { invoiceId, storageId: invoice.storageId } : 'skip'
  )

  // Separate original invoices from receipts for batch invoices
  const originalInvoiceStorageIds: string[] = invoice?.originalInvoiceStorageIds ?? []
  const originalInvoiceFileNames: string[] = invoice?.originalInvoiceFileNames ?? []
  const receiptStorageIds: string[] =
    invoice?.receiptStorageIds ?? (invoice?.receiptStorageId ? [invoice.receiptStorageId] : [])
  const receiptFileNames: string[] =
    invoice?.receiptFileNames ?? (invoice?.receiptFileName ? [invoice.receiptFileName] : [])

  const bankDetails = useQuery(
    api.bankDetails.getByStartupId,
    invoice?.startupId ? { startupId: invoice.startupId } : 'skip'
  )
  const founderProfile = useQuery(
    api.founderProfile.getByUserId,
    invoice?.uploadedByUserId ? { userId: invoice.uploadedByUserId } : 'skip'
  )
  const fundingSummary = useQuery(
    api.funding.summaryForAdminStartup,
    invoice?.startupId ? { startupId: invoice.startupId } : 'skip'
  )

  // Component invoices for batch display
  const componentInvoices = useQuery(
    api.invoices.getComponentInvoices,
    invoice?.isBatched && invoice?.batchedFromIds ? { ids: invoice.batchedFromIds } : 'skip'
  )

  // Auto-navigate: find the next submitted invoice (same startup first)
  const nextSubmittedId = useQuery(
    api.invoices.getNextSubmitted,
    cohort && invoice?.startupId
      ? {
          cohortId: cohort._id,
          excludeId: invoiceId,
          startupId: invoice.startupId,
        }
      : 'skip'
  )

  // Deterministic back URL
  const backUrl = useMemo(() => {
    if (fromStartupId) {
      return `/admin/${cohortSlug}/startups/${fromStartupId}`
    }
    return `/admin/${cohortSlug}/invoices`
  }, [cohortSlug, fromStartupId])

  const handleApproved = useCallback(() => {
    if (nextSubmittedId) {
      const nextUrl = `/admin/${cohortSlug}/invoices/${nextSubmittedId}${fromStartupId ? `?startupId=${fromStartupId}` : ''}`
      router.push(nextUrl)
    } else {
      router.push(`/admin/${cohortSlug}/invoices?showApproved=1`)
    }
  }, [nextSubmittedId, cohortSlug, fromStartupId, router])

  function openPdfViewer(url: string, title: string) {
    setPdfViewerUrl(url)
    setPdfViewerTitle(title)
  }

  // Loading state
  if (cohort === undefined || invoice === undefined) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-sm text-muted-foreground">Loading invoice...</div>
      </div>
    )
  }

  // Cohort not found
  if (!cohort) {
    router.push('/admin/cohorts')
    return null
  }

  // Invoice not found
  if (!invoice) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <h2 className="text-xl font-semibold mb-2">Invoice Not Found</h2>
          <p className="text-muted-foreground mb-4">This invoice does not exist.</p>
          <Link href={`/admin/${cohortSlug}/invoices`}>
            <Button variant="ghost">Back to Invoices</Button>
          </Link>
        </div>
      </div>
    )
  }

  // Verify invoice belongs to a startup in this cohort
  if (startup && startup.cohortId !== cohort._id) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <h2 className="text-xl font-semibold mb-2">Invoice Not Found</h2>
          <p className="text-muted-foreground mb-4">
            This invoice does not belong to the current cohort.
          </p>
          <Link href={`/admin/${cohortSlug}/invoices`}>
            <Button variant="ghost">Back to Invoices</Button>
          </Link>
        </div>
      </div>
    )
  }

  const canApprove = invoice.status === 'submitted' || invoice.status === 'under_review'
  const canMarkPaid = invoice.status === 'approved'

  // If this legacy invoice has been batched into another, show redirect.
  if (invoice.batchedIntoId) {
    return (
      <div className="space-y-6">
        <div>
          <Link href={backUrl}>
            <Button variant="ghost" size="sm">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>
          </Link>
        </div>
        <Card className="border-blue-200 bg-blue-50/50">
          <CardContent className="pt-6">
            <p className="text-sm text-blue-900">
              This historical invoice was included in a legacy batch invoice.
            </p>
            <Link href={`/admin/${cohortSlug}/invoices/${invoice.batchedIntoId}`}>
              <Button variant="link" className="px-0 mt-2">
                View legacy batch invoice &rarr;
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-4">
        <div>
          <Link href={backUrl}>
            <Button variant="ghost" size="sm">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>
          </Link>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight font-display">Invoice Review</h1>
            <p className="text-muted-foreground">
              Review invoice details and approve or reject reimbursement
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowBankDetails(true)}>
              <Landmark className="mr-2 h-4 w-4" />
              Bank Details
            </Button>
            <Badge
              variant={getInvoiceStatusVariant(invoice.status as InvoiceStatus)}
              className="text-sm h-8 px-3 flex items-center"
            >
              {getInvoiceStatusLabel(invoice.status as InvoiceStatus)}
            </Badge>
          </div>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        {/* Main Content */}
        <div className="md:col-span-2 flex flex-col gap-6">
          {/* Invoice Details */}
          <Card>
            <CardHeader>
              <CardTitle>Invoice Details</CardTitle>
              <CardDescription>Information about this invoice submission</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="text-sm font-medium text-muted-foreground">Vendor Name</label>
                  <p className="text-lg font-medium">{invoice.vendorName}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-muted-foreground">Amount</label>
                  <p className="text-lg font-medium font-mono">
                    {'\u00A3'}
                    {Number(invoice.amountGbp).toFixed(2)}
                  </p>
                </div>
                <div>
                  <label className="text-sm font-medium text-muted-foreground">Invoice Date</label>
                  <p className="text-sm">
                    {new Date(invoice.invoiceDate).toLocaleDateString('en-GB', {
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                    })}
                  </p>
                </div>
                {invoice.dueDate && (
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">Due Date</label>
                    <p className="text-sm">
                      {new Date(invoice.dueDate).toLocaleDateString('en-GB', {
                        day: 'numeric',
                        month: 'long',
                        year: 'numeric',
                      })}
                    </p>
                  </div>
                )}
                {invoice.category && (
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">Category</label>
                    <p className="text-sm">{invoice.category}</p>
                  </div>
                )}
              </div>

              {invoice.description && (
                <div>
                  <label className="text-sm font-medium text-muted-foreground">Description</label>
                  <p className="text-sm whitespace-pre-wrap">{invoice.description}</p>
                </div>
              )}

              {/* Invoice File */}
              <div>
                <label className="text-sm font-medium text-muted-foreground mb-2 block">
                  Invoice File
                </label>
                {fileUrl ? (
                  <div className="inline-flex items-center gap-2">
                    <button
                      onClick={() => openPdfViewer(fileUrl, invoice.fileName || 'Invoice')}
                      className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-700 hover:underline cursor-pointer"
                    >
                      <FileText className="h-4 w-4" />
                      {invoice.fileName || 'View Invoice Document'}
                      <Eye className="h-3 w-3" />
                    </button>
                    <a
                      href={fileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-foreground"
                      title="Open in new tab"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                ) : (
                  <span className="text-sm text-muted-foreground">Loading file...</span>
                )}
              </div>

              {/* Receipt Files */}
              {receiptStorageIds.length > 0 && (
                <div>
                  <label className="text-sm font-medium text-muted-foreground mb-2 block">
                    {invoice.isBatched
                      ? 'Receipts'
                      : `Receipt File${receiptStorageIds.length > 1 ? 's' : ''}`}
                  </label>
                  <div className="space-y-1">
                    {receiptStorageIds.map((sid, i) => (
                      <ReceiptLink
                        key={sid}
                        invoiceId={invoiceId}
                        storageId={sid}
                        fileName={receiptFileNames[i] || `Receipt ${i + 1}`}
                        onPreview={openPdfViewer}
                      />
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Batched Invoice Details — component invoices table */}
          {invoice.isBatched && componentInvoices && componentInvoices.length > 0 && (
            <Card className="border-blue-200">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  Combined Invoice
                  <Badge variant="info">{componentInvoices.length} invoices combined</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Invoice</TableHead>
                      <TableHead>Vendor</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {componentInvoices.map((comp) => (
                      <TableRow key={comp._id}>
                        <TableCell>
                          <ReceiptLink
                            invoiceId={comp._id}
                            storageId={comp.storageId}
                            fileName={comp.fileName}
                            onPreview={openPdfViewer}
                          />
                        </TableCell>
                        <TableCell>{comp.vendorName}</TableCell>
                        <TableCell className="text-right font-mono">
                          {'\u00A3'}
                          {Number(comp.amountGbp).toFixed(2)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {/* Admin Comments */}
          {invoice.adminComment && (
            <Card>
              <CardHeader>
                <CardTitle>Admin Comment</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm whitespace-pre-wrap">{invoice.adminComment}</p>
              </CardContent>
            </Card>
          )}

          {/* Funding Impact — hidden for rejected invoices */}
          {fundingSummary && invoice.status !== 'rejected' && (
            <Card className="flex-1">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle>Funding Impact</CardTitle>
                <TrendingDown className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent className="space-y-4">
                {(() => {
                  const invoiceAmount = invoice.amountGbp
                  const currentAvailable = fundingSummary.available
                  const committed = fundingSummary.committed ?? 0
                  const barTotal = fundingSummary.claimable || 1
                  const deployedPct = Math.min(100, (fundingSummary.deployed / barTotal) * 100)
                  const committedPct = Math.min(100 - deployedPct, (committed / barTotal) * 100)

                  // Only show the amber "This invoice" segment for submitted/under_review
                  const showThisInvoice =
                    invoice.status === 'submitted' || invoice.status === 'under_review'
                  const thisPct = showThisInvoice
                    ? Math.min(100 - deployedPct - committedPct, (invoiceAmount / barTotal) * 100)
                    : 0
                  const afterAvailable = Math.max(0, currentAvailable - invoiceAmount)

                  return (
                    <>
                      <div className="grid grid-cols-4 gap-2 text-xs">
                        <div className="border bg-muted/40 px-2 py-1.5">
                          <p className="text-muted-foreground">Unlocked</p>
                          <p className="font-medium">
                            {'\u00A3'}
                            {fundingSummary.unlocked.toLocaleString('en-GB')}
                          </p>
                        </div>
                        <div className="border bg-muted/40 px-2 py-1.5">
                          <p className="text-muted-foreground">Deployed</p>
                          <p className="font-medium text-blue-600">
                            {'\u00A3'}
                            {fundingSummary.deployed.toLocaleString('en-GB')}
                          </p>
                        </div>
                        <div className="border bg-muted/40 px-2 py-1.5">
                          <p className="text-muted-foreground">Committed</p>
                          <p className="font-medium text-violet-600">
                            {'\u00A3'}
                            {committed.toLocaleString('en-GB')}
                          </p>
                        </div>
                        <div className="border bg-muted/40 px-2 py-1.5">
                          <p className="text-muted-foreground">Available</p>
                          <p className="font-medium text-green-600">
                            {'\u00A3'}
                            {currentAvailable.toLocaleString('en-GB')}
                          </p>
                        </div>
                      </div>

                      {/* Stacked bar */}
                      <div>
                        <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                          <span>Funding usage</span>
                          <span>
                            {'\u00A3'}
                            {fundingSummary.claimable.toLocaleString('en-GB')} claimable
                          </span>
                        </div>
                        <div className="relative h-3 overflow-hidden rounded-full bg-muted">
                          <div
                            className="absolute inset-y-0 left-0 bg-blue-600 transition-all"
                            style={{ width: `${deployedPct}%` }}
                          />
                          <div
                            className="absolute inset-y-0 bg-violet-500 transition-all"
                            style={{
                              left: `${deployedPct}%`,
                              width: `${committedPct}%`,
                            }}
                          />
                          {showThisInvoice && (
                            <div
                              className="absolute inset-y-0 bg-amber-500 transition-all"
                              style={{
                                left: `${deployedPct + committedPct}%`,
                                width: `${thisPct}%`,
                              }}
                            />
                          )}
                        </div>
                        <div className="flex items-center gap-4 mt-1.5 text-[10px] text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <span className="inline-block h-2 w-2 rounded-full bg-blue-600" />
                            Deployed
                          </span>
                          <span className="flex items-center gap-1">
                            <span className="inline-block h-2 w-2 rounded-full bg-violet-500" />
                            Approved (not paid)
                          </span>
                          {showThisInvoice && (
                            <span className="flex items-center gap-1">
                              <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
                              This invoice
                            </span>
                          )}
                          <span className="flex items-center gap-1">
                            <span className="inline-block h-2 w-2 rounded-full bg-muted" />
                            Remaining
                          </span>
                        </div>
                      </div>

                      {/* Status-specific info line */}
                      <div className="border-t pt-3">
                        {showThisInvoice && (
                          <>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-muted-foreground">
                                Available after reimbursement
                              </span>
                              <span className="font-mono font-semibold">
                                {'\u00A3'}
                                {currentAvailable.toLocaleString('en-GB')}
                                {' \u2192 '}
                                <span
                                  className={
                                    afterAvailable === 0 ? 'text-red-600' : 'text-green-600'
                                  }
                                >
                                  {'\u00A3'}
                                  {afterAvailable.toLocaleString('en-GB')}
                                </span>
                              </span>
                            </div>
                            {committed > 0 && (
                              <p className="mt-1 text-xs text-violet-600">
                                {'\u00A3'}
                                {committed.toLocaleString('en-GB')} committed (approved, not yet
                                paid)
                              </p>
                            )}
                            {invoiceAmount > currentAvailable && (
                              <p className="mt-1.5 text-xs text-red-600">
                                This invoice exceeds available funding by {'\u00A3'}
                                {(invoiceAmount - currentAvailable).toLocaleString('en-GB')}
                              </p>
                            )}
                          </>
                        )}
                        {invoice.status === 'approved' && (
                          <p className="text-sm text-violet-600">
                            This invoice is approved &mdash; {'\u00A3'}
                            {invoiceAmount.toLocaleString('en-GB')} committed, awaiting payment.
                          </p>
                        )}
                        {invoice.status === 'paid' && (
                          <p className="text-sm text-blue-600">
                            This invoice has been paid &mdash; {'\u00A3'}
                            {invoiceAmount.toLocaleString('en-GB')} deployed.
                          </p>
                        )}
                      </div>
                    </>
                  )
                })()}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Sidebar */}
        <div className="flex flex-col gap-6">
          {/* Startup Info */}
          <Card>
            <CardHeader>
              <CardTitle>Startup</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-center gap-2">
                <Building2 className="h-4 w-4 text-muted-foreground" />
                {startup ? (
                  <Link
                    href={`/admin/${cohortSlug}/startups/${startup.slug}`}
                    className="text-blue-600 hover:underline font-medium"
                  >
                    {startup.name}
                  </Link>
                ) : (
                  <span className="text-sm text-muted-foreground">Loading...</span>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Uploader Info */}
          {(founderProfile || invoice.uploadedByUserId) && (
            <Card>
              <CardHeader>
                <CardTitle>Uploaded By</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {founderProfile ? (
                  <div className="flex items-center gap-2">
                    <User className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">{founderProfile.fullName}</p>
                      <p className="text-xs text-muted-foreground">
                        {founderProfile.personalEmail}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <User className="h-4 w-4 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground italic">Deleted user</p>
                  </div>
                )}
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Calendar className="h-3 w-3" />
                  {new Date(invoice._creationTime).toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Approval History */}
          {(invoice.approvedAt || invoice.paidAt) && (
            <Card>
              <CardHeader>
                <CardTitle>History</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {invoice.approvedAt && (
                  <div className="flex items-center gap-2 text-green-600">
                    <CheckCircle2 className="h-4 w-4" />
                    <span>
                      Approved on {new Date(invoice.approvedAt).toLocaleDateString('en-GB')}
                    </span>
                  </div>
                )}
                {invoice.paidAt && (
                  <div className="flex items-center gap-2 text-blue-600">
                    <DollarSign className="h-4 w-4" />
                    <span>
                      Marked as paid on {new Date(invoice.paidAt).toLocaleDateString('en-GB')}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Actions */}
          {(canApprove || canMarkPaid) && (
            <InvoiceActions
              invoiceId={invoice._id}
              currentStatus={invoice.status}
              cohortId={cohort._id}
              startupId={invoice.startupId}
              className="flex-1"
              onApproved={handleApproved}
            />
          )}
        </div>
      </div>

      <BankDetailsDialog
        open={showBankDetails}
        onOpenChange={setShowBankDetails}
        bankDetails={bankDetails}
        startupName={startup?.name ?? 'Startup'}
      />

      {/* PDF Viewer Modal */}
      <Dialog
        open={!!pdfViewerUrl}
        onOpenChange={(open) => {
          if (!open) setPdfViewerUrl(null)
        }}
      >
        <DialogContent className="max-w-5xl h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{pdfViewerTitle}</DialogTitle>
            <DialogDescription>Preview of the uploaded PDF document</DialogDescription>
          </DialogHeader>
          {pdfViewerUrl && <iframe src={pdfViewerUrl} className="flex-1 w-full rounded border" />}
        </DialogContent>
      </Dialog>
    </div>
  )
}
