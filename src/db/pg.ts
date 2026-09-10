/**
 * Postgres driver using pg (pure JS, no native build).
 *
 * Chosen automatically when DATABASE_URL is set (see db/index.ts).
 * Render's Postgres addon injects DATABASE_URL via render.yaml.
 */

import { Pool } from "pg";

import {
  PAID_EVENTS,
  PURCHASE_EVENTS,
  type CountRow,
  type Db,
  type EventInsert,
  type EventRow,
  type FunnelStats,
  type RevenueRow,
  type SegmentRow,
} from "./index";

const rate = (num: number, den: number): number => (den > 0 ? num / den : 0);

/** `'a','b'` pronto pra interpolar num IN (...). Lista fechada em codigo. */
const inList = (xs: readonly string[]): string =>
  xs.map((s) => `'${s}'`).join(",");

export class PgDb implements Db {
  private readonly pool: Pool;

  /**
   * Postgres gerenciado exige SSL; Postgres na sua maquina nao tem.
   *
   * Isto ja foi `url.includes("render.com")`, o que amarrava o backend a um
   * provedor so — e justamente na hora de sair do Render, que e quando o
   * banco free expira, a conexao sairia sem SSL e falharia. A pergunta certa
   * nao e "e Render?", e "e local?".
   *
   * `rejectUnauthorized: false` porque Render, Neon e Supabase servem
   * certificados que nem sempre encadeiam nas raizes que o Node conhece.
   * Isso protege o trafego mas nao verifica a identidade do servidor;
   * para um sink de analytics anonimo e a troca aceitavel. Se um dia isto
   * carregar algo mais sensivel, passe o CA do provedor.
   */
  private static sslFor(url: string): false | { rejectUnauthorized: boolean } {
    if (process.env.PGSSL === "disable") return false;
    const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
    return local ? false : { rejectUnauthorized: false };
  }

