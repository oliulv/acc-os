/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as adminCohorts from "../adminCohorts.js";
import type * as adminInvitations from "../adminInvitations.js";
import type * as adminPermissions from "../adminPermissions.js";
import type * as adminUsers from "../adminUsers.js";
import type * as ai from "../ai.js";
import type * as analytics from "../analytics.js";
import type * as announcements from "../announcements.js";
import type * as apify from "../apify.js";
import type * as auth from "../auth.js";
import type * as bankDetails from "../bankDetails.js";
import type * as cohortEvents from "../cohortEvents.js";
import type * as cohorts from "../cohorts.js";
import type * as crons from "../crons.js";
import type * as dev_swapClerkIds from "../dev/swapClerkIds.js";
import type * as fileClone from "../fileClone.js";
import type * as founderInvitations from "../founderInvitations.js";
import type * as founderOnboarding from "../founderOnboarding.js";
import type * as founderProfile from "../founderProfile.js";
import type * as founderStartup from "../founderStartup.js";
import type * as functions from "../functions.js";
import type * as funding from "../funding.js";
import type * as http from "../http.js";
import type * as integrations from "../integrations.js";
import type * as invitations from "../invitations.js";
import type * as invoiceBatching from "../invoiceBatching.js";
import type * as invoiceValidation from "../invoiceValidation.js";
import type * as invoices from "../invoices.js";
import type * as leaderboard from "../leaderboard.js";
import type * as lib_clientIdent from "../lib/clientIdent.js";
import type * as lib_dateUtils from "../lib/dateUtils.js";
import type * as lib_fundingMath from "../lib/fundingMath.js";
import type * as lib_githubStats from "../lib/githubStats.js";
import type * as lib_inviteAccept from "../lib/inviteAccept.js";
import type * as lib_invoiceAccess from "../lib/invoiceAccess.js";
import type * as lib_invoiceLogic from "../lib/invoiceLogic.js";
import type * as lib_logging from "../lib/logging.js";
import type * as lib_notificationTypes from "../lib/notificationTypes.js";
import type * as lib_otp from "../lib/otp.js";
import type * as lib_providers from "../lib/providers.js";
import type * as lib_random from "../lib/random.js";
import type * as lib_resendRetry from "../lib/resendRetry.js";
import type * as lib_scoring from "../lib/scoring.js";
import type * as lib_scrubMath from "../lib/scrubMath.js";
import type * as lib_slugify from "../lib/slugify.js";
import type * as lib_streak from "../lib/streak.js";
import type * as lib_stripeMrr from "../lib/stripeMrr.js";
import type * as lib_tokens from "../lib/tokens.js";
import type * as lib_trackerDomain from "../lib/trackerDomain.js";
import type * as lib_trackerRollup from "../lib/trackerRollup.js";
import type * as lib_userCleanup from "../lib/userCleanup.js";
import type * as metrics from "../metrics.js";
import type * as migrations_backfillConnectedByUserId from "../migrations/backfillConnectedByUserId.js";
import type * as migrations_backfillIsPartnership from "../migrations/backfillIsPartnership.js";
import type * as migrations_backfillMilestoneApprovedAt from "../migrations/backfillMilestoneApprovedAt.js";
import type * as migrations_backfillMilestoneLastSubmittedAt from "../migrations/backfillMilestoneLastSubmittedAt.js";
import type * as migrations_scrubRedefineMeSpikes from "../migrations/scrubRedefineMeSpikes.js";
import type * as migrations_stripBankDetailsVerified from "../migrations/stripBankDetailsVerified.js";
import type * as migrations_stripUpdateStreak from "../migrations/stripUpdateStreak.js";
import type * as migrations_updateSupabasePerk from "../migrations/updateSupabasePerk.js";
import type * as milestoneTemplates from "../milestoneTemplates.js";
import type * as milestones from "../milestones.js";
import type * as notificationAdmin from "../notificationAdmin.js";
import type * as notifications from "../notifications.js";
import type * as perks from "../perks.js";
import type * as resources from "../resources.js";
import type * as seed from "../seed.js";
import type * as startups from "../startups.js";
import type * as trackerWebsites from "../trackerWebsites.js";
import type * as users from "../users.js";
import type * as weeklyUpdates from "../weeklyUpdates.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  adminCohorts: typeof adminCohorts;
  adminInvitations: typeof adminInvitations;
  adminPermissions: typeof adminPermissions;
  adminUsers: typeof adminUsers;
  ai: typeof ai;
  analytics: typeof analytics;
  announcements: typeof announcements;
  apify: typeof apify;
  auth: typeof auth;
  bankDetails: typeof bankDetails;
  cohortEvents: typeof cohortEvents;
  cohorts: typeof cohorts;
  crons: typeof crons;
  "dev/swapClerkIds": typeof dev_swapClerkIds;
  fileClone: typeof fileClone;
  founderInvitations: typeof founderInvitations;
  founderOnboarding: typeof founderOnboarding;
  founderProfile: typeof founderProfile;
  founderStartup: typeof founderStartup;
  functions: typeof functions;
  funding: typeof funding;
  http: typeof http;
  integrations: typeof integrations;
  invitations: typeof invitations;
  invoiceBatching: typeof invoiceBatching;
  invoiceValidation: typeof invoiceValidation;
  invoices: typeof invoices;
  leaderboard: typeof leaderboard;
  "lib/clientIdent": typeof lib_clientIdent;
  "lib/dateUtils": typeof lib_dateUtils;
  "lib/fundingMath": typeof lib_fundingMath;
  "lib/githubStats": typeof lib_githubStats;
  "lib/inviteAccept": typeof lib_inviteAccept;
  "lib/invoiceAccess": typeof lib_invoiceAccess;
  "lib/invoiceLogic": typeof lib_invoiceLogic;
  "lib/logging": typeof lib_logging;
  "lib/notificationTypes": typeof lib_notificationTypes;
  "lib/otp": typeof lib_otp;
  "lib/providers": typeof lib_providers;
  "lib/random": typeof lib_random;
  "lib/resendRetry": typeof lib_resendRetry;
  "lib/scoring": typeof lib_scoring;
  "lib/scrubMath": typeof lib_scrubMath;
  "lib/slugify": typeof lib_slugify;
  "lib/streak": typeof lib_streak;
  "lib/stripeMrr": typeof lib_stripeMrr;
  "lib/tokens": typeof lib_tokens;
  "lib/trackerDomain": typeof lib_trackerDomain;
  "lib/trackerRollup": typeof lib_trackerRollup;
  "lib/userCleanup": typeof lib_userCleanup;
  metrics: typeof metrics;
  "migrations/backfillConnectedByUserId": typeof migrations_backfillConnectedByUserId;
  "migrations/backfillIsPartnership": typeof migrations_backfillIsPartnership;
  "migrations/backfillMilestoneApprovedAt": typeof migrations_backfillMilestoneApprovedAt;
  "migrations/backfillMilestoneLastSubmittedAt": typeof migrations_backfillMilestoneLastSubmittedAt;
  "migrations/scrubRedefineMeSpikes": typeof migrations_scrubRedefineMeSpikes;
  "migrations/stripBankDetailsVerified": typeof migrations_stripBankDetailsVerified;
  "migrations/stripUpdateStreak": typeof migrations_stripUpdateStreak;
  "migrations/updateSupabasePerk": typeof migrations_updateSupabasePerk;
  milestoneTemplates: typeof milestoneTemplates;
  milestones: typeof milestones;
  notificationAdmin: typeof notificationAdmin;
  notifications: typeof notifications;
  perks: typeof perks;
  resources: typeof resources;
  seed: typeof seed;
  startups: typeof startups;
  trackerWebsites: typeof trackerWebsites;
  users: typeof users;
  weeklyUpdates: typeof weeklyUpdates;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  rateLimiter: {
    lib: {
      checkRateLimit: FunctionReference<
        "query",
        "internal",
        {
          config:
            | {
                capacity?: number;
                kind: "token bucket";
                maxReserved?: number;
                period: number;
                rate: number;
                shards?: number;
                start?: null;
              }
            | {
                capacity?: number;
                kind: "fixed window";
                maxReserved?: number;
                period: number;
                rate: number;
                shards?: number;
                start?: number;
              };
          count?: number;
          key?: string;
          name: string;
          reserve?: boolean;
          throws?: boolean;
        },
        { ok: true; retryAfter?: number } | { ok: false; retryAfter: number }
      >;
      clearAll: FunctionReference<
        "mutation",
        "internal",
        { before?: number },
        null
      >;
      getServerTime: FunctionReference<"mutation", "internal", {}, number>;
      getValue: FunctionReference<
        "query",
        "internal",
        {
          config:
            | {
                capacity?: number;
                kind: "token bucket";
                maxReserved?: number;
                period: number;
                rate: number;
                shards?: number;
                start?: null;
              }
            | {
                capacity?: number;
                kind: "fixed window";
                maxReserved?: number;
                period: number;
                rate: number;
                shards?: number;
                start?: number;
              };
          key?: string;
          name: string;
          sampleShards?: number;
        },
        {
          config:
            | {
                capacity?: number;
                kind: "token bucket";
                maxReserved?: number;
                period: number;
                rate: number;
                shards?: number;
                start?: null;
              }
            | {
                capacity?: number;
                kind: "fixed window";
                maxReserved?: number;
                period: number;
                rate: number;
                shards?: number;
                start?: number;
              };
          shard: number;
          ts: number;
          value: number;
        }
      >;
      rateLimit: FunctionReference<
        "mutation",
        "internal",
        {
          config:
            | {
                capacity?: number;
                kind: "token bucket";
                maxReserved?: number;
                period: number;
                rate: number;
                shards?: number;
                start?: null;
              }
            | {
                capacity?: number;
                kind: "fixed window";
                maxReserved?: number;
                period: number;
                rate: number;
                shards?: number;
                start?: number;
              };
          count?: number;
          key?: string;
          name: string;
          reserve?: boolean;
          throws?: boolean;
        },
        { ok: true; retryAfter?: number } | { ok: false; retryAfter: number }
      >;
      resetRateLimit: FunctionReference<
        "mutation",
        "internal",
        { key?: string; name: string },
        null
      >;
    };
    time: {
      getServerTime: FunctionReference<"mutation", "internal", {}, number>;
    };
  };
};
