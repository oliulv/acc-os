# Changelog

All notable changes to this project will be documented in this file.

## [0.3.3.1] - 2026-05-21

### Fixed

- Dialogs now scroll when their content is taller than the screen. Before this, a tall modal pushed its action buttons below the bottom edge of the window with no way to scroll, so the buttons were unreachable. This bit the funding adjustment modal hardest: deducting funding with a long founder-visible note made the "Confirm adjustment" button impossible to click. Every dialog now caps at the viewport height and scrolls internally.

## [0.3.3.0] - 2026-05-07

### Changed

- Leaderboard scoring is now growth-only. A flat or declining week earns 0 points instead of dragging the score negative, so a single bad week (or a one-time traffic spike that fades) can no longer erase points the startup earned through actual growth. Time still erodes points via temporal decay. Affects MRR and Traffic categories. Rankings will shift on the first refresh after deploy.

### Fixed

- Analytics page session and pageview cards now show the rolling last-7-day total with a true "vs prior 7 days" comparison. Previously the card displayed today's single-day value with a misleading "+X% vs last week" growth that compared today against the same single day a week ago, which made noisy daily values look like meaningful weekly trends. Cards now require 14 days of data before showing a growth indicator, so a newly-connected tracker no longer reads as inflated growth.
- Admin leaderboard breakdown now explains why a category scores 0. Three states: "no data in the last 28 days," "tracked but no growth in the last 4 weeks," and "growth is negative and the score floors at 0." Previously a missing bar gave no signal whether the integration was disconnected, flat, or declining.

## [0.3.2.1] - 2026-05-06

### Fixed

- Leaderboard scores now reflect new GitHub activity within minutes instead of up to half an hour. Founders pushing commits or PRs see their score move on the next leaderboard refresh, not after the next sync window. The GitHub sync interval drops from 30 to 5 minutes; Stripe and tracker syncs are unchanged.

## [0.3.2.0] - 2026-05-05

### Fixed

- Tracker metric sync no longer fails for high-traffic startups. Previously, a startup with more than ~8,000 lifetime tracker events couldn't sync because the rollup query exceeded Convex's array return limit. Daily metrics are now aggregated inside the query and the database read is bounded to the rollup window.

## [0.3.1.0] - 2026-04-28

### Fixed

- Founder portal no longer crashes when an admin opens a founder-only link (e.g. an announcement). Admins without a founder profile are now redirected to a "founder account required" page with a sign-out option, instead of seeing a Convex server error.

## [0.3.0.0] - 2026-04-28

### Added

- Cohort funding controls: admins can set total allocation and baseline-per-startup, with audited changes recorded against the cohort.
- Per-startup funding adjustments: admins can issue one-off top-ups or deductions with a note; founders see them on their funding page.
- Aggregate funding dashboard for admins: total allocation, money left, deployed/committed/available, top-up pool, utilisation bar, allocation pie chart, time-series history, and a per-startup breakdown table.
- Founder funding adjustments feed showing top-ups and deductions from the accelerator team.
- Notification preference for funding adjustments so founders can opt in/out of top-up and deduction alerts.
- Announcement bodies can include an optional in-app link and now support up to 10,000 characters (previously 500).
- Backfill migration to populate `approvedAt` on existing approved milestones so historical entries appear correctly in the new funding history.

### Changed

- Admin funding page rebuilt to match the rest of the UI: standalone metric cards, larger pie chart with cleaner legend, breakdown rows without nested borders, and a tabular-numerics table that breathes.
- Milestone funding logic moved into `convex/funding.ts` and `convex/lib/fundingMath.ts` with isolated unit tests; `convex/milestones.ts` is now a thin orchestration layer.
- Invoice logic consolidated in `convex/lib/invoiceLogic.ts` for clearer state transitions and easier testing.
- `dev` script now runs through `portless`, so local URLs are stable named hosts (`https://acc-os.localhost`) instead of port numbers.

### Removed

- Schema field `startups.fundingDeployed` is no longer written or read; deployed totals are derived from invoices and adjustments at query time.

## [0.2.1.0] - 2026-04-28

### Fixed

