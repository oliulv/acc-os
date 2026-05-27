'use client'

import { useState } from 'react'
import { useQuery, useMutation } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { Megaphone, Send, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { announcementSchema, type AnnouncementFormData } from '@/lib/schemas'
import type { Id } from '@/convex/_generated/dataModel'

type AnnouncementRow = {
  _id: Id<'announcements'>
  title: string
  body: string
  senderName: string
  recipientCount: number
  sentAt: string
}

export function AnnouncementsTab({ cohortSlug }: { cohortSlug: string }) {
  const cohort = useQuery(api.cohorts.getBySlug, { slug: cohortSlug })
  const announcements = useQuery(
    api.announcements.listForAdmin,
    cohort ? { cohortId: cohort._id } : 'skip'
  )
  const canSend = useQuery(api.announcements.canSend, cohort ? { cohortId: cohort._id } : 'skip')
  const sendAnnouncement = useMutation(api.announcements.send)
  const updateAnnouncement = useMutation(api.announcements.update)

  const [composeMode, setComposeMode] = useState<'create' | 'edit' | null>(null)
  const [editingId, setEditingId] = useState<Id<'announcements'> | null>(null)
  const [showConfirm, setShowConfirm] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [pendingData, setPendingData] = useState<AnnouncementFormData | null>(null)

  const form = useForm<AnnouncementFormData>({
    resolver: zodResolver(announcementSchema),
    defaultValues: { title: '', body: '' },
  })

  const openCreate = () => {
    form.reset({ title: '', body: '' })
    setEditingId(null)
    setComposeMode('create')
  }

  const openEdit = (row: AnnouncementRow) => {
    form.reset({ title: row.title, body: row.body })
    setEditingId(row._id)
    setComposeMode('edit')
  }

  const closeCompose = () => {
    setComposeMode(null)
    setEditingId(null)
    form.reset({ title: '', body: '' })
  }

  const handleSubmit = async (data: AnnouncementFormData) => {
    if (composeMode === 'edit' && editingId) {
      setIsSaving(true)
      try {
        await updateAnnouncement({
          announcementId: editingId,
          title: data.title,
          body: data.body,
        })
        toast.success('Announcement updated')
        closeCompose()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to update announcement')
      } finally {
        setIsSaving(false)
      }
      return
    }

    setPendingData(data)
    setShowConfirm(true)
  }

  const handleConfirmSend = async () => {
    if (!pendingData || !cohort) return

    setIsSending(true)
    try {
      await sendAnnouncement({
        cohortId: cohort._id as Id<'cohorts'>,
        title: pendingData.title,
        body: pendingData.body,
        appUrl: window.location.origin,
      })
      toast.success('Announcement sent to all founders')
      setShowConfirm(false)
      closeCompose()
      setPendingData(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send announcement')
    } finally {
      setIsSending(false)
    }
  }

  if (!cohort) return null

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-muted-foreground">
            {canSend
              ? `Send announcements to all founders in ${cohort.label}`
              : `Announcements for ${cohort.label}`}
          </p>
        </div>
        {canSend && (
          <Button onClick={openCreate}>
            <Megaphone className="mr-2 h-4 w-4" />
            New Announcement
          </Button>
        )}
      </div>

      {/* Compose / Edit Dialog */}
      <Dialog
        open={composeMode !== null}
        onOpenChange={(open) => {
          if (!open) closeCompose()
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {composeMode === 'edit' ? 'Edit Announcement' : 'New Announcement'}
            </DialogTitle>
            <DialogDescription>
              {composeMode === 'edit'
                ? 'Update the title or message. Founders see the latest version when they open the announcement — no SMS is resent.'
                : `This will be sent to all founders in ${cohort.label} via SMS and shown in their dashboard.`}
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Title</FormLabel>
                    <FormControl>
                      <Input placeholder="Important update..." {...field} maxLength={100} />
                    </FormControl>
                    <FormDescription>{field.value.length}/100 characters</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="body"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Message</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Write your announcement..."
                        rows={8}
                        {...field}
                        maxLength={10000}
                      />
                    </FormControl>
                    <FormDescription>{field.value.length}/10,000 characters</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={closeCompose}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={isSaving || (composeMode === 'edit' && !form.formState.isDirty)}
                >
                  {composeMode === 'edit' ? (
                    <>
                      {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Save Changes
                    </>
                  ) : (
                    <>
                      <Send className="mr-2 h-4 w-4" />
                      Review &amp; Send
                    </>
                  )}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Confirmation Dialog */}
      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Send</DialogTitle>
            <DialogDescription>
              This announcement will be sent to all founders in {cohort.label} via SMS. This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {pendingData && (
            <div className="border p-4 space-y-2 bg-muted/30">
              <p className="font-semibold">{pendingData.title}</p>
              <p className="max-h-64 overflow-y-auto text-sm text-muted-foreground whitespace-pre-wrap">
                {pendingData.body}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowConfirm(false)} disabled={isSending}>
              Cancel
            </Button>
            <Button onClick={handleConfirmSend} disabled={isSending}>
              {isSending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Send to All Founders
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Announcements History */}
      {announcements === undefined ? null : announcements.length === 0 ? (
        <EmptyState
          icon={<Megaphone className="h-6 w-6" />}
          title="No announcements yet"
          description="Send your first announcement to notify all founders in this cohort."
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>History</CardTitle>
            <CardDescription>All announcements sent to {cohort.label}</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>Sent By</TableHead>
                  <TableHead>Recipients</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {announcements.map((a) => (
                  <TableRow
                    key={a._id}
                    onClick={canSend ? () => openEdit(a) : undefined}
                    className={canSend ? 'cursor-pointer' : undefined}
                  >
                    <TableCell className="font-medium">{a.title}</TableCell>
                    <TableCell className="max-w-xs truncate text-muted-foreground">
                      {a.body}
                    </TableCell>
                    <TableCell>{a.senderName}</TableCell>
                    <TableCell>{a.recipientCount}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(a.sentAt).toLocaleDateString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
