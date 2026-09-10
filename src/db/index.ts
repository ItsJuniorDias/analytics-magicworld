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
import type { CountryRow } from "../lib/country";

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
export type { CountryRow };
export type RevenueRow = {
  currency: string;
  total: number;
  purchases: number;
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
  countries(opts: { sinceMs?: number }): Promise<CountryRow[]>;
  clearAll(): Promise<void>;
  close(): Promise<void>;
}

export async function makeDb(): Promise<Db> {
  if (config.databaseUrl) {
    const { PgDb } = await import("./pg");
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
    const { BunSqliteDb } = await import("./sqlite-bun");
    const db = new BunSqliteDb(config.sqlitePath);
    await db.init();
    return db;
  }

  const { SqliteDb } = await import("./sqlite");
  const db = new SqliteDb(config.sqlitePath);
  await db.init();
  return db;
}