- GitHub connect and reconnect now start from the GitHub App installation flow with signed state, so the callback can complete the same source-of-truth OAuth path after install.
- Manual/admin GitHub sync now refreshes and syncs every connected founder account for the startup, records per-account failures, and preserves successful metrics instead of letting one bad connection overwrite good data.
- GitHub shipping activity now appears as soon as recent founder activity exists instead of waiting for a full 28-day window after the first contribution.

### Added

- Regression coverage for GitHub App install/callback state handling, sync failure handling, and velocity time-series generation.

## [0.2.0.0] - 2026-04-22

### Security

- Tracker collect endpoint no longer trusts the client. The server derives a per-day session id from `HMAC-SHA256(TRACKER_HASH_SECRET, ipTrunc || userAgent || websiteId || dayUtc)` and ignores whatever session id the browser submits. IPv6 addresses truncate to /64 so privacy-extension rotation lands on one fingerprint. A hashed form of the IP is stored on every event for forensics.
- Two transactional rate limits via the new Convex rate-limiter component: 60 events/min per (ipHash, websiteId) with burst 120, plus a per-IP global cap of 240/min with burst 480 so one IP can't multiply its quota by spraying across many websiteIds. A third limit caps "new session ids per IP per site per day" at 15 — when exceeded, events still land but collapse onto a UA-less fallback session id. Defeats user-agent rotation as a session-minting vector.
- Domain enforcement: when a tracker website is registered with a domain, events whose `hostname` doesn't match (or is omitted) are silently dropped. Closes a cross-site forgery path where an attacker could write events into a victim startup's metrics.
- Convex `/tracker/collect` now requires a shared `TRACKER_PROXY_SECRET` header from the Next.js proxy. The Convex .site URL is publicly reachable; without this check an attacker could bypass the proxy and forge the client-IP header. All silent-drop paths return an identical 200 success shape so attackers can't distinguish accept from drop.
- Fail-closed on missing `TRACKER_HASH_SECRET` / `TRACKER_PROXY_SECRET`: the handler returns 500 rather than silently regressing to the prior unauthenticated path.

### Added

- `convex/lib/clientIdent.ts` — pure helpers for IP truncation (IPv4 passthrough, IPv4-mapped IPv6 unwrap, IPv6 /64 with canonical-form normalization), HMAC-SHA256 session id derivation, and ip-hash derivation. Canonical normalization means `"01.02.03.04"` and `"2001:0db8:..."` hash identically to their leading-zero-free forms. User-agent strings cap at 512 chars before hashing so a multi-MB UA can't burn CPU.
- `convex/lib/scrubMath.ts` — pure helpers for the spike-scrub migration: `computeBaseline` computes a per-day session-count mean over the window preceding a spike, excluding other known spike dates; it returns `null` with an `insufficientReason` when the window has fewer than 3 days with traffic, so the migration refuses to delete blindly on a quiet-history site. `planSessionTrim` picks the heaviest sessionId clusters first (bot fingerprints tend to fan many events onto one id).
- `convex/migrations/scrubRedefineMeSpikes.ts` — one-off migration that trims inflated sessions on a tracker website down to baseline by deleting heavy clusters, then directly upserts the daily `metricsData` rows for pageviews, sessions, and weekly_active_users. Supports `dryRun: true` which prints the plan (including the exact session ids it would delete) and makes no writes. Validates input shape, dedupes spike dates, refuses tables above 8k events, and refuses execution when any spike has an insufficient baseline.
- `sourceIpHash` optional field on `trackerEvents` for forensic queries across events from one fingerprint.
- `by_websiteId_sessionId` index on `trackerEvents` supporting the "is this session already known today" lookup in the collect handler.
- `@convex-dev/rate-limiter` component registered in `convex/convex.config.ts`.

### Changed

- Next.js proxy at `/api/tracker/collect` now forwards the client IP (`x-real-ip` or leftmost `x-forwarded-for`), user-agent, and `TRACKER_PROXY_SECRET` to Convex. All three are required for the upstream handler to accept the event.
- `insertTrackerEvent` mutation signature: accepts `sessionIdWithUa`, `sessionIdFallback`, `ipHash`, and `dayUtc` derived at the action layer. The mutation is transactional over the rate-limit check, the existing-session lookup, and the insert.
- `TODOS.md` restructured. "Tracker Anti-Gaming" moved to Completed. Added "Tracker Proof-of-Work / Challenge Beacon" (server-issued signed token for distributed-IP attacks) and "Fix Tracker Rollup Cron Zero-Fill" (a latent bug where `fetchTrackerMetrics_cron` skips days with no events; sidestepped for the redefine-me scrub by having the migration patch `metricsData` directly).

