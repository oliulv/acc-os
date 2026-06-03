'use client'

import { useState, useEffect, useRef, useCallback, Fragment } from 'react'
import { useRouter } from 'next/navigation'
import { useMutation, useQuery, useAction } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Id } from '@/convex/_generated/dataModel'
import { ConvexError } from 'convex/values'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { founderInvoiceUploadSchema, type FounderInvoiceUploadFormData } from '@/lib/schemas'
import {
  Upload,
  ArrowLeft,
  AlertTriangle,
  Info,
  X,
  Plus,
  Loader2,
  FileText,
  Eye,
  Replace,
  CheckCircle2,
  Circle,
  RefreshCw,
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import Link from 'next/link'
import { toast } from 'sonner'

export default function NewInvoicePage() {
  const router = useRouter()
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null)
  const [receiptFiles, setReceiptFiles] = useState<File[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isExtracting, setIsExtracting] = useState(false)
  const [amountMismatchWarning, setAmountMismatchWarning] = useState<string | null>(null)
  const [extractionStep, setExtractionStep] = useState(0) // 0=idle, 1=upload, 2=analyze, 3=convert, 4=populate, 5=done
  const [needsConfirmation, setNeedsConfirmation] = useState(false)
  const [extractionResult, setExtractionResult] = useState<{
    invoiceCurrency: string
    totalAmountOriginal: number
    receiptCurrencies: string[]
    receiptAmountsOriginal: number[]
    totalAmountGbp: number
    receiptAmountsGbp: number[]
    receiptTotalGbp: number
    currencyConverted: boolean
    unconvertedCurrencies: string[]
  } | null>(null)
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState<string | null>(null)
  const [pdfPreviewTitle, setPdfPreviewTitle] = useState('')
  const invoiceInputRef = useRef<HTMLInputElement>(null)
  const receiptInputRef = useRef<HTMLInputElement>(null)
  const formCardRef = useRef<HTMLDivElement>(null)
  const extractionTriggered = useRef(false)
  // Track storage IDs from extraction uploads for cleanup
  const extractionStorageIds = useRef<string[]>([])
  const abortControllerRef = useRef<AbortController | null>(null)

  const generateUploadUrl = useMutation(api.invoices.generateUploadUrl)
  const claimStorageUpload = useMutation(api.invoices.claimStorageUpload)
  const createInvoice = useMutation(api.invoices.create)
  const deleteStorageFile = useMutation(api.invoices.deleteStorageFile)
  const extractInvoiceData = useAction(api.ai.extractInvoiceData)
  const invoiceInfo = useQuery(api.invoices.getFounderInvoiceInfo)
  const fundingSummary = useQuery(api.funding.summaryForFounder)

  const startupName = invoiceInfo?.startupName ?? null
  const expectedNumber = invoiceInfo?.nextInvoiceNumber ?? 1
  const available = fundingSummary?.available ?? 0

  const form = useForm<FounderInvoiceUploadFormData>({
    resolver: zodResolver(founderInvoiceUploadSchema),
    defaultValues: {
      vendor_name: '',
      invoice_date: '',
      description: '',
    },
  })

  const resetExtractionIfNeeded = useCallback(() => {
    if (extractionStep === 0 && !isExtracting) return
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    setExtractionStep(0)
    setExtractionResult(null)
    setAmountMismatchWarning(null)
    form.setValue('vendor_name', '')
    form.setValue('description', '')
    form.setValue('invoice_date', '')
    form.setValue('amount_gbp', undefined as any)
    extractionTriggered.current = true
    setNeedsConfirmation(true)
  }, [extractionStep, isExtracting, form])

  // Cleanup extraction storage files on unmount (if user navigates away without submitting)
  const cleanupExtractionFiles = useCallback(async () => {
    for (const id of extractionStorageIds.current) {
      try {
        await deleteStorageFile({ storageId: id as Id<'_storage'> })
      } catch {
        // Ignore errors — file may already be deleted or used
      }
    }
    extractionStorageIds.current = []
  }, [deleteStorageFile])

  useEffect(() => {
    return () => {
      cleanupExtractionFiles()
    }
  }, [cleanupExtractionFiles])

  // Auto-extract invoice data when both invoice + receipt files are available
  useEffect(() => {
    if (
      !invoiceFile ||
      receiptFiles.length === 0 ||
      extractionTriggered.current ||
      isExtracting ||
      needsConfirmation
    )
      return
    extractionTriggered.current = true

    async function runExtraction() {
      setIsExtracting(true)
      setAmountMismatchWarning(null)
      setExtractionStep(1)
      setExtractionResult(null)

      // Create abort controller for this extraction
      const controller = new AbortController()
      abortControllerRef.current = controller

      // Clean up any previous extraction files first
      await cleanupExtractionFiles()

      try {
        if (controller.signal.aborted) return

        // Upload files to get storage IDs
        const invoiceUploadUrl = await generateUploadUrl()
        if (controller.signal.aborted) return

        const invoiceResult = await fetch(invoiceUploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': invoiceFile!.type },
          body: invoiceFile,
        })
        if (!invoiceResult.ok) throw new Error('Failed to upload invoice for extraction')
        if (controller.signal.aborted) return

        const { storageId: invoiceStorageId } = await invoiceResult.json()
        await claimStorageUpload({ storageId: invoiceStorageId as Id<'_storage'> })
        extractionStorageIds.current.push(invoiceStorageId)

        const receiptStorageIds: string[] = []
        for (const file of receiptFiles) {
          if (controller.signal.aborted) return
          const uploadUrl = await generateUploadUrl()
          const result = await fetch(uploadUrl, {
            method: 'POST',
            headers: { 'Content-Type': file.type },
            body: file,
          })
          if (!result.ok) throw new Error(`Failed to upload receipt for extraction`)
          const { storageId } = await result.json()
          await claimStorageUpload({ storageId: storageId as Id<'_storage'> })
          receiptStorageIds.push(storageId)
          extractionStorageIds.current.push(storageId)
        }

        if (controller.signal.aborted) return
        setExtractionStep(2)

        const extracted = await extractInvoiceData({
          invoiceStorageId,
          receiptStorageIds: receiptStorageIds as any,
        })

        if (controller.signal.aborted) return

        // Show currency conversion step briefly if applicable
        setExtractionStep(3)
        if (extracted.currencyConverted) {
          await new Promise((resolve) => setTimeout(resolve, 600))
        }

        if (controller.signal.aborted) return

        // Populate form fields
        if (extracted.vendorNames) form.setValue('vendor_name', extracted.vendorNames)
        if (extracted.description) form.setValue('description', extracted.description)
        if (extracted.invoiceDate) form.setValue('invoice_date', extracted.invoiceDate)
        if (extracted.totalAmountGbp > 0) form.setValue('amount_gbp', extracted.totalAmountGbp)

        setExtractionStep(5)
        setExtractionResult({
          invoiceCurrency: extracted.invoiceCurrency,
          totalAmountOriginal: extracted.totalAmountOriginal,
          receiptCurrencies: extracted.receiptCurrencies,
          receiptAmountsOriginal: extracted.receiptAmountsOriginal,
          totalAmountGbp: extracted.totalAmountGbp,
          receiptAmountsGbp: extracted.receiptAmountsGbp,
          receiptTotalGbp: extracted.receiptTotalGbp,
          currencyConverted: extracted.currencyConverted,
          unconvertedCurrencies: extracted.unconvertedCurrencies,
        })

        if (extracted.amountMismatch) {
          setAmountMismatchWarning(
            `Invoice total (\u00A3${extracted.totalAmountGbp.toFixed(2)}) doesn\u2019t match receipt total (\u00A3${extracted.receiptTotalGbp.toFixed(2)})`
          )
        }

        toast.success('Invoice details extracted automatically')

        // Brief pause to let them see the pipeline complete, then scroll to form
        setTimeout(() => {
          formCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }, 400)
      } catch {
        if (!controller.signal.aborted) {
          setExtractionStep(0)
          setExtractionResult(null)
          toast.error('Could not extract invoice details. Please fill in manually.')
        }
      } finally {
        setIsExtracting(false)
      }
    }

    runExtraction()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceFile, receiptFiles.length, needsConfirmation])

  // Reset extraction when files change after extraction has completed
  useEffect(() => {
    if (extractionStep === 5) {
      // Extraction already completed — files changed, require confirmation
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
        abortControllerRef.current = null
      }
      setExtractionStep(0)
      setExtractionResult(null)
      setAmountMismatchWarning(null)
      form.setValue('vendor_name', '')
      form.setValue('description', '')
      form.setValue('invoice_date', '')
      form.setValue('amount_gbp', undefined as any)
      extractionTriggered.current = true // prevent auto-trigger
      setNeedsConfirmation(true)
    } else if (extractionStep === 0 && !needsConfirmation) {
      // No extraction yet — allow auto-trigger
      extractionTriggered.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceFile, receiptFiles])

  const invoiceNameError = (() => {
    if (!invoiceFile) return null
    if (!invoiceFile.name.toLowerCase().endsWith('.pdf')) return 'Must be a PDF file'
    if (!startupName) return null
    const normalizedName = startupName.normalize('NFC')
    const normalizedFileName = invoiceFile.name.normalize('NFC')
    const pattern = new RegExp(
      `^${normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} Invoice \\d+\\.pdf$`,
      'i'
    )
    if (!pattern.test(normalizedFileName))
      return `Must be named "${startupName} Invoice ${expectedNumber}.pdf"`
    const num = invoiceFile.name.match(/Invoice (\d+)\.pdf$/i)?.[1]
    if (num && parseInt(num, 10) !== expectedNumber)
      return `Invoice number must be ${expectedNumber}. Please name your file "${startupName} Invoice ${expectedNumber}.pdf".`
    return null
  })()

  const receiptPdfError = receiptFiles.some((f) => !f.name.toLowerCase().endsWith('.pdf'))
    ? 'All receipts must be PDF files'
    : null

  const amountValue = form.watch('amount_gbp')
  const amountExceedsBalance = typeof amountValue === 'number' && amountValue > available

  const canSubmit =
    !!invoiceFile &&
    receiptFiles.length > 0 &&
    !invoiceNameError &&
    !receiptPdfError &&
    !amountExceedsBalance

  function previewFile(file: File) {
    const url = URL.createObjectURL(file)
    setPdfPreviewUrl(url)
    setPdfPreviewTitle(file.name)
  }

  const onSubmit = async (data: FounderInvoiceUploadFormData) => {
    if (!invoiceFile) {
      toast.error('Please select an invoice file to upload')
      return
    }

    if (receiptFiles.length === 0) {
      toast.error('Please select at least one receipt file')
      return
    }

    if (invoiceNameError) {
      toast.error(invoiceNameError)
      return
    }

    if (receiptPdfError) {
      toast.error(receiptPdfError)
      return
    }

    if (amountExceedsBalance) {
      toast.error(`Amount exceeds available balance of \u00A3${available.toFixed(2)}`)
      return
    }

    setIsSubmitting(true)

    try {
      // Clean up extraction files before final upload (they were just for AI)
      await cleanupExtractionFiles()

      // Upload invoice file
      const invoiceUploadUrl = await generateUploadUrl()
      const invoiceUploadResult = await fetch(invoiceUploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': invoiceFile.type },
        body: invoiceFile,
      })
      if (!invoiceUploadResult.ok) throw new Error('Failed to upload invoice file')
      const { storageId: invoiceStorageId } = await invoiceUploadResult.json()
      await claimStorageUpload({ storageId: invoiceStorageId as Id<'_storage'> })

      // Upload all receipt files sequentially
      const receiptStorageIds: string[] = []
      for (const file of receiptFiles) {
        const uploadUrl = await generateUploadUrl()
        const result = await fetch(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': file.type },
          body: file,
        })
        if (!result.ok) throw new Error(`Failed to upload receipt: ${file.name}`)
        const { storageId } = await result.json()
        await claimStorageUpload({ storageId: storageId as Id<'_storage'> })
        receiptStorageIds.push(storageId)
      }

      await createInvoice({
        storageId: invoiceStorageId,
        fileName: invoiceFile.name,
        vendorName: data.vendor_name,
        invoiceDate: data.invoice_date,
        amountGbp: data.amount_gbp,
        description: data.description || undefined,
        receiptStorageIds: receiptStorageIds as any,
      })

      toast.success('Invoice uploaded successfully')
      router.push('/founder/invoices')
    } catch (error) {
      const message =
        error instanceof ConvexError
          ? (error.data as string)
          : error instanceof Error
            ? error.message
            : 'Failed to upload invoice'
      toast.error(message)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-4">
        <div>
          <Link href="/founder/invoices">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Invoices
            </Button>
          </Link>
        </div>
        <div>
          <h1 className="text-3xl font-bold tracking-tight font-display">Upload Invoice</h1>
          <p className="text-muted-foreground">
            Upload your documents and AI will extract the details automatically
          </p>
        </div>
      </div>

      {/* Step 1: Upload documents */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">1. Upload your documents</CardTitle>
          <CardDescription>
            Drop in your invoice and receipts — we&apos;ll handle the rest. Your invoice must be
            named{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">
              {startupName ?? 'YourStartup'} Invoice {expectedNumber}.pdf
            </code>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TooltipProvider>
            <div className="grid gap-6 md:grid-cols-2">
              {/* Invoice File Upload */}
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <label className="text-sm font-medium leading-none">Invoice PDF</label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3.5 w-3.5 text-amber-500 cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-[280px]">
                      <p>
                        A PDF document from your company addressed to Accelerate ME, requesting
                        reimbursement for expenses.
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </div>
                <input
                  ref={invoiceInputRef}
                  type="file"
                  accept="application/pdf"
                  onChange={(e) => {
                    setInvoiceFile(e.target.files?.[0] ?? null)
                    e.target.value = ''
                  }}
                  className="hidden"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => invoiceInputRef.current?.click()}
                >
                  {invoiceFile ? (
                    <>
                      <Replace className="mr-2 h-4 w-4" />
                      Replace invoice
                    </>
                  ) : (
                    <>
                      <Plus className="mr-2 h-4 w-4" />
                      Choose invoice
                    </>
                  )}
                </Button>
                {invoiceFile && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <button
                      type="button"
                      onClick={() => previewFile(invoiceFile)}
                      className="inline-flex items-center gap-1.5 text-blue-600 hover:text-blue-700 hover:underline truncate"
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{invoiceFile.name}</span>
                      <Eye className="h-3 w-3 shrink-0" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setInvoiceFile(null)
                        resetExtractionIfNeeded()
                      }}
                      className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
                {invoiceNameError && <p className="text-sm text-destructive">{invoiceNameError}</p>}
              </div>

              {/* Receipt File Upload */}
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <label className="text-sm font-medium leading-none">Receipt PDFs</label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3.5 w-3.5 text-amber-500 cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="right" className="max-w-[280px]">
                      <p>
                        Proof-of-purchase receipts from vendors. Upload multiple — filenames
                        don&apos;t matter, we rename them automatically.
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </div>
                <input
                  ref={receiptInputRef}
                  type="file"
                  accept="application/pdf"
                  multiple
                  onChange={(e) => {
                    const files = e.target.files
                    if (files && files.length > 0) {
                      setReceiptFiles((prev) => [...prev, ...Array.from(files)])
                    }
                    e.target.value = ''
                  }}
                  className="hidden"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => receiptInputRef.current?.click()}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  {receiptFiles.length === 0 ? 'Choose receipts' : 'Add more receipts'}
                </Button>
                {receiptFiles.length > 0 && (
                  <div className="space-y-1">
                    {receiptFiles.map((file, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-2 text-sm text-muted-foreground"
                      >
                        <button
                          type="button"
                          onClick={() => previewFile(file)}
                          className="inline-flex items-center gap-1.5 text-blue-600 hover:text-blue-700 hover:underline truncate"
                        >
                          <FileText className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{file.name}</span>
                          <Eye className="h-3 w-3 shrink-0" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setReceiptFiles((prev) => prev.filter((_, j) => j !== i))
                            resetExtractionIfNeeded()
                          }}
                          className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {receiptPdfError && <p className="text-sm text-destructive">{receiptPdfError}</p>}
              </div>
            </div>
          </TooltipProvider>
        </CardContent>
      </Card>

      {/* Confirmation banner when files changed after extraction */}
      {needsConfirmation && invoiceFile && receiptFiles.length > 0 && (
        <div className="border border-amber-200 bg-amber-50/50 rounded-lg p-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-amber-600" />
            <p className="text-sm font-medium text-amber-900">
              Files changed. Re-extract invoice details?
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setNeedsConfirmation(false)
              extractionTriggered.current = false
            }}
          >
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            Re-extract
          </Button>
        </div>
      )}

      {/* Extraction pipeline */}
      {!needsConfirmation && (extractionStep > 0 || extractionResult) && (
        <div className="border border-blue-200 bg-blue-50/50 rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2">
            {extractionStep > 0 && extractionStep < 5 ? (
              <Loader2 className="h-4 w-4 text-blue-600 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-green-600" />
            )}
            <p className="text-sm font-medium text-blue-900">
              {extractionStep === 5 ? 'Extraction complete' : 'Extracting invoice details...'}
            </p>
          </div>

          <div className="flex items-center">
            {[
              { label: 'Upload', step: 1 },
              { label: 'Analyze', step: 2 },
              { label: 'Convert', step: 3 },
              { label: 'Populate', step: 4 },
            ].map(({ label, step }, i) => (
              <Fragment key={step}>
                {i > 0 && (
                  <div
                    className={`flex-1 h-px mx-1 ${
                      extractionStep >= step ? 'bg-green-300' : 'bg-muted-foreground/20'
                    }`}
                  />
                )}
                <div
                  className={`flex items-center gap-1 text-xs whitespace-nowrap px-2 py-1 rounded-full ${
                    extractionStep > step
                      ? 'text-green-700 bg-green-50'
                      : extractionStep === step
                        ? 'text-blue-700 bg-blue-100 font-medium'
                        : 'text-muted-foreground'
                  }`}
                >
                  {extractionStep > step ? (
                    <CheckCircle2 className="h-3 w-3" />
                  ) : extractionStep === step ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Circle className="h-3 w-3" />
                  )}
                  {label}
                </div>
              </Fragment>
            ))}
          </div>

          {extractionResult?.currencyConverted && (
            <div className="border-t border-blue-200 pt-2 text-xs text-blue-800 space-y-0.5">
              <p className="font-medium">Currency conversion applied (live rates)</p>
              {extractionResult.invoiceCurrency !== 'GBP' && (
                <p>
                  Invoice: {extractionResult.totalAmountOriginal.toFixed(2)}{' '}
                  {extractionResult.invoiceCurrency} &rarr; &pound;
                  {extractionResult.totalAmountGbp.toFixed(2)} GBP
                </p>
              )}
              {extractionResult.receiptCurrencies.map(
                (curr, i) =>
                  curr !== 'GBP' && (
                    <p key={i}>
                      Receipt {i + 1}: {extractionResult.receiptAmountsOriginal[i]?.toFixed(2)}{' '}
                      {curr} &rarr; &pound;
                      {extractionResult.receiptAmountsGbp[i]?.toFixed(2)} GBP
                    </p>
                  )
              )}
            </div>
          )}

          {extractionResult && extractionResult.unconvertedCurrencies.length > 0 && (
            <div className="border-t border-amber-200 pt-2 flex items-start gap-1.5 text-xs text-amber-800">
              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
              <p>
                Could not convert: {extractionResult.unconvertedCurrencies.join(', ')}. Amounts
                shown as-is — please verify.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Step 2: Review details */}
      <Card ref={formCardRef}>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">2. Review details</CardTitle>
          <CardDescription>
            {extractionResult
              ? 'AI-extracted details — review and adjust if needed'
              : 'These fields will be auto-filled once you upload your documents'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              {amountMismatchWarning && (
                <div className="flex items-start gap-3 border border-amber-200 bg-amber-50/50 p-4 rounded-lg">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                  <div>
                    <p className="text-sm font-medium text-amber-900">Amount mismatch</p>
                    <p className="text-sm text-amber-700">{amountMismatchWarning}</p>
                  </div>
                </div>
              )}

              <FormField
                control={form.control}
                name="vendor_name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Vendor Name(s)</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Amazon, Office Supplies Ltd" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid gap-4 md:grid-cols-2">
                <FormField
                  control={form.control}
                  name="invoice_date"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Invoice Date</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="amount_gbp"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Amount ({'\u00A3'})</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          step="0.01"
                          min="0.01"
                          inputMode="decimal"
                          placeholder="500"
                          {...field}
                          value={field.value ?? ''}
                          onFocus={(e) => e.currentTarget.select()}
                          onChange={(e) => {
                            const value = e.target.value
                            field.onChange(value === '' ? undefined : Number(value))
                          }}
                        />
                      </FormControl>
                      {amountExceedsBalance && (
                        <p className="text-sm text-destructive">
                          Exceeds available balance of {'\u00A3'}
                          {available.toFixed(2)}
                        </p>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description (Optional)</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Additional notes about this invoice..."
                        rows={3}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex justify-end gap-4">
                <Link href="/founder/invoices">
                  <Button type="button" variant="outline" disabled={isSubmitting}>
                    Cancel
                  </Button>
                </Link>
                <Button type="submit" disabled={isSubmitting || !canSubmit}>
                  <Upload className="mr-2 h-4 w-4" />
                  {isSubmitting ? 'Uploading...' : 'Submit Invoice'}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>

      {/* PDF Preview Modal */}
      <Dialog
        open={!!pdfPreviewUrl}
        onOpenChange={(open) => {
          if (!open) {
            if (pdfPreviewUrl) URL.revokeObjectURL(pdfPreviewUrl)
            setPdfPreviewUrl(null)
          }
        }}
      >
        <DialogContent className="max-w-5xl h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{pdfPreviewTitle}</DialogTitle>
            <DialogDescription>Preview of the selected PDF file</DialogDescription>
          </DialogHeader>
          {pdfPreviewUrl && <iframe src={pdfPreviewUrl} className="flex-1 w-full rounded border" />}
        </DialogContent>
      </Dialog>
    </div>
  )
}
