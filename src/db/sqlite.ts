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

import type {
  CountRow,
  Db,
  EventInsert,
  EventRow,
  FunnelStats,
  RevenueRow,
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

  async clearAll(): Promise<void> {
    this.db.exec("DELETE FROM events;");
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
