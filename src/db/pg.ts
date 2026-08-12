/**
 * Postgres driver using pg (pure JS, no native build).
 *
 * Chosen automatically when DATABASE_URL is set (see db/index.ts).
 * Render's Postgres addon injects DATABASE_URL via render.yaml.
 */

import { Pool } from "pg";

import type {
  CountRow,
  Db,
  EventInsert,
  EventRow,
  FunnelStats,
  RevenueRow,
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
    `);
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
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
