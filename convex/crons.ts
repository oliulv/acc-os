import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()

// EU-region deployments are billed fully on-demand with a 30% surcharge, so
// dev syncs against cloned prod data were dominating the bill. On dev we run
// each sync once a day as a smoke test; manual invocation covers anything else.
const isProd =
  process.env.CONVEX_CLOUD_URL === 'https://hallowed-chameleon-369.eu-west-1.convex.cloud'

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
