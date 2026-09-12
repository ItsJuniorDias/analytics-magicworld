/**
 * Builds the subscription block from raw counts.
 *
 * Lives outside the drivers on purpose: pg, sqlite and sqlite-bun must return
 * the SAME number. Every time arithmetic lives inside the SQL it eventually
 * drifts between drivers, and nobody notices until two dashboards disagree.
 */

import type { AppleRevenueRow, SubSnapshot, SubscriptionStats } from "../db";
import { SUB_EVENT } from "./events";

const rate = (num: number, den: number): number => (den > 0 ? num / den : 0);

export function buildSubscriptionStats(
  sinceMs: number | undefined,
  snapshot: SubSnapshot,
  counts: Record<string, number>,
  revenue: AppleRevenueRow[],
): SubscriptionStats {
  const n = (k: string): number => counts[k] ?? 0;

  const trialStarted = n(SUB_EVENT.trialStarted);
  const trialCancelled = n(SUB_EVENT.trialCancelled);
  const trialConverted = n(SUB_EVENT.trialConverted);
  const trialExpired = n(SUB_EVENT.trialExpired);
  const fresh = n(SUB_EVENT.started) + trialStarted + n(SUB_EVENT.resubscribed);

  // Denominator counts RESOLVED trials only — converted or expired. Trials
  // still running are excluded: including them makes the rate start
  // artificially low every day and "improve" on its own as they mature.
  const resolvedTrials = trialConverted + trialExpired;

  return {
    sinceMs: sinceMs ?? null,
    now: snapshot,
    period: {
      [SUB_EVENT.started]: n(SUB_EVENT.started),
      [SUB_EVENT.trialStarted]: trialStarted,
      [SUB_EVENT.resubscribed]: n(SUB_EVENT.resubscribed),
      [SUB_EVENT.cancelled]: n(SUB_EVENT.cancelled),
      [SUB_EVENT.trialCancelled]: trialCancelled,
      [SUB_EVENT.reactivated]: n(SUB_EVENT.reactivated),
      [SUB_EVENT.renewed]: n(SUB_EVENT.renewed),
      [SUB_EVENT.trialConverted]: trialConverted,
      [SUB_EVENT.expired]: n(SUB_EVENT.expired),
      [SUB_EVENT.trialExpired]: trialExpired,
      [SUB_EVENT.billingIssue]: n(SUB_EVENT.billingIssue),
      [SUB_EVENT.refunded]: n(SUB_EVENT.refunded),
      [SUB_EVENT.revoked]: n(SUB_EVENT.revoked),
    },
    rates: {
      trial_cancel: rate(trialCancelled, trialStarted),
      trial_conversion: rate(trialConverted, resolvedTrials),
      cancel: rate(n(SUB_EVENT.cancelled), fresh),
    },
    revenue,
  };
}
