/**
 * Storage abstraction.
 *
 * We use a tiny common interface — `Db` — with two implementations:
 *   • sqlite (node:sqlite, built-in from Node 22.5+) for local dev
 *   • pg (pure JS) for production on Render
 *
 * The choice is automatic: DATABASE_URL set → Postgres, else → sqlite.
 *
 * All routes talk to `Db` — they never see driver-specific quirks.
 */

import { config } from "../config";

export type EventRow = {
  id: number;
  event: string;
  ts: number; // client-provided timestamp (ms since epoch)
  received_at: number; // server received timestamp (ms since epoch)
  session_id: string | null;
  user_id: string | null;
  platform: string | null;
  app_version: string | null;
  country: string | null;
  locale: string | null;
  currency: string | null;
  value: number | null;
  product_id: string | null;
  params_json: string;
};

export type EventInsert = Omit<EventRow, "id" | "received_at">;

export type FunnelStats = {
  paywall_view: number;
  checkout_initiated: number;
  start_trial: number;
  subscribe: number;
  // rates:
  view_to_checkout: number;
  checkout_to_trial: number;
  trial_to_subscribe: number;
  view_to_subscribe: number;
};

export type CountRow = { event: string; count: number };
export type RevenueRow = {
  currency: string;
  total: number;
  purchases: number;
};

// ── Subscriptions: state coming from Apple ──────────────────────────────────
//
// Why a separate table instead of more rows in `events`:
//
//   `events` is an append-only stream of things that happened. A subscription
//   is the opposite: one entity whose STATE changes over months (trial -> paid
//   -> cancelled -> expired). Only state can answer "how many paying
//   subscribers exist right now?" and "was that cancellation a trial or a
//   payer?" — Apple's notification alone says neither.
//
// The key is `sub_key`: HMAC-SHA256 of `originalTransactionId`. Apple's raw id
// is never stored. To investigate one case, HMAC the id the customer gives you
// and look it up.

export type SubscriptionRow = {
  sub_key: string;
  product_id: string | null;
  /** active | trialing | cancelled | expired | billing_retry | refunded | revoked */
  status: string;
  is_trial: boolean;
  /** false = they switched renewal off (may still have access). */
  auto_renew: boolean;
  environment: string | null;
  /** ISO alpha-2 of the storefront — where they PAY. */
  country: string | null;
  currency: string | null;
  /** In currency units, already divided by 1000. */
  price: number | null;
  /** The app's own `appAccountToken`, when the app sends one. */
  user_id: string | null;
  started_at: number | null;
  expires_at: number | null;
  cancelled_at: number | null;
  expired_at: number | null;
  renewals: number;
  last_notification: string | null;
  updated_at: number;
};

/** Fields left `undefined` are preserved — the row is never wholly replaced. */
export type SubscriptionPatch = {
  sub_key: string;
  product_id?: string | null;
  status?: string;
  is_trial?: boolean;
  auto_renew?: boolean;
  environment?: string | null;
  country?: string | null;
  currency?: string | null;
  price?: number | null;
  user_id?: string | null;
  started_at?: number | null;
  expires_at?: number | null;
  cancelled_at?: number | null;
  expired_at?: number | null;
  /** How much to add to `renewals` (0 for most notifications). */
  renewalsInc?: number;
  last_notification?: string | null;
  updated_at: number;
};

export type AppleRevenueRow = {
  currency: string;
  /** Confirmed by Apple: new subscriptions + renewals. */
  gross: number;
  /** Refunded in the period (positive number). */
  refunded: number;
  /** gross - refunded. */
  net: number;
  charges: number;
  refunds: number;
};

export type SubSnapshot = {
  active: number;
  trialing: number;
  /** Cancelled but still has access. The win-back window. */
  cancelPending: number;
  billingRetry: number;
  expired: number;
};

export type SubscriptionStats = {
  sinceMs: number | null;
  /** Snapshot of RIGHT NOW — independent of the selected period. */
  now: SubSnapshot;
  /** Counts INSIDE the period, from the events table. */
  period: Record<string, number>;
  rates: {
    /** trials cancelled / trials started, in the period. */
    trial_cancel: number;
    /** converted / (converted + expired) — resolved trials only. */
    trial_conversion: number;
    /** cancellations / new subscriptions, in the period. */
    cancel: number;
  };
  revenue: AppleRevenueRow[];
};

export interface Db {
  init(): Promise<void>;
  insertEvent(row: EventInsert): Promise<void>;
  listEvents(opts: {
    limit: number;
    offset: number;
    event?: string;
    sinceMs?: number;
  }): Promise<EventRow[]>;
  countEvents(opts: { event?: string; sinceMs?: number }): Promise<number>;
  funnel(opts: { sinceMs?: number }): Promise<FunnelStats>;
  countsByEvent(opts: { sinceMs?: number }): Promise<CountRow[]>;
  revenue(opts: { sinceMs?: number }): Promise<RevenueRow[]>;

  /**
   * Records the notification UUID. Returns `true` if it was new.
   *
   * Apple RESENDS a notification when your server does not answer 2xx (and
   * occasionally even when it does). Without this guard, a 30-second wobble on
   * Render turns into five cancellations on the dashboard.
   */
  claimAppleNotification(
    uuid: string,
    type: string,
    subtype: string | null,
    receivedAt: number,
  ): Promise<boolean>;
  getSubscription(subKey: string): Promise<SubscriptionRow | null>;
  upsertSubscription(patch: SubscriptionPatch): Promise<void>;
  subscriptionStats(opts: { sinceMs?: number }): Promise<SubscriptionStats>;

  clearAll(): Promise<void>;
  close(): Promise<void>;
}

// NOTE on the `.js` in the dynamic imports below: under
// `moduleResolution: Node16` TypeScript requires the extension of the EMITTED
// file, not the source. It still compiles to CommonJS `require()`, and `tsx`
// maps it back to the .ts in dev — both runtimes verified.
export async function makeDb(): Promise<Db> {
  if (config.databaseUrl) {
    const { PgDb } = await import("./pg.js");
    const db = new PgDb(config.databaseUrl);
    await db.init();
    return db;
  }

  // Runtime detection: Bun exposes `bun:sqlite`; Node 22.5+ exposes `node:sqlite`.
  // The two modules have compatible-enough APIs, but neither exists on the
  // other runtime. Guarding here keeps each driver file free of the other's
  // built-in import so nothing gets eagerly resolved and crashes at boot.
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  if (isBun) {
    const { BunSqliteDb } = await import("./sqlite-bun.js");
    const db = new BunSqliteDb(config.sqlitePath);
    await db.init();
    return db;
  }

  const { SqliteDb } = await import("./sqlite.js");
  const db = new SqliteDb(config.sqlitePath);
  await db.init();
  return db;
}