### Fixed

- Deflated two inflated session spikes on the "redefine me" tracker (4/17/2026 and 4/19/2026) to the baseline computed from the surrounding week. The leaderboard recomputes automatically from `metricsData`. Run with `npx convex run --prod migrations/scrubRedefineMeSpikes:run --args '{"websiteName":"redefine me","spikeDates":["2026-04-17","2026-04-19"]}'` after setting the required env vars.

### Deploy notes

- Set `TRACKER_HASH_SECRET` and `TRACKER_PROXY_SECRET` in Convex env (dev + prod) BEFORE deploying: `npx convex env set TRACKER_HASH_SECRET "$(openssl rand -hex 32)"` and similarly for the proxy secret.
- Set the same `TRACKER_PROXY_SECRET` in Vercel project env.
- Rotating `TRACKER_HASH_SECRET` invalidates all live tracker session ids. Rotate at UTC midnight to minimize visible discontinuity in the unique-visitor chart.
- After deploying, run the dry-run migration first (`dryRun: true`), review the proposed deletions, then run without `dryRun`.

## [0.1.5.0] - 2026-04-22

### Security

- Signed OAuth `state` on GitHub and Stripe connect flows. The callbacks now reject tampered, expired, or cross-user state, closing a CSRF class where an attacker could trick a founder into binding the attacker's account. Requires a new `OAUTH_STATE_SECRET` env var (see Deploy notes below).
- Invoice file access is now gated on the invoice the file is attached to, not just "any authenticated user with the storage ID." Cross-tenant file reads via `api.invoices.getFileUrl` are blocked.
- Founders can only attach storage blobs they uploaded themselves to their own invoices. New `storageClaims` table records who uploaded each blob; `invoices.create` and `deleteStorageFile` verify ownership. Closes the bypass where a leaked storage ID could be re-attached to an attacker-owned invoice to exfiltrate the file.
- OTP verification codes now use CSPRNG generation and are stored as SHA-256 hashes, not plaintext. The 5-attempt lockout correctly persists across guesses (a prior version of the hardening accidentally rolled back the counter on every wrong attempt because Convex mutations abort all writes on throw — `confirmVerification` now returns a result instead of throwing).
- Invitation acceptance derives the Clerk account binding from the authenticated identity rather than a client-supplied argument, and requires the Clerk email to match the invited email (case-insensitive). A token-holder can no longer bind an invite to an arbitrary Clerk account.
- Admin invitation acceptance no longer downgrades a super_admin to admin. The role patch now runs only when the invitation's role is strictly higher privilege than the existing user's.
- `getByToken` on both founder and admin invitations returns a minimal projection (email, name, expiry, acceptedAt). A successful lookup by a guessed token no longer leaks the role, cohort, or internal IDs.

### Added

- `convex/lib/random.ts` — CSPRNG helpers for the Convex isolate runtime (no Node-only APIs): `randomBytes`, `randomToken` (URL-safe), `randomIntBelow` (rejection-sampling, no modulo bias), `randomNumericCode`, `timingSafeEqual`, `sha256Hex`.
- `lib/oauthState.ts` — stateless HMAC-SHA256 signed OAuth state with TTL for Next.js App Router routes.
- `convex/lib/{otp,inviteAccept,invoiceAccess}.ts` — pure decision helpers with full unit coverage.
- `storageClaims` table + `api.invoices.claimStorageUpload` mutation — client-side upload → claim → create flow. Any uploader-identity gap closes here.
- Stripe Connect OAuth initiation route (`/api/integrations/stripe/authorize`) with signed state carrying userId and startupId.

### Changed

- `api.invoices.getFileUrl` now requires `invoiceId` in addition to `storageId`. All call sites in admin and founder invoice pages updated.
- `api.invitations.accept` and `api.adminInvitations.accept` no longer take a `clerkId` argument.
- `api.notifications.confirmVerification` now returns `{ ok: true } | { ok: false, reason }` instead of throwing on wrong codes. The settings notifications UI was updated to handle the result shape.

