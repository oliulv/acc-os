import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'
import {
  providerValidator,
  connectionProviderValidator,
  socialPlatformValidator,
  mrrMovementTypeValidator,
} from './lib/providers'

export default defineSchema({
  // ── Users ──────────────────────────────────────────────────────────
  users: defineTable({
    clerkId: v.string(),
    role: v.union(v.literal('super_admin'), v.literal('admin'), v.literal('founder')),
    email: v.optional(v.string()),
    fullName: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
  }).index('by_clerkId', ['clerkId']),

  // ── Cohorts ────────────────────────────────────────────────────────
  cohorts: defineTable({
    name: v.string(),
    slug: v.string(),
    yearStart: v.number(),
    yearEnd: v.number(),
    label: v.string(),
    isActive: v.boolean(),
    fundingBudget: v.optional(v.number()),
    baseFunding: v.optional(v.number()),
    leaderboardConfig: v.optional(
      v.object({
        normalizationPower: v.number(), // default 0.7, range 0.3–1.0
      })
    ),
  }).index('by_slug', ['slug']),

  // ── Admin ↔ Cohort assignments ────────────────────────────────────
  adminCohorts: defineTable({
    userId: v.id('users'),
    cohortId: v.id('cohorts'),
  })
    .index('by_userId', ['userId'])
    .index('by_cohortId', ['cohortId'])
    .index('by_userId_cohortId', ['userId', 'cohortId']),

  // ── Admin Permissions (delegated) ─────────────────────────────────
  // startupId omitted = cohort-wide grant (applies to every startup in the cohort)
  // startupId set      = grant is restricted to that single startup
  adminPermissions: defineTable({
    userId: v.id('users'),
    cohortId: v.id('cohorts'),
    permission: v.union(
      v.literal('approve_milestones'),
      v.literal('approve_invoices'),
      v.literal('send_announcements'),
      v.literal('manage_notifications')
    ),
    startupId: v.optional(v.id('startups')),
  })
    .index('by_userId_cohortId', ['userId', 'cohortId'])
    .index('by_userId_cohortId_permission', ['userId', 'cohortId', 'permission']),

  // ── Startups ───────────────────────────────────────────────────────
  startups: defineTable({
    cohortId: v.id('cohorts'),
    name: v.string(),
    slug: v.optional(v.string()),
    logoUrl: v.optional(v.string()),
    stage: v.optional(v.string()),
    sector: v.optional(v.string()),
    websiteUrl: v.optional(v.string()),
    notes: v.optional(v.string()),
    onboardingStatus: v.union(
      v.literal('pending'),
      v.literal('in_progress'),
      v.literal('completed')
    ),
    excludeFromMetrics: v.optional(v.boolean()),
    // @deprecated — no longer written or read. Streak is now computed
    // live from weeklyUpdates via convex/lib/streak.ts. Left in the
    // schema so strict-validation does not reject existing rows that
    // still carry a value. Remove in a follow-up PR after running
    // `npx convex run migrations/stripUpdateStreak:run --prod`.
    updateStreak: v.optional(v.number()),
  })
    .index('by_cohortId', ['cohortId'])
    .index('by_slug', ['slug']),

  // ── Startup Profiles ───────────────────────────────────────────────
  startupProfiles: defineTable({
    startupId: v.id('startups'),
    oneLiner: v.optional(v.string()),
    description: v.optional(v.string()),
    companyUrl: v.optional(v.string()),
    productUrl: v.optional(v.string()),
    industry: v.optional(v.string()),
    location: v.optional(v.string()),
    initialCustomers: v.optional(v.number()),
    initialRevenue: v.optional(v.number()),
  }).index('by_startupId', ['startupId']),

  // ── Founder Profiles ───────────────────────────────────────────────
  founderProfiles: defineTable({
    userId: v.id('users'),
    startupId: v.id('startups'),
    fullName: v.string(),
    personalEmail: v.string(),
    addressLine1: v.optional(v.string()),
    addressLine2: v.optional(v.string()),
    city: v.optional(v.string()),
    postcode: v.optional(v.string()),
    country: v.optional(v.string()),
    phone: v.optional(v.string()),
    bio: v.optional(v.string()),
    linkedinUrl: v.optional(v.string()),
    xUrl: v.optional(v.string()),
    githubUsername: v.optional(v.string()),
    onboardingStatus: v.union(
      v.literal('pending'),
      v.literal('in_progress'),
      v.literal('completed')
    ),
  })
    .index('by_userId', ['userId'])
    .index('by_startupId', ['startupId']),

  // ── Bank Details ───────────────────────────────────────────────────
  bankDetails: defineTable({
    startupId: v.id('startups'),
    accountHolderName: v.string(),
    sortCode: v.string(),
    accountNumber: v.string(),
    bankName: v.optional(v.string()),
  }).index('by_startupId', ['startupId']),

  // ── Milestone Templates ────────────────────────────────────────────
  milestoneTemplates: defineTable({
    cohortId: v.id('cohorts'),
    title: v.string(),
    description: v.string(),
    amount: v.number(),
    dueDate: v.optional(v.string()),
    sortOrder: v.number(),
    isActive: v.boolean(),
    requireLink: v.optional(v.boolean()),
    requireFile: v.optional(v.boolean()),
  }).index('by_cohortId', ['cohortId']),

  // ── Milestones ────────────────────────────────────────────────────
  milestones: defineTable({
    startupId: v.id('startups'),
    milestoneTemplateId: v.optional(v.id('milestoneTemplates')),
    title: v.string(),
    description: v.string(),
    amount: v.number(),
    status: v.union(
      v.literal('waiting'),
      v.literal('submitted'),
      v.literal('approved'),
      v.literal('changes_requested')
    ),
    dueDate: v.optional(v.string()),
    sortOrder: v.number(),
    planLink: v.optional(v.string()),
    planStorageId: v.optional(v.id('_storage')),
    planFileName: v.optional(v.string()),
    requireLink: v.optional(v.boolean()),
    requireFile: v.optional(v.boolean()),
    adminComment: v.optional(v.string()),
    approvedAt: v.optional(v.number()),
    // Timestamp of the most recent submit. Denormalized from milestoneEvents
    // so the admin inbox can order and display "Submitted X" without an
    // N+1 join. Rewritten on every submit (initial and re-submissions).
    lastSubmittedAt: v.optional(v.number()),
  })
    .index('by_startupId', ['startupId'])
    .index('by_milestoneTemplateId', ['milestoneTemplateId']),

  // ── Milestone Events (audit trail) ────────────────────────────────
  milestoneEvents: defineTable({
    milestoneId: v.id('milestones'),
    action: v.union(
      v.literal('submitted'),
      v.literal('changes_requested'),
      v.literal('approved'),
      v.literal('withdrawn')
    ),
    userId: v.id('users'),
    comment: v.optional(v.string()),
    planLink: v.optional(v.string()),
    planStorageId: v.optional(v.id('_storage')),
    planFileName: v.optional(v.string()),
  }).index('by_milestoneId', ['milestoneId']),

  // ── Funding Adjustments ───────────────────────────────────────────
  fundingAdjustments: defineTable({
    cohortId: v.id('cohorts'),
    startupId: v.id('startups'),
    type: v.union(v.literal('top_up'), v.literal('deduction')),
    amount: v.number(),
    note: v.string(),
    createdByUserId: v.id('users'),
    createdAt: v.number(),
  })
    .index('by_cohortId', ['cohortId'])
    .index('by_startupId', ['startupId'])
    .index('by_cohortId_createdAt', ['cohortId', 'createdAt']),

  // ── Funding Audit Events ──────────────────────────────────────────
  fundingAuditEvents: defineTable({
    cohortId: v.id('cohorts'),
    type: v.literal('cohort_settings_change'),
    note: v.string(),
    createdByUserId: v.id('users'),
    createdAt: v.number(),
    previousFundingBudget: v.optional(v.number()),
    newFundingBudget: v.optional(v.number()),
    previousBaseFunding: v.optional(v.number()),
    newBaseFunding: v.optional(v.number()),
  })
    .index('by_cohortId', ['cohortId'])
    .index('by_cohortId_createdAt', ['cohortId', 'createdAt']),

  // ── Invitations (founder) ──────────────────────────────────────────
  invitations: defineTable({
    startupId: v.id('startups'),
    email: v.string(),
    fullName: v.string(),
    token: v.string(),
    role: v.literal('founder'),
    expiresAt: v.string(),
    acceptedAt: v.optional(v.string()),
    createdByAdminId: v.optional(v.id('users')),
    createdByUserId: v.optional(v.id('users')),
  })
    .index('by_token', ['token'])
    .index('by_startupId', ['startupId'])
    .index('by_email', ['email']),

  // ── Admin Invitations ──────────────────────────────────────────────
  adminInvitations: defineTable({
    email: v.string(),
    token: v.string(),
    role: v.union(v.literal('admin'), v.literal('super_admin')),
    invitedName: v.optional(v.string()),
    expiresAt: v.string(),
    acceptedAt: v.optional(v.string()),
    createdByUserId: v.id('users'),
    cohortId: v.optional(v.id('cohorts')),
  })
    .index('by_token', ['token'])
    .index('by_email', ['email']),

  // ── Invoices ───────────────────────────────────────────────────────
  invoices: defineTable({
    startupId: v.id('startups'),
    uploadedByUserId: v.id('users'),
    vendorName: v.string(),
    invoiceDate: v.string(),
    dueDate: v.optional(v.string()),
    amountGbp: v.number(),
    category: v.optional(v.string()),
    description: v.optional(v.string()),
    storageId: v.id('_storage'),
    fileName: v.string(),
    receiptStorageId: v.optional(v.id('_storage')),
    receiptFileName: v.optional(v.string()),
    receiptStorageIds: v.optional(v.array(v.id('_storage'))),
    receiptFileNames: v.optional(v.array(v.string())),
    status: v.union(
      v.literal('submitted'),
      v.literal('under_review'),
      v.literal('approved'),
      v.literal('rejected'),
      v.literal('paid')
    ),
    approvedByAdminId: v.optional(v.id('users')),
    approvedAt: v.optional(v.string()),
    paidAt: v.optional(v.string()),
    adminComment: v.optional(v.string()),
    // Legacy batching fields retained so old invoice documents remain schema-valid.
    // Runtime batching has been removed and new invoices no longer write these.
    batchedIntoId: v.optional(v.id('invoices')),
    isBatched: v.optional(v.boolean()),
    batchedFromIds: v.optional(v.array(v.id('invoices'))),
    originalInvoiceStorageIds: v.optional(v.array(v.id('_storage'))),
    originalInvoiceFileNames: v.optional(v.array(v.string())),
  })
    .index('by_startupId', ['startupId'])
    .index('by_status', ['status']),

  // ── Legacy Pending Batches ────────────────────────────────────────
  // Retained only so already-scheduled legacy batch jobs can drain cleanly.
  // No runtime path writes this table anymore.
  pendingBatches: defineTable({
    startupId: v.id('startups'),
    scheduledFnId: v.id('_scheduled_functions'),
  }).index('by_startupId', ['startupId']),

  // ── Storage Claims ────────────────────────────────────────────
  // Records which user uploaded a given _storage blob. Written after a
  // successful upload via `claimStorageUpload`, consumed by `invoices.create`
  // and `deleteStorageFile`. Prevents a founder from attaching another
  // founder's leaked storage ID to their own invoice to exfiltrate the file.
  storageClaims: defineTable({
    storageId: v.id('_storage'),
    uploaderUserId: v.id('users'),
    createdAt: v.number(),
  })
    .index('by_storageId', ['storageId'])
    .index('by_uploader', ['uploaderUserId']),

  // ── Integration Connections ────────────────────────────────────────
  integrationConnections: defineTable({
    startupId: v.id('startups'),
    provider: connectionProviderValidator,
    accountId: v.optional(v.string()),
    accountName: v.optional(v.string()),
    status: v.union(v.literal('active'), v.literal('error'), v.literal('disconnected')),
    scopes: v.optional(v.array(v.string())),
    accessToken: v.optional(v.string()),
    refreshToken: v.optional(v.string()),
    tokenExpiresAt: v.optional(v.string()),
    connectedByUserId: v.optional(v.id('users')),
    connectedAt: v.optional(v.string()),
    lastSyncedAt: v.optional(v.string()),
    syncError: v.optional(v.string()),
    restrictedBannerDismissedAt: v.optional(v.string()),
    isActive: v.boolean(),
  })
    .index('by_startupId', ['startupId'])
    .index('by_startupId_provider', ['startupId', 'provider']),

  // ── Metrics Data ───────────────────────────────────────────────────
  metricsData: defineTable({
    startupId: v.id('startups'),
    provider: providerValidator,
    metricKey: v.string(),
    value: v.number(),
    timestamp: v.string(),
    window: v.union(v.literal('daily'), v.literal('weekly'), v.literal('monthly')),
    meta: v.optional(v.any()),
  })
    .index('by_startupId', ['startupId'])
    .index('by_startupId_provider_metricKey', ['startupId', 'provider', 'metricKey'])
    .index('by_startupId_metricKey_timestamp', ['startupId', 'metricKey', 'timestamp']),

  // ── Customer MRR (per-customer per-month time-series) ─────────────
  customerMrr: defineTable({
    startupId: v.id('startups'),
    stripeCustomerId: v.string(),
    month: v.string(), // YYYY-MM
    mrr: v.number(), // GBP pence
    currencyOriginal: v.optional(v.string()),
    mrrOriginal: v.optional(v.number()), // original currency pence
    exchangeRate: v.optional(v.number()),
    subscriptionId: v.optional(v.string()),
  })
    .index('by_startupId', ['startupId'])
    .index('by_startupId_month', ['startupId', 'month'])
    .index('by_startupId_customerId_month', ['startupId', 'stripeCustomerId', 'month']),

  // ── MRR Movements ─────────────────────────────────────────────────
  mrrMovements: defineTable({
    startupId: v.id('startups'),
    month: v.string(), // YYYY-MM
    type: mrrMovementTypeValidator,
    amount: v.number(), // GBP pence
    stripeCustomerId: v.string(),
    subscriptionId: v.optional(v.string()),
  })
    .index('by_startupId', ['startupId'])
    .index('by_startupId_month', ['startupId', 'month']),

  // ── Stripe Webhook Events (idempotency log) ───────────────────────
  stripeWebhookEvents: defineTable({
    stripeEventId: v.string(),
    type: v.string(),
    processedAt: v.string(),
    payload: v.optional(v.any()),
  }).index('by_stripeEventId', ['stripeEventId']),

  // ── Social Profiles (for Apify scraping) ──────────────────────────
  socialProfiles: defineTable({
    startupId: v.id('startups'),
    platform: socialPlatformValidator,
    handle: v.string(),
    profileUrl: v.optional(v.string()),
    lastScrapedAt: v.optional(v.string()),
    scrapeError: v.optional(v.string()),
  })
    .index('by_startupId', ['startupId'])
    .index('by_startupId_platform', ['startupId', 'platform']),

  // ── Weekly Updates ────────────────────────────────────────────────
  weeklyUpdates: defineTable({
    startupId: v.id('startups'),
    founderId: v.id('users'),
    weekOf: v.string(), // Monday ISO date (YYYY-MM-DD)
    highlight: v.string(), // Brief 2-4 line update — what happened, craziest thing
    primaryMetric: v.optional(
      v.object({
        label: v.string(),
        value: v.number(),
      })
    ),
    isFavorite: v.boolean(),
    favoritedBy: v.optional(v.id('users')),
    createdAt: v.string(),
  })
    .index('by_startupId', ['startupId'])
    .index('by_startupId_weekOf', ['startupId', 'weekOf'])
    .index('by_weekOf', ['weekOf']),

  // ── Tracker Websites ───────────────────────────────────────────────
  trackerWebsites: defineTable({
    startupId: v.id('startups'),
    name: v.string(),
    domain: v.optional(v.string()),
    lastEventAt: v.optional(v.string()),
  }).index('by_startupId', ['startupId']),

  // ── Tracker Events ─────────────────────────────────────────────────
  trackerEvents: defineTable({
    websiteId: v.id('trackerWebsites'),
    sessionId: v.optional(v.string()),
    eventName: v.optional(v.string()),
    url: v.string(),
    referrer: v.optional(v.string()),
    tag: v.optional(v.string()),
    utmSource: v.optional(v.string()),
    utmMedium: v.optional(v.string()),
    utmCampaign: v.optional(v.string()),
    utmTerm: v.optional(v.string()),
    utmContent: v.optional(v.string()),
    country: v.optional(v.string()),
    device: v.optional(v.string()),
    browser: v.optional(v.string()),
    os: v.optional(v.string()),
    screen: v.optional(v.string()),
    language: v.optional(v.string()),
    title: v.optional(v.string()),
    hostname: v.optional(v.string()),
    data: v.optional(v.any()),
    /**
     * HMAC of the truncated client IP, scoped to the deployment's
     * TRACKER_HASH_SECRET. Optional because rows predating the
     * anti-gaming work have no IP recorded.
     */
    sourceIpHash: v.optional(v.string()),
  })
    .index('by_websiteId', ['websiteId'])
    .index('by_websiteId_eventName', ['websiteId', 'eventName'])
    .index('by_websiteId_sessionId', ['websiteId', 'sessionId']),

  // ── Cohort Events ─────────────────────────────────────────────
  cohortEvents: defineTable({
    cohortId: v.id('cohorts'),
    title: v.string(),
    description: v.optional(v.string()),
    date: v.string(),
    lumaEmbedUrl: v.string(),
    sortOrder: v.number(),
    isActive: v.boolean(),
  }).index('by_cohortId', ['cohortId']),

  // ── Perks (global, not per-cohort) ──────────────────────────────
  perks: defineTable({
    cohortId: v.optional(v.id('cohorts')), // Legacy field, not used
    title: v.string(),
    description: v.string(),
    details: v.optional(v.string()),
    category: v.optional(v.string()),
    providerName: v.optional(v.string()),
    providerLogoUrl: v.optional(v.string()),
    url: v.optional(v.string()),
    isActive: v.boolean(),
    isPartnership: v.optional(v.boolean()),
    sortOrder: v.number(),
  }),

  // ── Event Registrations ────────────────────────────────────────
  eventRegistrations: defineTable({
    eventId: v.id('cohortEvents'),
    userId: v.id('users'),
    registeredAt: v.string(),
  })
    .index('by_eventId', ['eventId'])
    .index('by_userId', ['userId'])
    .index('by_eventId_userId', ['eventId', 'userId']),

  // ── Resources (global, not per-cohort) ─────────────────────────
  resources: defineTable({
    title: v.string(),
    category: v.union(
      v.literal('video'),
      v.literal('podcast'),
      v.literal('book'),
      v.literal('other_reading')
    ),
    topic: v.optional(v.string()),
    description: v.optional(v.string()),
    url: v.optional(v.string()),
    storageId: v.optional(v.id('_storage')),
    fileName: v.optional(v.string()),
    eventId: v.optional(v.id('cohortEvents')),
    isActive: v.boolean(),
    sortOrder: v.number(),
  }),

  // ── Resource Submissions (founder suggestions) ────────────────
  resourceSubmissions: defineTable({
    title: v.string(),
    category: v.union(
      v.literal('video'),
      v.literal('podcast'),
      v.literal('book'),
      v.literal('other_reading')
    ),
    topic: v.optional(v.string()),
    description: v.optional(v.string()),
    url: v.optional(v.string()),
    storageId: v.optional(v.id('_storage')),
    fileName: v.optional(v.string()),
    submittedBy: v.id('users'),
    status: v.union(v.literal('pending'), v.literal('approved'), v.literal('rejected')),
  }),

  // ── SMS Phone Numbers ────────────────────────────────────────
  // TODO: rename table to smsNumbers via migration
  whatsappNumbers: defineTable({
    userId: v.id('users'),
    phone: v.string(), // E.164 format
    isVerified: v.boolean(),
    verifiedAt: v.optional(v.string()),
    notificationsEnabled: v.boolean(),
    lastOtpRequestedAt: v.optional(v.string()),
    // DEPRECATED — legacy plaintext code. New writes use otpCodeHash only.
    // Kept as optional during one OTP TTL rollout window, then removed.
    otpCode: v.optional(v.string()),
    otpCodeHash: v.optional(v.string()),
    otpAttempts: v.optional(v.number()),
    otpExpiresAt: v.optional(v.string()),
  })
    .index('by_userId', ['userId'])
    .index('by_phone', ['phone']),

  // ── Notification Preferences ─────────────────────────────────
  notificationPreferences: defineTable({
    userId: v.id('users'),
    invoiceSubmitted: v.boolean(),
    invoiceStatusChanged: v.boolean(),
    milestoneSubmitted: v.boolean(),
    milestoneStatusChanged: v.boolean(),
    announcements: v.boolean(),
    eventReminders: v.boolean(),
    // New notification types (optional so existing rows aren't broken)
    invoicePaid: v.optional(v.boolean()),
    milestoneCreated: v.optional(v.boolean()),
    eventCreated: v.optional(v.boolean()),
    resourceSubmitted: v.optional(v.boolean()),
    resourceReviewed: v.optional(v.boolean()),
    onboardingCompleted: v.optional(v.boolean()),
    invitationAccepted: v.optional(v.boolean()),
    perkClaimed: v.optional(v.boolean()),
    milestoneWithdrawn: v.optional(v.boolean()),
    milestoneDeleted: v.optional(v.boolean()),
    eventUpdated: v.optional(v.boolean()),
    eventCancelled: v.optional(v.boolean()),
    bankDetailsAdded: v.optional(v.boolean()),
    perkCreated: v.optional(v.boolean()),
    founderRemoved: v.optional(v.boolean()),
    weeklyUpdateSubmitted: v.optional(v.boolean()),
    weeklyUpdateFavorited: v.optional(v.boolean()),
    fundingAdjustments: v.optional(v.boolean()),
  }).index('by_userId', ['userId']),

  // ── Announcements ────────────────────────────────────────────
  announcements: defineTable({
    cohortId: v.id('cohorts'),
    title: v.string(),
    body: v.string(),
    sentByUserId: v.id('users'),
    sentAt: v.string(),
    recipientCount: v.number(),
  }).index('by_cohortId', ['cohortId']),

  // ── Notification Log ─────────────────────────────────────────
  notificationLog: defineTable({
    userId: v.id('users'),
    type: v.string(),
    twilioMessageSid: v.optional(v.string()),
    status: v.union(v.literal('sent'), v.literal('failed'), v.literal('skipped')),
    error: v.optional(v.string()),
    metadata: v.optional(v.any()),
  })
    .index('by_userId', ['userId'])
    .index('by_type', ['type']),

  // ── Notification Settings (cohort-level global toggles) ─────
  notificationSettings: defineTable({
    cohortId: v.id('cohorts'),
    notificationType: v.string(),
    enabled: v.boolean(),
  })
    .index('by_cohortId', ['cohortId'])
    .index('by_cohortId_type', ['cohortId', 'notificationType']),

  // ── Perk Claims ────────────────────────────────────────────────
  perkClaims: defineTable({
    perkId: v.id('perks'),
    userId: v.id('users'),
    startupId: v.id('startups'),
    claimedAt: v.string(),
  })
    .index('by_perkId', ['perkId'])
    .index('by_userId', ['userId'])
    .index('by_perkId_userId', ['perkId', 'userId'])
    .index('by_startupId', ['startupId']),
})
