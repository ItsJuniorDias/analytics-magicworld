/**
 * Postgres driver using pg (pure JS, no native build).
 *
 * Chosen automatically when DATABASE_URL is set (see db/index.ts).
 * Render's Postgres addon injects DATABASE_URL via render.yaml.
 */

import { Pool } from "pg";

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

export class PgDb implements Db {
  private readonly pool: Pool;

  constructor(url: string) {
    this.pool = new Pool({
      connectionString: url,
      // Render's managed Postgres requires SSL.
      ssl: url.includes("render.com") ? { rejectUnauthorized: false } : undefined,
      max: 10,
    });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id BIGSERIAL PRIMARY KEY,
        event TEXT NOT NULL,
        ts BIGINT NOT NULL,
        received_at BIGINT NOT NULL,
        session_id TEXT,
        user_id TEXT,
        platform TEXT,
        app_version TEXT,
        country TEXT,
        locale TEXT,
        currency TEXT,
        value DOUBLE PRECISION,
        product_id TEXT,
        params_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_event ON events(event);
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
      CREATE INDEX IF NOT EXISTS idx_events_received_at ON events(received_at);
      CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id);

      -- Subscription state, fed by the Apple webhook.
      CREATE TABLE IF NOT EXISTS subscriptions (
        sub_key           TEXT PRIMARY KEY,
        product_id        TEXT,
        status            TEXT NOT NULL DEFAULT 'active',
        is_trial          BOOLEAN NOT NULL DEFAULT FALSE,
        auto_renew        BOOLEAN NOT NULL DEFAULT TRUE,
        environment       TEXT,
        country           TEXT,
        currency          TEXT,
        price             DOUBLE PRECISION,
        user_id           TEXT,
        started_at        BIGINT,
        expires_at        BIGINT,
        cancelled_at      BIGINT,
        expired_at        BIGINT,
        renewals          INTEGER NOT NULL DEFAULT 0,
        last_notification TEXT,
        updated_at        BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_subs_status ON subscriptions(status);

      -- Idempotency ledger. Apple retries up to 5 times over ~3 days when it
      -- does not get a 2xx; the primary key is what stops a blip on Render
      -- from becoming a duplicate cancellation in the report.
      CREATE TABLE IF NOT EXISTS apple_notifications (
        uuid              TEXT PRIMARY KEY,
        notification_type TEXT,
        subtype           TEXT,
        received_at       BIGINT NOT NULL
      );
    `);
  }

  async claimAppleNotification(
    uuid: string,
    type: string,
    subtype: string | null,
    receivedAt: number,
  ): Promise<boolean> {
    const res = await this.pool.query(
      `INSERT INTO apple_notifications (uuid, notification_type, subtype, received_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT (uuid) DO NOTHING`,
      [uuid, type, subtype, receivedAt],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async getSubscription(subKey: string): Promise<SubscriptionRow | null> {
    const res = await this.pool.query(
      `SELECT * FROM subscriptions WHERE sub_key = $1`,
      [subKey],
    );
    const r = res.rows[0];
    if (!r) return null;
    const n = (v: unknown): number | null => (v == null ? null : Number(v));
    return {
      ...r,
      price: n(r.price),
      started_at: n(r.started_at),
      expires_at: n(r.expires_at),
      cancelled_at: n(r.cancelled_at),
      expired_at: n(r.expired_at),
      renewals: Number(r.renewals ?? 0),
      updated_at: Number(r.updated_at),
    } as SubscriptionRow;
  }

  async upsertSubscription(p: SubscriptionPatch): Promise<void> {
    // COALESCE(EXCLUDED.x, subscriptions.x): a field missing from the
    // notification must NOT erase what we already knew. A cancellation
    // notification carries no price — without the COALESCE, cancelling would
    // zero out the subscription's revenue.
    await this.pool.query(
      `INSERT INTO subscriptions
         (sub_key, product_id, status, is_trial, auto_renew, environment,
          country, currency, price, user_id, started_at, expires_at,
          cancelled_at, expired_at, renewals, last_notification, updated_at)
       VALUES ($1,$2,COALESCE($3,'active'),COALESCE($4,FALSE),COALESCE($5,TRUE),
               $6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (sub_key) DO UPDATE SET
         product_id        = COALESCE(EXCLUDED.product_id, subscriptions.product_id),
         status            = COALESCE(EXCLUDED.status, subscriptions.status),
         is_trial          = COALESCE($4, subscriptions.is_trial),
         auto_renew        = COALESCE($5, subscriptions.auto_renew),
         environment       = COALESCE(EXCLUDED.environment, subscriptions.environment),
         country           = COALESCE(EXCLUDED.country, subscriptions.country),
         currency          = COALESCE(EXCLUDED.currency, subscriptions.currency),
         price             = COALESCE(EXCLUDED.price, subscriptions.price),
         user_id           = COALESCE(EXCLUDED.user_id, subscriptions.user_id),
         started_at        = COALESCE(EXCLUDED.started_at, subscriptions.started_at),
         expires_at        = COALESCE(EXCLUDED.expires_at, subscriptions.expires_at),
         cancelled_at      = COALESCE(EXCLUDED.cancelled_at, subscriptions.cancelled_at),
         expired_at        = COALESCE(EXCLUDED.expired_at, subscriptions.expired_at),
         renewals          = subscriptions.renewals + $15,
         last_notification = COALESCE(EXCLUDED.last_notification, subscriptions.last_notification),
         updated_at        = EXCLUDED.updated_at`,
      [
        p.sub_key,
        p.product_id ?? null,
        p.status ?? null,
        p.is_trial ?? null,
        p.auto_renew ?? null,
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
      ],
    );
  }

  async subscriptionStats(opts: {
    sinceMs?: number;
  }): Promise<SubscriptionStats> {
    const nowMs = Date.now();
    const where = opts.sinceMs ? "AND ts >= $1" : "";
    const args = opts.sinceMs ? [opts.sinceMs] : [];

    const [snap, counts, rev] = await Promise.all([
      this.pool.query(
        // `cancel_pending` is the win-back window: cancelled, but access has
        // not ended yet. After expires_at there is nothing left to offer.
        `SELECT
           SUM(CASE WHEN status = 'active'        THEN 1 ELSE 0 END)::bigint AS active,
           SUM(CASE WHEN status = 'trialing'      THEN 1 ELSE 0 END)::bigint AS trialing,
           SUM(CASE WHEN status = 'cancelled'
                     AND (expires_at IS NULL OR expires_at > $1)
                                                  THEN 1 ELSE 0 END)::bigint AS cancel_pending,
           SUM(CASE WHEN status = 'billing_retry' THEN 1 ELSE 0 END)::bigint AS billing_retry,
           SUM(CASE WHEN status = 'expired'       THEN 1 ELSE 0 END)::bigint AS expired
         FROM subscriptions`,
        [nowMs],
      ),
      this.pool.query(
        `SELECT event, COUNT(*)::bigint AS c FROM events
         WHERE event IN (${sqlList(SUB_EVENTS)}) ${where}
         GROUP BY event`,
        args,
      ),
      this.pool.query(
        `SELECT COALESCE(currency,'') AS currency,
                SUM(CASE WHEN event IN (${sqlList(APPLE_REVENUE_EVENTS)}) THEN value ELSE 0 END) AS gross,
                SUM(CASE WHEN event IN (${sqlList(APPLE_REFUND_EVENTS)})  THEN value ELSE 0 END) AS refunded,
                SUM(CASE WHEN event IN (${sqlList(APPLE_REVENUE_EVENTS)}) THEN 1 ELSE 0 END)::bigint AS charges,
                SUM(CASE WHEN event IN (${sqlList(APPLE_REFUND_EVENTS)})  THEN 1 ELSE 0 END)::bigint AS refunds
         FROM events
         WHERE event IN (${sqlList([...APPLE_REVENUE_EVENTS, ...APPLE_REFUND_EVENTS])})
           AND value IS NOT NULL ${where}
         GROUP BY currency`,
        args,
      ),
    ]);

    const s = snap.rows[0] ?? {};
    const counted: Record<string, number> = {};
    for (const r of counts.rows) counted[r.event as string] = Number(r.c);

    return buildSubscriptionStats(
      opts.sinceMs,
      {
        active: Number(s.active ?? 0),
        trialing: Number(s.trialing ?? 0),
        cancelPending: Number(s.cancel_pending ?? 0),
        billingRetry: Number(s.billing_retry ?? 0),
        expired: Number(s.expired ?? 0),
      },
      counted,
      rev.rows.map((r) => {
        const gross = Number(r.gross ?? 0);
        const refunded = Number(r.refunded ?? 0);
        return {
          currency: (r.currency as string) || "unknown",
          gross,
          refunded,
          net: gross - refunded,
          charges: Number(r.charges ?? 0),
          refunds: Number(r.refunds ?? 0),
        };
      }),
    );
  }

  async insertEvent(row: EventInsert): Promise<void> {
    await this.pool.query(
      `INSERT INTO events
        (event, ts, received_at, session_id, user_id, platform, app_version,
         country, locale, currency, value, product_id, params_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
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
      ],
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
      args.push(opts.event);
      wheres.push(`event = $${args.length}`);
    }
    if (opts.sinceMs) {
      args.push(opts.sinceMs);
      wheres.push(`ts >= $${args.length}`);
    }
    const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
    args.push(opts.limit);
    args.push(opts.offset);
    const res = await this.pool.query(
      `SELECT id, event, ts, received_at, session_id, user_id, platform,
              app_version, country, locale, currency, value, product_id, params_json
       FROM events
       ${whereSql}
       ORDER BY ts DESC
       LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    );
    return res.rows as EventRow[];
  }

  async countEvents(opts: {
    event?: string;
    sinceMs?: number;
  }): Promise<number> {
    const wheres: string[] = [];
    const args: unknown[] = [];
    if (opts.event) {
      args.push(opts.event);
      wheres.push(`event = $${args.length}`);
    }
    if (opts.sinceMs) {
      args.push(opts.sinceMs);
      wheres.push(`ts >= $${args.length}`);
    }
    const whereSql = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";
    const res = await this.pool.query(
      `SELECT COUNT(*)::bigint AS n FROM events ${whereSql}`,
      args,
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  async funnel(opts: { sinceMs?: number }): Promise<FunnelStats> {
    const args: unknown[] = [];
    let whereSql = "";
    if (opts.sinceMs) {
      args.push(opts.sinceMs);
      whereSql = "WHERE ts >= $1";
    }
    const res = await this.pool.query(
      `SELECT
         SUM(CASE WHEN event = 'paywall_view' THEN 1 ELSE 0 END)::bigint AS paywall_view,
         SUM(CASE WHEN event = 'checkout_initiated' THEN 1 ELSE 0 END)::bigint AS checkout_initiated,
         SUM(CASE WHEN event = 'start_trial' THEN 1 ELSE 0 END)::bigint AS start_trial,
         SUM(CASE WHEN event = 'subscribe' THEN 1 ELSE 0 END)::bigint AS subscribe
       FROM events
       ${whereSql}`,
      args,
    );
    const row = res.rows[0] as {
      paywall_view: string | null;
      checkout_initiated: string | null;
      start_trial: string | null;
      subscribe: string | null;
    };
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
      args.push(opts.sinceMs);
      whereSql = "WHERE ts >= $1";
    }
    const res = await this.pool.query(
      `SELECT event, COUNT(*)::bigint AS count
       FROM events
       ${whereSql}
       GROUP BY event
       ORDER BY count DESC`,
      args,
    );
    return res.rows.map((r) => ({
      event: r.event as string,
      count: Number(r.count),
    }));
  }

  async revenue(opts: { sinceMs?: number }): Promise<RevenueRow[]> {
    const args: unknown[] = [];
    let whereSql = "WHERE event = 'subscribe' AND value IS NOT NULL";
    if (opts.sinceMs) {
      args.push(opts.sinceMs);
      whereSql += ` AND ts >= $${args.length}`;
    }
    const res = await this.pool.query(
      `SELECT COALESCE(currency,'') AS currency, SUM(value) AS total, COUNT(*)::bigint AS purchases
       FROM events
       ${whereSql}
       GROUP BY currency`,
      args,
    );
    return res.rows.map((r) => ({
      currency: (r.currency as string) || "unknown",
      total: Number(r.total ?? 0),
      purchases: Number(r.purchases ?? 0),
    }));
  }

  async clearAll(): Promise<void> {
    await this.pool.query("TRUNCATE TABLE events RESTART IDENTITY");
    // Subscription state goes with it: a full `subscriptions` table next to an
    // empty `events` reads as "40 active, 0 subscriptions this period" — a pair
    // of numbers nobody can act on.
    await this.pool.query("TRUNCATE TABLE subscriptions");
    await this.pool.query("TRUNCATE TABLE apple_notifications");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