### For admins (deploy)

- **Required env var:** set `OAUTH_STATE_SECRET` to a 32+ byte random string before deploying (`openssl rand -base64 48`). Deploy without it and the GitHub and Stripe OAuth routes will 500.
- **Required env var (Stripe users):** set `STRIPE_CLIENT_ID` from dashboard.stripe.com/settings/connect if you want the new Stripe Connect OAuth flow available.
- Schema adds `otpCodeHash`, `otpAttempts`, and the `storageClaims` table — all optional / additive, no backfill required. The legacy plaintext `otpCode` column is kept for one OTP TTL rollout window (10 min) and can be dropped in a follow-up.

## [0.1.4.0] - 2026-04-21

### Fixed
- Deleting a founder from the admin dashboard now fully cleans up after them. Re-inviting the same email works on the first try instead of throwing "This email has already accepted an invitation for this startup". The cleanup path was case-sensitive on email, so any casing drift between the invitation and the founder's profile left an orphan "accepted" row behind that blocked the next invite.
- New founders can reconnect the same GitHub, Stripe, or Apify account after an old team member is removed. The old connection row now gets detached (disconnected + author cleared + OAuth tokens wiped) instead of sitting on the startup pointing at a deleted user, which used to trigger "this account is already connected by another team member" for the replacement founder.
- Closed the same case-sensitivity gap in the founder-facing "invite teammate" page so founders can't accidentally duplicate-invite by changing email casing.
- Added a guard in the GitHub sync so a running sync can't silently revive a connection that was just detached mid-cleanup.

### For admins (maintenance)
- The `cleanupOrphanedData` internal mutation (runnable from the Convex dashboard) now also detaches integration connections whose owner was deleted, and does all email matching case-insensitively. Run it once post-deploy to clear existing orphans that are blocking current re-invites.

## [0.1.3.0] - 2026-04-21

### Changed
- Admin leaderboard table is cleaner: the standalone FAV column is gone. Favorite info still shows up in the expanded row under "Favorite boost", which was always the more complete place for it.
- Admin startups page remembers which tab you were on (Overview vs Leaderboard) per cohort, so flipping to another admin page and back lands you where you left off. Switching cohorts resets to Overview for the new cohort, no bleed.
- Switching between Overview and Leaderboard tabs on the admin startups page no longer flashes a skeleton. All three cohort queries now warm in parallel on page load.
- The per-founder dropdown on the Shipping analytics tab now has a small external-link icon next to it that opens the selected founder's GitHub profile. Guarded so it only appears when the selection matches a connected account.
- GitHub `@handles` in the Team GitHub Connections card are now clickable links to github.com profiles. Keyboard focus ring added, plus a hover color shift on the muted right-side handle so it's actually discoverable.
- Sync button on the analytics page now aligns at the same height as the range dropdown next to it (was one pixel shorter due to `size="sm"`).

### Fixed
- External-link icon button on the Shipping tab now has an accessible name for screen readers (`aria-label`). Previously relied on `title` alone, which isn't reliably announced.

### Removed
- `consistencyBonus` field removed from the leaderboard return shape. The scoring correctness PR (v0.1.2.0) soft-removed the UI and kept the field at `0` for one release as a deploy-race guard for cached client bundles. Bridge complete, field gone.

### For contributors
- Session-scoped tab caching on the admin startups page was hardened: the sessionStorage read moved from a `useState` initializer into a `useEffect` keyed on `cohortSlug` + `searchParams`, so there's no hydration mismatch on Next.js App Router and no state bleed across cohorts.
- `params` local in `handleViewChange` renamed to `nextParams` so it no longer shadows `useParams()`.

## [0.1.2.0] - 2026-04-21

### Fixed
- Leaderboard scoring no longer gives "free points" to startups with no data. A bug in the power-law normalization added a phantom 3.4 points to every unranked startup's revenue score, which is why Carbase and friends were showing up with 3-ish scores despite zero activity. Now zero data means zero score, every time.
- Revenue growth finally counts a £0 → £500 jump as +100%, not 0%. Founders going from nothing to their first MRR will actually see their score move.
- Revenue and traffic growth capped at ±200% so one outlier week can't dominate the cohort.
- Admin and founder leaderboards now return identical ranks for the same startup. Before, two near-identical copies of the scoring code could drift and show different numbers to admins vs founders.
- Favorite boost no longer vanishes on Monday UTC. The old 1.25× cliff only fired if the admin picked a favorite in the current week; now it's an exp-decay over the last 28 days, so a favorite from a week ago still gives a meaningful lift that gradually fades.

