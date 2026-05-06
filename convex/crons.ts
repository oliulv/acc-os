import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()

// ── Data sync crons (separate per source for failure isolation) ────────

// Sync Stripe metrics every 30 minutes
crons.interval('sync-stripe', { minutes: 30 }, internal.metrics.syncAllStripeMetrics)

// Sync GitHub metrics every 5 minutes
crons.interval('sync-github', { minutes: 5 }, internal.metrics.syncAllGithubMetrics)

// Sync tracker metrics every 30 minutes
crons.interval('sync-tracker', { minutes: 30 }, internal.metrics.syncAllTrackerMetrics)

// ── Scheduled tasks ───────────────────────────────────────────────────

// Send daily event reminders at 8am UTC
crons.cron('daily-event-reminders', '0 8 * * *', internal.notifications.sendDailyEventReminders)

// Scrape social media profiles daily at 6am UTC
crons.cron('scrape-social', '0 6 * * *', internal.apify.scrapeAllProfiles)

export default crons
