'use client'

import { useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { ArrowLeft, ExternalLink, Eye, FileText, Landmark } from 'lucide-react'
import { BankDetailsDialog } from '@/components/bank-details-dialog'
import {
  getInvoiceStatusLabel,
  getInvoiceStatusVariant,
  type InvoiceStatus,
} from '@/lib/invoice-status'

function PdfFileLink({
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
  const isPdf = fileName.toLowerCase().endsWith('.pdf')
  return (
    <div className="flex items-center gap-2">
      {isPdf && (
        <button
          onClick={() => onPreview(url, fileName)}
          className="inline-flex items-center gap-1.5 text-primary hover:underline"
        >
          <FileText className="h-4 w-4" />
          {fileName}
          <Eye className="h-3.5 w-3.5" />
        </button>
      )}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={
          isPdf
            ? 'text-muted-foreground hover:text-primary'
            : 'inline-flex items-center gap-2 text-primary hover:underline'
        }
      >
        {!isPdf && (
          <>
            <FileText className="h-4 w-4" />
            {fileName}
          </>
        )}
        <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  )
}

export default function FounderInvoiceDetailPage() {
  const params = useParams<{ id: string }>()
  const invoiceId = params.id as Id<'invoices'>
  const invoicesData = useQuery(api.invoices.listForFounder)
  const bankDetails = useQuery(api.bankDetails.get)
  const [pdfViewerUrl, setPdfViewerUrl] = useState<string | null>(null)
  const [pdfViewerTitle, setPdfViewerTitle] = useState('')
  const [showBankDetails, setShowBankDetails] = useState(false)

  const invoice = useMemo(() => {
    if (!invoicesData?.invoices) return null
    return invoicesData.invoices.find((item) => item._id === invoiceId) ?? null
  }, [invoiceId, invoicesData])

  const fileUrl = useQuery(
    api.invoices.getFileUrl,
    invoice?.storageId ? { invoiceId, storageId: invoice.storageId } : 'skip'
  )

  // Component invoices for batch display
  const componentInvoices = useQuery(
    api.invoices.getComponentInvoices,
    invoice?.isBatched && invoice?.batchedFromIds ? { ids: invoice.batchedFromIds } : 'skip'
  )

  // Separate original invoices from receipts for batch invoices
  const originalInvoiceStorageIds: string[] = invoice?.originalInvoiceStorageIds ?? []
  const originalInvoiceFileNames: string[] = invoice?.originalInvoiceFileNames ?? []
  const receiptStorageIds: string[] =
    invoice?.receiptStorageIds ?? (invoice?.receiptStorageId ? [invoice.receiptStorageId] : [])
  const receiptFileNames: string[] =
    invoice?.receiptFileNames ?? (invoice?.receiptFileName ? [invoice.receiptFileName] : [])

  if (invoicesData === undefined) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-sm text-muted-foreground">Loading invoice...</div>
      </div>
    )
  }

  if (!invoice) {
    return (
      <EmptyState
        icon={<FileText className="h-6 w-6" />}
        title="Invoice not found"
        description="This invoice does not exist or you do not have access to it."
        action={
          <Link href="/founder/invoices">
            <Button variant="outline">Back to invoices</Button>
          </Link>
        }
      />
    )
  }

  const status = invoice.status as InvoiceStatus

  function openPreview(url: string, title: string) {
    setPdfViewerUrl(url)
    setPdfViewerTitle(title)
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div>
          <Link href="/founder/invoices">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Invoices
            </Button>
          </Link>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight font-display">{invoice.vendorName}</h1>
            <p className="text-muted-foreground">Invoice details and review status</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowBankDetails(true)}>
              <Landmark className="mr-2 h-4 w-4" />
              Bank Details
            </Button>
            <Badge variant={getInvoiceStatusVariant(status)} className="h-8 px-3 flex items-center">
              {getInvoiceStatusLabel(status)}
            </Badge>
          </div>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <div className="space-y-6 md:col-span-2">
          {/* Combined Invoice Info */}
          {invoice.isBatched && componentInvoices && componentInvoices.length > 0 && (
            <Card className="border-blue-200 bg-blue-50/50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  Combined Invoice
                  <Badge variant="info">{componentInvoices.length} invoices combined</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-blue-800 mb-3">
                  This historical invoice was created from legacy batch processing.
                </p>
                <div className="space-y-2">
                  {componentInvoices.map((comp) => (
                    <div
                      key={comp._id}
                      className="flex items-center justify-between border border-blue-200 bg-white rounded px-3 py-2"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <PdfFileLink
                          invoiceId={comp._id}
                          storageId={comp.storageId}
                          fileName={comp.fileName}
                          onPreview={openPreview}
                        />
                      </div>
                      <span className="text-sm font-mono shrink-0 ml-3">
                        {'\u00A3'}
                        {Number(comp.amountGbp).toFixed(2)}
                      </span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between border-t border-blue-300 pt-2 mt-2">
                    <span className="text-sm font-semibold">Total</span>
                    <span className="text-sm font-mono font-semibold">
                      {'\u00A3'}
                      {Number(invoice.amountGbp).toFixed(2)}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Invoice Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <p className="text-sm text-muted-foreground">Invoice Date</p>
                  <p className="font-medium">
                    {new Date(invoice.invoiceDate).toLocaleDateString('en-GB', {
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                    })}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Amount</p>
                  <p className="font-mono text-lg font-semibold">
                    {'\u00A3'}
                    {Number(invoice.amountGbp).toFixed(2)}
                  </p>
                </div>
                {invoice.dueDate && (
                  <div>
                    <p className="text-sm text-muted-foreground">Due Date</p>
                    <p className="font-medium">
                      {new Date(invoice.dueDate).toLocaleDateString('en-GB', {
                        day: 'numeric',
                        month: 'long',
                        year: 'numeric',
                      })}
                    </p>
                  </div>
                )}
              </div>

              {invoice.description && (
                <div>
                  <p className="text-sm text-muted-foreground">Description</p>
                  <p className="whitespace-pre-wrap text-sm">{invoice.description}</p>
                </div>
              )}

              <div>
                <p className="mb-1 text-sm text-muted-foreground">Invoice file</p>
                {fileUrl ? (
                  <PdfFileLink
                    invoiceId={invoiceId}
                    storageId={invoice.storageId}
                    fileName={invoice.fileName || 'View invoice'}
                    onPreview={openPreview}
                  />
                ) : (
                  <span className="text-sm text-muted-foreground">Loading file...</span>
                )}
              </div>

              {/* Receipt Files */}
              {receiptStorageIds.length > 0 && (
                <div>
                  <p className="mb-1 text-sm text-muted-foreground">
                    {invoice.isBatched
                      ? 'Receipts'
                      : `Receipt file${receiptStorageIds.length > 1 ? 's' : ''}`}
                  </p>
                  <div className="space-y-1">
                    {receiptStorageIds.map((sid, i) => (
                      <PdfFileLink
                        key={sid}
                        invoiceId={invoiceId}
                        storageId={sid}
                        fileName={receiptFileNames[i] || `Receipt ${i + 1}`}
                        onPreview={openPreview}
                      />
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Status Timeline</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="text-muted-foreground">
                Submitted on{' '}
                {new Date(invoice._creationTime).toLocaleDateString('en-GB', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}
              </p>
              {invoice.approvedAt && (
                <p className="text-emerald-700">
                  Approved on {new Date(invoice.approvedAt).toLocaleDateString('en-GB')}
                </p>
              )}
              {invoice.paidAt && (
                <p className="text-blue-700">
                  Paid on {new Date(invoice.paidAt).toLocaleDateString('en-GB')}
                </p>
              )}
            </CardContent>
          </Card>

          {invoice.adminComment && (
            <Card>
              <CardHeader>
                <CardTitle>Admin Comment</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm">{invoice.adminComment}</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <BankDetailsDialog
        open={showBankDetails}
        onOpenChange={setShowBankDetails}
        bankDetails={bankDetails}
        startupName="Your startup"
      />

      {/* PDF Preview Modal */}
      <Dialog open={!!pdfViewerUrl} onOpenChange={(open) => !open && setPdfViewerUrl(null)}>
        <DialogContent className="max-w-5xl h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{pdfViewerTitle}</DialogTitle>
            <DialogDescription>PDF preview</DialogDescription>
          </DialogHeader>
          {pdfViewerUrl && <iframe src={pdfViewerUrl} className="flex-1 w-full rounded border" />}
        </DialogContent>
      </Dialog>
    </div>
  )
}
