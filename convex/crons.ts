import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()

// Dev syncs against cloned prod data were dominating the bill, so dev runs
// each sync once a day as a smoke test; prod runs the full high-frequency
// cadence. IS_PRODUCTION_DEPLOYMENT is set explicitly via `convex env set` on
// the prod deployment only, so this check survives a region/deployment swap
// (the previous URL hard-coding silently broke the moment prod moved regions).
const isProd = process.env.IS_PRODUCTION_DEPLOYMENT === 'true'

// ── Data sync crons (separate per source for failure isolation) ────────

if (isProd) {
  crons.interval('sync-stripe', { minutes: 30 }, internal.metrics.syncAllStripeMetrics)
  crons.interval('sync-github', { minutes: 5 }, internal.metrics.syncAllGithubMetrics)
  crons.interval('sync-tracker', { minutes: 30 }, internal.metrics.syncAllTrackerMetrics)
} else {
  crons.cron('sync-stripe', '0 3 * * *', internal.metrics.syncAllStripeMetrics)
  crons.cron('sync-github', '5 3 * * *', internal.metrics.syncAllGithubMetrics)
  crons.cron('sync-tracker', '10 3 * * *', internal.metrics.syncAllTrackerMetrics)
}

// ── Scheduled tasks ───────────────────────────────────────────────────

// Send daily event reminders at 8am UTC
crons.cron('daily-event-reminders', '0 8 * * *', internal.notifications.sendDailyEventReminders)

// Scrape social media profiles daily at 6am UTC
crons.cron('scrape-social', '0 6 * * *', internal.apify.scrapeAllProfiles)

export default crons
