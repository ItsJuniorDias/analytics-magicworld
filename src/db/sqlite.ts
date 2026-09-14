/**
 * SQLite driver using Node's built-in `node:sqlite` module.
 *
 * Why the built-in? Zero native compilation. Works on Node 22.11 out of the box
 * on Render, Fly, Railway, and Docker without a build toolchain.
 *
 * Requires Node >= 22.5. The .node-version file pins 22.11.0.
 */

// The types for node:sqlite are still experimental in @types/node, so we
// re-declare the tiny surface we use rather than pulling a broken type.
// This keeps `strict: true` happy without disabling checks.
type Stmt = {
  run: (...args: unknown[]) => { changes: number; lastInsertRowid: number };
  all: (...args: unknown[]) => Record<string, unknown>[];
  get: (...args: unknown[]) => Record<string, unknown> | undefined;
};
type SqliteHandle = {
  exec: (sql: string) => void;
  prepare: (sql: string) => Stmt;
  close: () => void;
};

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  APPLE_REFUND_EVENTS,
  APPLE_REVENUE_EVENTS,
  SUB_EVENTS,
  sqlList,
} from "../lib/events";
import { buildSubscriptionStats } from "../lib/subStats";
import type {
  CountRow,
  Db,
  EventInsert,
  EventRow,
  FunnelStats,
  RevenueRow,
  SubscriptionPatch,
  SubscriptionRow,
  SubscriptionStats,
} from "./index";