  constructor(url: string) {
    this.pool = new Pool({
      connectionString: url,
      ssl: PgDb.sslFor(url),
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

    // Migracao: `source` foi adicionado depois. Tabelas criadas antes disto
    // nao tem a coluna, e CREATE TABLE IF NOT EXISTS nao adiciona nada a uma
    // tabela que ja existe. Linhas antigas ficam com NULL, que o dashboard
    // mostra como "desconhecido" — dado velho nao vira dado novo.
    await this.pool.query(
      `ALTER TABLE events ADD COLUMN IF NOT EXISTS source TEXT`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_events_source ON events(source)`,
    );
  }

  async insertEvent(row: EventInsert): Promise<void> {
    await this.pool.query(
      `INSERT INTO events
        (event, ts, received_at, session_id, user_id, platform, app_version,
         country, locale, currency, value, product_id, source, params_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
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
        row.source,
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
              app_version, country, locale, currency, value, product_id,
              source, params_json
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

  /**
   * COUNT(DISTINCT user_id) em cada passo. Eventos sem `user_id` ficam de
   * fora da contagem de pessoas — nao ha como atribui-los a ninguem, e
   * chutar seria pior que omitir.
   */
  async funnel(opts: { sinceMs?: number }): Promise<FunnelStats> {
    const args: unknown[] = [];
    let whereSql = "";
    if (opts.sinceMs) {
      args.push(opts.sinceMs);
      whereSql = "WHERE ts >= $1";
    }
    const res = await this.pool.query(
      `SELECT
         COUNT(DISTINCT CASE WHEN event = 'paywall_view' THEN user_id END)::bigint AS v_users,
         COUNT(DISTINCT CASE WHEN event = 'checkout_initiated' THEN user_id END)::bigint AS c_users,
         COUNT(DISTINCT CASE WHEN event IN (${inList(PURCHASE_EVENTS)}) THEN user_id END)::bigint AS p_users,
         COUNT(DISTINCT CASE WHEN event = 'start_trial' THEN user_id END)::bigint AS t_users,
         COUNT(DISTINCT CASE WHEN event = 'subscribe' THEN user_id END)::bigint AS s_users,
         SUM(CASE WHEN event = 'paywall_view' THEN 1 ELSE 0 END)::bigint AS v_events,
         SUM(CASE WHEN event = 'checkout_initiated' THEN 1 ELSE 0 END)::bigint AS c_events
       FROM events
       ${whereSql}`,
      args,
    );
    const r = res.rows[0] ?? {};
    const v = Number(r.v_users ?? 0);
    const c = Number(r.c_users ?? 0);
    const p = Number(r.p_users ?? 0);
    return {
      paywall_view: v,
      checkout_initiated: c,
      purchase: p,
      trial_started: Number(r.t_users ?? 0),
      paid_now: Number(r.s_users ?? 0),
      paywall_view_events: Number(r.v_events ?? 0),
      checkout_initiated_events: Number(r.c_events ?? 0),
      view_to_checkout: rate(c, v),
      checkout_to_purchase: rate(p, c),
      view_to_purchase: rate(p, v),
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

  /**
   * So dinheiro que ja entrou: compra paga na hora e renovacao.
   * Trial iniciado nao e receita — vira receita dias depois, num evento que
   * este backend so ve se o app estiver aberto quando a Apple avisar.
   *
   * Sem conversao cambial de proposito: uma linha por moeda. Somar BRL com
   * USD numa cifra so exige uma cotacao e uma data, e um numero errado com
   * cara de certo e pior que duas linhas.
   */
  async revenue(opts: { sinceMs?: number }): Promise<RevenueRow[]> {
    const args: unknown[] = [];
    let whereSql = `WHERE event IN (${inList(PAID_EVENTS)}) AND value IS NOT NULL`;
    if (opts.sinceMs) {
      args.push(opts.sinceMs);
      whereSql += ` AND ts >= $${args.length}`;
    }
    const res = await this.pool.query(
      `SELECT COALESCE(currency,'') AS currency, SUM(value) AS total, COUNT(*)::bigint AS purchases
       FROM events
       ${whereSql}
       GROUP BY currency
       ORDER BY total DESC`,
      args,
    );
    return res.rows.map((r) => ({
      currency: (r.currency as string) || "unknown",
      total: Number(r.total ?? 0),
      purchases: Number(r.purchases ?? 0),
    }));
  }

  private async segment(
    column: "source" | "country",
    opts: { sinceMs?: number },
  ): Promise<SegmentRow[]> {
    const args: unknown[] = [];
    let whereSql = "";
    if (opts.sinceMs) {
      args.push(opts.sinceMs);
      whereSql = "WHERE ts >= $1";
    }
    // `source` so existe em paywall_view. Pra saber quantos DESSE grupo
    // seguiram adiante, propagamos a origem por usuario com uma window
    // function, senao checkout e compra cairiam todos em "desconhecido".
    const res = await this.pool.query(
      `WITH tagged AS (
         SELECT
           event,
           user_id,
           COALESCE(
             MAX(${column}) OVER (PARTITION BY user_id),
             '(desconhecido)'
           ) AS k
         FROM events
         ${whereSql}
       )
       SELECT
         k,
         COUNT(DISTINCT CASE WHEN event = 'paywall_view' THEN user_id END)::bigint AS v,
         COUNT(DISTINCT CASE WHEN event = 'checkout_initiated' THEN user_id END)::bigint AS c,
         COUNT(DISTINCT CASE WHEN event IN (${inList(PURCHASE_EVENTS)}) THEN user_id END)::bigint AS p
       FROM tagged
       GROUP BY k
       ORDER BY v DESC`,
      args,
    );
    return res.rows
      .map((r) => {
        const v = Number(r.v ?? 0);
        const p = Number(r.p ?? 0);
        return {
          key: r.k as string,
          paywall_view: v,
          checkout_initiated: Number(r.c ?? 0),
          purchase: p,
          view_to_purchase: rate(p, v),
        };
      })
      .filter((r) => r.paywall_view > 0 || r.purchase > 0);
  }

  bySource(opts: { sinceMs?: number }): Promise<SegmentRow[]> {
    return this.segment("source", opts);
  }

  byCountry(opts: { sinceMs?: number }): Promise<SegmentRow[]> {
    return this.segment("country", opts);
  }

  async clearAll(): Promise<void> {
    await this.pool.query("TRUNCATE TABLE events RESTART IDENTITY");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
