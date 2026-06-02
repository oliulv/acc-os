import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()

// ── Data sync crons (separate per source for failure isolation) ────────

// Leaderboard inputs are non-critical and expensive because each sync fans out
// per startup/integration, so run them once per day overnight.
crons.cron('sync-stripe', '0 3 * * *', internal.metrics.syncAllStripeMetrics)
crons.cron('sync-github', '5 3 * * *', internal.metrics.syncAllGithubMetrics)
crons.cron('sync-tracker', '10 3 * * *', internal.metrics.syncAllTrackerMetrics)

// ── Scheduled tasks ───────────────────────────────────────────────────

// Send daily event reminders at 8am UTC
crons.cron('daily-event-reminders', '0 8 * * *', internal.notifications.sendDailyEventReminders)

// Scrape social media profiles daily at 6am UTC
crons.cron('scrape-social', '0 6 * * *', internal.apify.scrapeAllProfiles)

export default crons
