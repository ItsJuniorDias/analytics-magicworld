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
  source: string | null; // o que levou a pessoa ao paywall
  params_json: string;
};

export type EventInsert = Omit<EventRow, "id" | "received_at">;

/**
 * O funil, medido em PESSOAS e nao em eventos.
 *
 * Por que pessoas: quem abre o paywall cinco vezes e uma pessoa que nao
 * comprou, nao cinco. Contar evento faz `view_to_checkout` virar razao entre
 * volumes, que sobe e desce com quantas vezes cada um abriu a tela — nao com
 * quantos converteram.
 *
 * Por que `purchase` e um passo so: o app emite `start_trial` OU `subscribe`
 * no mesmo instante, dependendo do produto ter periodo gratis. Sao ramos
 * irmaos do mesmo passo, nao passos em sequencia. Tratar como sequencia
 * (o que este arquivo fazia antes) produz numeros sem significado: dez
 * compras mensais e dez trials anuais no mesmo dia liam como "100% de
 * conversao de trial".
 *
 * NAO existe aqui uma taxa trial → pago. Essa conversao acontece dias depois,
 * no servidor da Apple, com o app fechado. Ela nao e observavel deste lado e
 * inventar um numero pra ela e pior que nao ter. Ver README, secao "O que
 * este backend nao mede".
 */
export type FunnelStats = {
  // pessoas distintas em cada passo
  paywall_view: number;
  checkout_initiated: number;
  purchase: number; // start_trial OU subscribe

  // como `purchase` se divide
  trial_started: number; // entrou em periodo gratis, ainda nao pagou
  paid_now: number; // pagou na hora

  // volume bruto de eventos, so pra sanidade (quantas vezes disparou)
  paywall_view_events: number;
  checkout_initiated_events: number;

  // taxas, sempre sobre pessoas distintas
  view_to_checkout: number;
  checkout_to_purchase: number;
  view_to_purchase: number;
};

export type CountRow = { event: string; count: number };

export type RevenueRow = {
  currency: string;
  total: number;
  purchases: number;
};

/** Uma linha por origem de paywall (`source`), ou por pais. */
export type SegmentRow = {
  key: string;
  paywall_view: number;
  checkout_initiated: number;
  purchase: number;
  view_to_purchase: number;
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
  bySource(opts: { sinceMs?: number }): Promise<SegmentRow[]>;
  byCountry(opts: { sinceMs?: number }): Promise<SegmentRow[]>;
  clearAll(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Eventos que contam como "a pessoa converteu neste passo do funil".
 * Um lugar so, pra os tres drivers nao divergirem com o tempo.
 */
export const PURCHASE_EVENTS = ["start_trial", "subscribe"] as const;

/** Eventos em que dinheiro de fato trocou de mao. Trial NAO entra. */
export const PAID_EVENTS = ["subscribe", "subscription_renewed"] as const;

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
