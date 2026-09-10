/**
 * SQLite driver using Bun's built-in `bun:sqlite`.
 *
 * Chosen when we detect the Bun runtime (see db/index.ts). Bun does NOT
 * expose Node's `node:sqlite` — it has its own module with a nearly
 * identical API. All the query shapes below match the SqliteDb version;
 * only the constructor and the `prepare` result type differ slightly.
 *
 * Kept as a separate file so `import("./sqlite")` (node) never even
 * touches `bun:sqlite`, and vice-versa.
 */

type BunStmt = {
  run: (...args: unknown[]) => { changes: number; lastInsertRowid: number };
  all: (...args: unknown[]) => Record<string, unknown>[];
  get: (...args: unknown[]) => Record<string, unknown> | undefined;
};
type BunDbHandle = {
  exec: (sql: string) => void;
  prepare: (sql: string) => BunStmt;
  query: (sql: string) => BunStmt;
  close: () => void;
};

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { buildCountryRows, type CountryRow } from "../lib/country";
import type {
  CountRow,
  Db,
  EventInsert,
  EventRow,
  FunnelStats,
  RevenueRow,
} from "./index";

export class BunSqliteDb implements Db {
  private db!: BunDbHandle;
  private readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  async init(): Promise<void> {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // Dynamic import guarded by the runtime check in db/index.ts —
    // this file only runs on Bun. `@types/bun` (devDependency) supplies
    // the types so the cast just narrows the shape we actually use.
    const mod = (await import("bun:sqlite")) as unknown as {
      Database: new (path: string) => BunDbHandle;
    };
    this.db = new mod.Database(this.path);

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
      CREATE INDEX IF NOT EXISTS idx_events_country ON events(country);
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

  /**
   * Per-country volume and conversion.
   *
   * SUM(CASE ...) rather than COUNT(*) FILTER so the SQL is byte-identical
   * across all three drivers — the funnel and this report can't drift apart
   * because of a dialect difference.
   *
   * Rows with country NULL group together and surface as "Unknown". That is
   * the truth (edge couldn't resolve it, or the row predates this column
   * being populated) and is more useful than silently dropping them.
   */
  async countries(opts: { sinceMs?: number }): Promise<CountryRow[]> {
    const args: unknown[] = [];
    let whereSql = "";
    if (opts.sinceMs) {
      whereSql = "WHERE ts >= ?";
      args.push(opts.sinceMs);
    }
    const rows = this.db
      .prepare(
        `SELECT country,
                COUNT(*) AS events,
                SUM(CASE WHEN event = 'paywall_view' THEN 1 ELSE 0 END) AS paywall_views,
                SUM(CASE WHEN event = 'start_trial'  THEN 1 ELSE 0 END) AS trials,
                SUM(CASE WHEN event = 'subscribe'    THEN 1 ELSE 0 END) AS subscribes
         FROM events
         ${whereSql}
         GROUP BY country`,
      )
      .all(...args);
    return buildCountryRows(
      rows.map((r) => ({
        country: (r.country as string | null) ?? null,
        events: Number(r.events ?? 0),
        paywall_views: Number(r.paywall_views ?? 0),
        trials: Number(r.trials ?? 0),
        subscribes: Number(r.subscribes ?? 0),
      })),
    );
  }

  async clearAll(): Promise<void> {
    this.db.exec("DELETE FROM events;");
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