### Changed
- Milestones category removed from leaderboard scoring. Milestones now serve their real purpose — unlocking funding — without being scored as a proxy for startup progress. The old "approved/total" formula was a bad signal anyway.
- Scoring now spans 4 categories with absolute weights: revenue 35%, traffic 25%, GitHub 25%, updates 15%. Revenue carries the most weight because revenue growth is the outcome that matters most.
- Qualification gate is now 3 of 4 active categories (was 3 of 5). Tighter bar.
- Consistency Bonus removed. Math was buggy, inputs were mixed-scale, and at 12-startup cohort size the signal was noise. Explainer UI updated to match.
- "40% Cap" rule removed (it was never doing what the UI claimed it did).
- Favorite indicator on the leaderboard now shows a count when there are multiple favorites in the 28-day window, not just a star for the current week.

### Added
- New shared scoring function `computeLeaderboardScore(perCatRaw, perCatActive, cohortMax, config, favorites)` in `convex/lib/scoring.ts`. Both admin and founder leaderboards call this one function. No more duplicated inline math.
- Admin Favorite section in the scoring explainer, documenting how the new multiplier works.

### For contributors
- `fetchStartupRawData(ctx, startup)` (DB reads) and `assembleCategoryRaw(raw, weeks, now)` (pure) split out from the old inline scoring.
- `assignRanks(currentScores, prevScores, qualified)` pure helper extracted for rank + rank-change logic. 4 unit tests cover tied / empty-prev / new-startup / unqualified-excluded cases.
- `computeLeaderboardScore` has 17 tests covering full cohort, single active, zero everywhere, growth edge cases, favorite boundary, multi-fav stacking, and cohort-max-zero.
- Deleted `computeStartupScore` + `computeConsistencyBonus` + `computeWeeklyComposites` from the shared lib (not just stopped calling them — full delete).
- `ScoreBreakdown.consistencyBonus: 0` retained for one release so cached Vercel bundles don't TypeError on stale `entry.consistencyBonus.toFixed(1)` reads. TODO to hard-remove next PR.

## [0.1.1.0] - 2026-04-21

### Fixed
- Admin weekly-updates tab now shows real Monday dates in its week picker. A local-timezone mix-up was producing Sunday dates that matched zero submissions, so the whole review surface appeared empty even when founders had submitted. Admins can now see and pick favourites on every past week again.

### Changed
- Admin weekly-updates tab opens to the most recent week whose submission deadline has passed, instead of the still-in-progress current week. No more scrolling past an empty view on Monday mornings to get to last week's backlog.

## [0.1.0.0] - 2026-04-16

### Changed
- Velocity scoring now uses one source of truth across bar chart, line graph, and leaderboard. All consumers read from the same calendar data with the same fallback chain.
- Leaderboard computes GitHub velocity from calendar data instead of a stored scalar, ensuring scores always match the analytics page.
- Per-founder velocity breakdown falls back to merged calendar data when typed data is unavailable, fixing empty bar charts.
- Momentum arrows replaced with rank-change arrows showing actual leaderboard position changes week over week.
- GitHub sync reconciles per-type data with the merged contribution calendar so code reviews and other contribution types are never lost.

### Fixed
- Bar chart always shows all three contribution types (Commits, PRs, Issues) even when a type has zero points.
- Per-founder line graph falls through to merged calendar when typed data produces no results.
- Clone script uses ConvexHttpClient instead of broken convexRun subprocess for file copy operations.
- Double-decay bug in leaderboard GitHub scoring removed.
- GraphQL query orders PR and issue contributions DESC so recent activity is captured first.

### Added
- Unified velocity scoring functions (computeVelocityScore, computeVelocityBreakdown) with per-type weights: commits 10pts, PRs 25pts, issues 15pts.
- convertMergedCalendar helper eliminates duplicated calendar conversion code across 4 call sites.
- Per-type daily contribution data stored alongside merged calendar for richer analytics.
