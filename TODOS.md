# TODOS

## Social Media Scoring (6th Category)

**What:** Add social follower growth (Twitter, LinkedIn, Instagram) as the 6th scoring category in the leaderboard engine. Weights redistribute from 5 categories to 6: revenue 22%, traffic 18%, GitHub 16%, social 16%, updates 15%, milestones 13%.

**Why:** Completes the scoring model. Social presence and growth matter for early-stage startups trying to build brand. Currently excluded from v1 because the Apify-based scraping doesn't work reliably.

**Context:** Excluded per design doc Premise 4. A separate scraping solution is being sourced externally. Integration pattern: store in `metricsData` with `provider: "social"`, sync via dedicated cron. The `socialProfiles` table and basic UI already exist from the current branch — just need reliable data flowing in.

**Depends on:** External scraping solution delivery; stable v1 scoring engine.

**Qualified threshold:** Changes from 3/5 to 3/6 when social is added.

## Clickable Startup Profiles from Leaderboard

**What:** From the founder leaderboard, founders should be able to click into competitor startup profiles to see their public performance data.

**Why:** Competitive motivation is a core product thesis — founders need to see what peers are doing to stay motivated and learn. Currently the leaderboard shows rank/score/momentum but you can't drill into any startup.

**Context:** Requires a new route `/founder/startups/[slug]` with a public profile view. Key design decision: what data is visible to other founders? Candidates: overall score, category breakdown (radar chart), momentum history, GitHub activity level (not raw commits), update streak. Revenue and specific metrics should likely be hidden unless the startup opts in. Access control: any authenticated founder in the same cohort can view profiles of cohort peers.

**Depends on:** Leaderboard + analytics PR landing first; design decision on data visibility.

**Blocked by:** Need to decide privacy model — opt-in detailed metrics vs. score-only default.

## API Route Integration Tests

**What:** Add integration tests for Next.js API routes (e.g. `/api/webhooks/stripe`, `/api/cron/*`). Requires mocking HTTP requests and Convex client calls.

**Why:** API routes contain auth checks, webhook signature verification, and orchestration logic that unit tests can't cover. Currently untested.

**Depends on:** Test infrastructure for mocking `NextRequest`/`NextResponse` and Convex client.

## Convex Handler Tests

**What:** Add tests for Convex mutations/queries/actions using the `convex-test` package. Covers handler-level logic (auth guards, DB reads/writes, scheduler calls).

**Why:** Business logic in Convex handlers (invoice creation, milestone approval, notification triggers) is only testable with a Convex test harness that simulates the DB and scheduler.

**Depends on:** `convex-test` package installation and configuration.

## Timezone-Aware Week Boundaries for Weekly Updates

**What:** `convex/lib/dateUtils.ts:getMonday` uses UTC Mondays, so a founder in UTC+8 submitting Monday 7am local time lands in UTC Sunday and counts for the previous week. Consider per-user timezone preference or a more forgiving submission window.

**Why:** Live streak now reads directly from `weeklyUpdates`, so any misclassification of `weekOf` directly affects the displayed streak. The problem was latent when a cron owned the value; it is observable now.

**Depends on:** Decision on whether to store a per-user timezone or just widen the submit window.

## Audit Log for Scoped Admin Approvals

**What:** `adminPermissions` rows now support `startupId` scoping, but there is no audit log of which admin approved which milestone/invoice under which scope. Add a table that records `(adminUserId, action, targetId, permissionRowId, timestamp)` on every approval path.

**Why:** Scoped permissions make delegation easier, which means more people approving more things. A trail matters once non-super-admins start acting on behalf of specific startups.

**Depends on:** Agreement on retention policy and admin-facing UI for reviewing the log.

## React Component + E2E Tests

**What:** Add component tests (happy-dom + React Testing Library) for key UI components and E2E tests (Playwright) for critical user flows (login, invoice submission, leaderboard).

**Why:** UI regressions are currently caught only by manual QA. Component tests catch rendering bugs; E2E tests catch integration issues across the full stack.

**Depends on:** `happy-dom`, `@testing-library/react`, and Playwright setup.

## Tracker Proof-of-Work / Challenge Beacon

**What:** Add a server-issued, short-lived signed token that `tracker.js` must fetch (and include in every event POST) before its events are accepted. Origin-bound, nonce-backed, set as an httpOnly cookie so a scripted POST without a real prior page-load fails verification.

**Why:** The IP-hash + rate-limit work hardens against single-IP scripters but does nothing against an attacker with distributed residential proxies. A challenge beacon raises the bar: the attacker's script also has to do a round-trip and persist a cookie per "session," which is harder to scale cheaply. Codex flagged this during the eng review as the only thing that meaningfully bites distributed-IP attacks.

**Context:** New endpoint (e.g. `/api/tracker/challenge`) returns a signed token bound to (origin, ip-hash, timestamp, nonce). `tracker.js` fetches once on first interaction, stores the cookie, includes the token in subsequent POSTs. `convex/http.ts` validates the token before insert. Token TTL ~30 min. Adds a round-trip on session start and a tracker-script update — coordinate with startups before deploying.