export class SqliteDb implements Db {
  private db!: SqliteHandle;
  private readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  async init(): Promise<void> {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // Dynamic import so TS doesn't try to resolve node:sqlite at compile time
    // (types not yet stable in @types/node).
    const mod = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (path: string) => SqliteHandle;
    };
    this.db = new mod.DatabaseSync(this.path);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        ts INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        session_id TEXT,
        user_id TEXT,
        platform TEXT,
        app_version TEXT,
        country TEXT,
        locale TEXT,
        currency TEXT,
        value REAL,
        product_id TEXT,
        params_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_event ON events(event);
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
      CREATE INDEX IF NOT EXISTS idx_events_received_at ON events(received_at);
      CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id);

      -- Subscription state, fed by the Apple webhook. Booleans are INTEGER
      -- 0/1 — SQLite has no real boolean type.
      CREATE TABLE IF NOT EXISTS subscriptions (
        sub_key           TEXT PRIMARY KEY,
        product_id        TEXT,
        status            TEXT    NOT NULL DEFAULT 'active',
        is_trial          INTEGER NOT NULL DEFAULT 0,
        auto_renew        INTEGER NOT NULL DEFAULT 1,
        environment       TEXT,
        country           TEXT,
        currency          TEXT,
        price             REAL,
        user_id           TEXT,
        started_at        INTEGER,
        expires_at        INTEGER,
        cancelled_at      INTEGER,
        expired_at        INTEGER,
        renewals          INTEGER NOT NULL DEFAULT 0,
        last_notification TEXT,
        updated_at        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_subs_status ON subscriptions(status);

      -- Idempotency ledger. Apple retries up to 5 times over ~3 days when it
      -- does not get a 2xx; the primary key is what stops a blip on Render
      -- from becoming a duplicate cancellation in the report.
      CREATE TABLE IF NOT EXISTS apple_notifications (
        uuid              TEXT PRIMARY KEY,
        notification_type TEXT,
        subtype           TEXT,
        received_at       INTEGER NOT NULL
      );
    `);
  }

  async insertEvent(row: EventInsert): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO events
        (event, ts, received_at, session_id, user_id, platform, app_version,
         country, locale, currency, value, product_id, params_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      row.event,
      row.ts,
      Date.now(),
      row.session_id,
      row.user_id,
      row.platform,
      row.app_version,
      row.country,
      row.locale,
      row.currency,
      row.value,
      row.product_id,
      row.params_json,
    );
  }

  async listEvents(opts: {
    limit: number;
    offset: number;
    event?: string;
    sinceMs?: number;
  }): Promise<EventRow[]> {
    const wheres: string[] = [];
    const args: unknown[] = [];
    if (opts.event) {
      wheres.push("event = ?");
      args.push(opts.event);
    }
    if (opts.sinceMs) {
      wheres.push("ts >= ?");
      args.push(opts.sinceMs);
    }
    const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
    const sql = `
      SELECT id, event, ts, received_at, session_id, user_id, platform,
             app_version, country, locale, currency, value, product_id, params_json
      FROM events
      ${whereSql}
      ORDER BY ts DESC
      LIMIT ? OFFSET ?
    `;
    const rows = this.db.prepare(sql).all(...args, opts.limit, opts.offset);
    return rows as unknown as EventRow[];
  }

  async countEvents(opts: {
    event?: string;
    sinceMs?: number;
  }): Promise<number> {
    const wheres: string[] = [];
    const args: unknown[] = [];
    if (opts.event) {
      wheres.push("event = ?");
      args.push(opts.event);
    }
    if (opts.sinceMs) {
      wheres.push("ts >= ?");
      args.push(opts.sinceMs);
    }
    const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM events ${whereSql}`)
      .get(...args) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  async funnel(opts: { sinceMs?: number }): Promise<FunnelStats> {
    const args: unknown[] = [];
    let whereSql = "";
    if (opts.sinceMs) {
      whereSql = "WHERE ts >= ?";
      args.push(opts.sinceMs);
    }
    const row = this.db
      .prepare(
        `
      SELECT
        SUM(CASE WHEN event = 'paywall_view' THEN 1 ELSE 0 END) AS paywall_view,
        SUM(CASE WHEN event = 'checkout_initiated' THEN 1 ELSE 0 END) AS checkout_initiated,
        SUM(CASE WHEN event = 'start_trial' THEN 1 ELSE 0 END) AS start_trial,
        SUM(CASE WHEN event = 'subscribe' THEN 1 ELSE 0 END) AS subscribe
      FROM events
      ${whereSql}
    `,
      )
      .get(...args) as
      | {
          paywall_view: number | null;
          checkout_initiated: number | null;
          start_trial: number | null;
          subscribe: number | null;
        }
      | undefined;

    const v = Number(row?.paywall_view ?? 0);
    const c = Number(row?.checkout_initiated ?? 0);
    const t = Number(row?.start_trial ?? 0);
    const s = Number(row?.subscribe ?? 0);
    const rate = (num: number, den: number): number =>
      den > 0 ? num / den : 0;
    return {
      paywall_view: v,
      checkout_initiated: c,
      start_trial: t,
      subscribe: s,
      view_to_checkout: rate(c, v),
      checkout_to_trial: rate(t, c),
      trial_to_subscribe: rate(s, t),
      view_to_subscribe: rate(s, v),
    };
  }

  async countsByEvent(opts: { sinceMs?: number }): Promise<CountRow[]> {
    const args: unknown[] = [];
    let whereSql = "";
    if (opts.sinceMs) {
      whereSql = "WHERE ts >= ?";
      args.push(opts.sinceMs);
    }
    const rows = this.db
      .prepare(
        `SELECT event, COUNT(*) AS count FROM events ${whereSql} GROUP BY event ORDER BY count DESC`,
      )
      .all(...args) as { event: string; count: number }[];
    return rows.map((r) => ({ event: r.event, count: Number(r.count) }));
  }

  async revenue(opts: { sinceMs?: number }): Promise<RevenueRow[]> {
    const args: unknown[] = [];
    let whereSql = "WHERE event = 'subscribe' AND value IS NOT NULL";
    if (opts.sinceMs) {
      whereSql += " AND ts >= ?";
      args.push(opts.sinceMs);
    }
    const rows = this.db
      .prepare(
        `SELECT COALESCE(currency,'') AS currency, SUM(value) AS total, COUNT(*) AS purchases
         FROM events
         ${whereSql}
         GROUP BY currency`,
      )
      .all(...args) as {
      currency: string;
      total: number;
      purchases: number;
    }[];
    return rows.map((r) => ({
      currency: r.currency || "unknown",
      total: Number(r.total ?? 0),
      purchases: Number(r.purchases ?? 0),
    }));
  }


  async claimAppleNotification(
    uuid: string,
    type: string,
    subtype: string | null,
    receivedAt: number,
  ): Promise<boolean> {
    const res = this.db
      .prepare(
        `INSERT INTO apple_notifications (uuid, notification_type, subtype, received_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(uuid) DO NOTHING`,
      )
      .run(uuid, type, subtype, receivedAt);
    return Number(res.changes) > 0;
  }

  async getSubscription(subKey: string): Promise<SubscriptionRow | null> {
    const row = this.db
      .prepare(`SELECT * FROM subscriptions WHERE sub_key = ?`)
      .get(subKey);
    if (!row) return null;
    return {
      ...row,
      is_trial: Number(row.is_trial) === 1,
      auto_renew: Number(row.auto_renew) === 1,
      renewals: Number(row.renewals ?? 0),
      updated_at: Number(row.updated_at),
    } as unknown as SubscriptionRow;
  }

  async upsertSubscription(p: SubscriptionPatch): Promise<void> {
    // COALESCE(?, subscriptions.x) on every column: a cancellation
    // notification carries no price and no product, and overwriting with NULL
    // would erase what we already knew about the subscription.
    this.db
      .prepare(
        `INSERT INTO subscriptions
           (sub_key, product_id, status, is_trial, auto_renew, environment,
            country, currency, price, user_id, started_at, expires_at,
            cancelled_at, expired_at, renewals, last_notification, updated_at)
         VALUES (?, ?, COALESCE(?,'active'), COALESCE(?,0), COALESCE(?,1),
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sub_key) DO UPDATE SET
           product_id        = COALESCE(excluded.product_id, subscriptions.product_id),
           status            = COALESCE(excluded.status, subscriptions.status),
           is_trial          = COALESCE(?, subscriptions.is_trial),
           auto_renew        = COALESCE(?, subscriptions.auto_renew),
           environment       = COALESCE(excluded.environment, subscriptions.environment),
           country           = COALESCE(excluded.country, subscriptions.country),
           currency          = COALESCE(excluded.currency, subscriptions.currency),
           price             = COALESCE(excluded.price, subscriptions.price),
           user_id           = COALESCE(excluded.user_id, subscriptions.user_id),
           started_at        = COALESCE(excluded.started_at, subscriptions.started_at),
           expires_at        = COALESCE(excluded.expires_at, subscriptions.expires_at),
           cancelled_at      = COALESCE(excluded.cancelled_at, subscriptions.cancelled_at),
           expired_at        = COALESCE(excluded.expired_at, subscriptions.expired_at),
           renewals          = subscriptions.renewals + ?,
           last_notification = COALESCE(excluded.last_notification, subscriptions.last_notification),
           updated_at        = excluded.updated_at`,
      )
      .run(
        p.sub_key,
        p.product_id ?? null,
        p.status ?? null,
        boolNum(p.is_trial),
        boolNum(p.auto_renew),
        p.environment ?? null,
        p.country ?? null,
        p.currency ?? null,
        p.price ?? null,
        p.user_id ?? null,
        p.started_at ?? null,
        p.expires_at ?? null,
        p.cancelled_at ?? null,
        p.expired_at ?? null,
        p.renewalsInc ?? 0,
        p.last_notification ?? null,
        p.updated_at,
        // repeated for the UPDATE branch (no placeholder reuse in sqlite)
        boolNum(p.is_trial),
        boolNum(p.auto_renew),
        p.renewalsInc ?? 0,
      );
  }

  async subscriptionStats(opts: {
    sinceMs?: number;
  }): Promise<SubscriptionStats> {
    const nowMs = Date.now();
    // `cancel_pending` is the win-back window: cancelled, but access has not
    // ended yet. After expires_at there is nothing left to offer.
    const snap = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'active'        THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN status = 'trialing'      THEN 1 ELSE 0 END) AS trialing,
           SUM(CASE WHEN status = 'cancelled'
                     AND (expires_at IS NULL OR expires_at > ?)
                                                  THEN 1 ELSE 0 END) AS cancel_pending,
           SUM(CASE WHEN status = 'billing_retry' THEN 1 ELSE 0 END) AS billing_retry,
           SUM(CASE WHEN status = 'expired'       THEN 1 ELSE 0 END) AS expired
         FROM subscriptions`,
      )
      .get(nowMs) as Record<string, number> | undefined;

    const where = opts.sinceMs ? "AND ts >= ?" : "";
    const args = opts.sinceMs ? [opts.sinceMs] : [];

    const counts = this.db
      .prepare(
        `SELECT event, COUNT(*) AS c FROM events
         WHERE event IN (${sqlList(SUB_EVENTS)}) ${where}
         GROUP BY event`,
      )
      .all(...args) as { event: string; c: number }[];

    const rev = this.db
      .prepare(
        `SELECT COALESCE(currency,'') AS currency,
                SUM(CASE WHEN event IN (${sqlList(APPLE_REVENUE_EVENTS)}) THEN value ELSE 0 END) AS gross,
                SUM(CASE WHEN event IN (${sqlList(APPLE_REFUND_EVENTS)})  THEN value ELSE 0 END) AS refunded,
                SUM(CASE WHEN event IN (${sqlList(APPLE_REVENUE_EVENTS)}) THEN 1 ELSE 0 END) AS charges,
                SUM(CASE WHEN event IN (${sqlList(APPLE_REFUND_EVENTS)})  THEN 1 ELSE 0 END) AS refunds
         FROM events
         WHERE event IN (${sqlList([...APPLE_REVENUE_EVENTS, ...APPLE_REFUND_EVENTS])})
           AND value IS NOT NULL ${where}
         GROUP BY currency`,
      )
      .all(...args) as {
      currency: string;
      gross: number;
      refunded: number;
      charges: number;
      refunds: number;
    }[];

    const counted: Record<string, number> = {};
    for (const r of counts) counted[r.event] = Number(r.c);

    return buildSubscriptionStats(
      opts.sinceMs,
      {
        active: Number(snap?.active ?? 0),
        trialing: Number(snap?.trialing ?? 0),
        cancelPending: Number(snap?.cancel_pending ?? 0),
        billingRetry: Number(snap?.billing_retry ?? 0),
        expired: Number(snap?.expired ?? 0),
      },
      counted,
      rev.map((r) => {
        const gross = Number(r.gross ?? 0);
        const refunded = Number(r.refunded ?? 0);
        return {
          currency: r.currency || "unknown",
          gross,
          refunded,
          net: gross - refunded,
          charges: Number(r.charges ?? 0),
          refunds: Number(r.refunds ?? 0),
        };
      }),
    );
  }

  async clearAll(): Promise<void> {
    this.db.exec(
      // Subscription state goes with it: a full `subscriptions` table next to
      // an empty `events` reads as "40 active, 0 subscriptions this period" —
      // a pair of numbers nobody can act on.
      "DELETE FROM events; DELETE FROM subscriptions; DELETE FROM apple_notifications;",
    );
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/** SQLite has no boolean: true->1, false->0, undefined->null (= leave alone). */
function boolNum(v: boolean | undefined): number | null {
  return v === undefined ? null : v ? 1 : 0;
}