**Depends on:** Tracker Anti-Gaming (IP fix) shipping first so we can see whether that alone resolves the gaming. Decision on cookie-vs-localStorage for token persistence (cookie is more attacker-resistant but sets an HTTP cookie on every site embedding the tracker — a small UX implication).

## Fix Tracker Rollup Cron Zero-Fill

**What:** `convex/metrics.ts:fetchTrackerMetrics_cron` (line 1644) only upserts `metricsData` buckets for days that have at least one `trackerEvents` row. Days with zero events keep any stale prior `metricsData` value indefinitely. Fix: emit `value: 0` rows for every day in the 30-day window that has no events.

**Why:** This bug was sidestepped in the tracker-anti-gaming PR by having the spike-scrub migration patch `metricsData` rows directly. But it remains latent: any future manual delete (or another scrub migration) will hit the same trap — events get deleted, metric stays stale, leaderboard reads the lie. Will eventually bite someone.

**Context:** The fix is small (~10 LOC in the cron's bucket-emit loop) but changes the cron's behavior for every site, not just the one that hit the bug. Worth its own PR with explicit verification that no live site relies on the current "skip empty days" behavior. Probably safe but warrants the careful rollout this PR doesn't have time for.

**Depends on:** Nothing strictly. Could ship anytime.

## Investigate Failing Clerk user.deleted Webhook

**What:** `convex/http.ts:213` (`POST /clerk/webhook`) has been returning 500 for every Clerk delivery, going back at least a month (visible in Clerk dashboard → Webhooks → Endpoints → Message Attempts: all `user.deleted` events marked Failed). Root cause: the handler reads `process.env.CLERK_WEBHOOK_SECRET` at `convex/http.ts:219` and that env var is not set on Convex prod (verified via `npx convex env list`). Without the Svix signing secret the handler short-circuits to `return new Response('Server misconfigured', { status: 500 })` before any deletion happens.

**Why:** Data hygiene and GDPR posture. Users deleted from Clerk still have their `users` row + every cascade target (startup memberships, founder profiles, weekly updates, perk claims, notification preferences, etc) sitting in Convex. If anyone has been deleted in response to a deletion request, the deletion is currently half-done — Clerk forgot them, Convex didn't.

**Context:** Two-step fix. (1) Get the signing secret from Clerk dashboard → Webhooks → the endpoint pointing at `sleek-jellyfish-93.convex.site/clerk/webhook` → "Signing Secret" (starts with `whsec_`). Set on Convex prod: `CONVEX_DEPLOY_KEY=<us-prod> npx convex env set CLERK_WEBHOOK_SECRET whsec_...`. Verify by triggering a fresh Clerk user deletion — the next delivery in the Webhooks dashboard should turn green. (2) For the historical backlog, Clerk's UI has a "Replay" button per failed message. Replaying after the env var is set will run `cascadeDeleteUserData` for each deleted user, cleaning up the orphans. The handler code itself (signature verify + `internal.http.deleteUserByClerkId` on `user.deleted`) is correct as written — only the env var is missing.

**Depends on:** Nothing.

## Completed

### Tracker Anti-Gaming (IP + Session Verification)
**Completed:** v0.2.0.0 (2026-04-22). Server-derived sessionId via HMAC(ip||ua||websiteId||utcDay) with IPv4/IPv6 canonicalization and UA length cap. `sourceIpHash` stored on trackerEvents. Three-layer rate limit via `@convex-dev/rate-limiter` (60 events/min per (ipHash, websiteId) + 240/min globally per ipHash + 15 new sessions/IP/site/day). Shared proxy-secret locks the public Convex endpoint to Next.js-originated traffic. Fail-closed on missing secrets. Strict domain enforcement against `trackerWebsites.domain` (requires hostname when domain set). All silent-drop paths return identical 200 response shape so attackers see no signal. Spike-scrub migration `scrubRedefineMeSpikes` cleaned 4/17 + 4/19 spikes on "redefine me" tracker by deleting the heaviest sessionId clusters down to baseline (refuses when baseline data is too sparse to trust); leaderboard recomputed via direct `metricsData` upsert (sidestepping the rollup cron's zero-fill bug, separately tracked above).

### UI Cleanups Deferred From Leaderboard Scoring PR
**Completed:** 2026-04-21. All 5 items shipped as the UI polish follow-up PR (FAV column removal, clickable GitHub usernames, Sync button height alignment, session-scoped tab caching, query ungating to kill tab-switch jump).

### Remove `consistencyBonus: 0` Placeholder From Leaderboard Return Shape
**Completed:** 2026-04-21. Field removed from `ScoreBreakdown` type and from the result-builder in `convex/leaderboard.ts` once the scoring PR had been live long enough for cached Vercel bundles to refresh.

### Rename `weeklyValues` Field in `scoring.test.ts`
**Completed:** v0.1.2.0 (2026-04-21). The misleading test-fixture field was removed entirely along with `computeStartupScore` + `computeConsistencyBonus` tests in the scoring correctness PR. The new `computeLeaderboardScore` tests use clearer per-category scalar inputs (no shared-shape `CategoryMetric` fixture field at all).
