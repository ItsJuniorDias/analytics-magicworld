/**
 * Corpo compartilhado dos dois drivers SQLite.
 *
 * `node:sqlite` (Node 22.5+) e `bun:sqlite` tem APIs quase identicas mas
 * modulos diferentes, e nenhum dos dois existe no outro runtime. Antes disto
 * havia dois arquivos com as mesmas consultas copiadas linha a linha — e o
 * jeito mais facil do funil do dev divergir do funil de producao era alguem
 * corrigir uma copia e esquecer a outra.
 *
 * Agora a consulta mora aqui uma vez so. Cada driver so entrega o handle
 * aberto; a diferenca entre eles fica sendo o `import`, que e o que ela
 * realmente e.
 */

import {
  PAID_EVENTS,
  PURCHASE_EVENTS,
  type CountRow,
  type EventInsert,
  type EventRow,
  type FunnelStats,
  type RevenueRow,
  type SegmentRow,
} from "./index";

export type SqliteStmt = {
  run: (...args: unknown[]) => { changes: number; lastInsertRowid: number };
  all: (...args: unknown[]) => Record<string, unknown>[];
  get: (...args: unknown[]) => Record<string, unknown> | undefined;
};

export type SqliteHandle = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStmt;
  close: () => void;
};

const rate = (num: number, den: number): number => (den > 0 ? num / den : 0);

const inList = (xs: readonly string[]): string =>
  xs.map((s) => `'${s}'`).join(",");

export class SqliteCore {
  protected db!: SqliteHandle;

  /** Chamado pelo driver depois de abrir o handle. */
  protected createSchema(): void {
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

    // Migracao de `source`. SQLite nao tem ADD COLUMN IF NOT EXISTS, entao
    // perguntamos ao PRAGMA antes. Linhas antigas ficam NULL.
    const cols = this.db
      .prepare("PRAGMA table_info(events)")
      .all() as { name: string }[];
    if (!cols.some((c) => c.name === "source")) {
      this.db.exec("ALTER TABLE events ADD COLUMN source TEXT");
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_events_source ON events(source)",
    );
  }

  async insertEvent(row: EventInsert): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO events
          (event, ts, received_at, session_id, user_id, platform, app_version,
           country, locale, currency, value, product_id, source, params_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
    const rows = this.db
      .prepare(
        `SELECT id, event, ts, received_at, session_id, user_id, platform,
                app_version, country, locale, currency, value, product_id,
                source, params_json
         FROM events
         ${whereSql}
         ORDER BY ts DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...args, opts.limit, opts.offset);
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

  /** Ver a nota em db/index.ts sobre por que isto conta pessoas. */
  async funnel(opts: { sinceMs?: number }): Promise<FunnelStats> {
    const args: unknown[] = [];
    let whereSql = "";
    if (opts.sinceMs) {
      whereSql = "WHERE ts >= ?";
      args.push(opts.sinceMs);
    }
    const r =
      (this.db
        .prepare(
          `SELECT
             COUNT(DISTINCT CASE WHEN event = 'paywall_view' THEN user_id END) AS v_users,
             COUNT(DISTINCT CASE WHEN event = 'checkout_initiated' THEN user_id END) AS c_users,
             COUNT(DISTINCT CASE WHEN event IN (${inList(PURCHASE_EVENTS)}) THEN user_id END) AS p_users,
             COUNT(DISTINCT CASE WHEN event = 'start_trial' THEN user_id END) AS t_users,
             COUNT(DISTINCT CASE WHEN event = 'subscribe' THEN user_id END) AS s_users,
             SUM(CASE WHEN event = 'paywall_view' THEN 1 ELSE 0 END) AS v_events,
             SUM(CASE WHEN event = 'checkout_initiated' THEN 1 ELSE 0 END) AS c_events
           FROM events
           ${whereSql}`,
        )
        .get(...args) as Record<string, number | null> | undefined) ?? {};

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
      whereSql = "WHERE ts >= ?";
      args.push(opts.sinceMs);
    }
    const rows = this.db
      .prepare(
        `SELECT event, COUNT(*) AS count FROM events ${whereSql}
         GROUP BY event ORDER BY count DESC`,
      )
      .all(...args) as { event: string; count: number }[];
    return rows.map((r) => ({ event: r.event, count: Number(r.count) }));
  }

  /** So dinheiro que ja entrou. Ver a nota no driver Postgres. */
  async revenue(opts: { sinceMs?: number }): Promise<RevenueRow[]> {
    const args: unknown[] = [];
    let whereSql = `WHERE event IN (${inList(PAID_EVENTS)}) AND value IS NOT NULL`;
    if (opts.sinceMs) {
      whereSql += " AND ts >= ?";
      args.push(opts.sinceMs);
    }
    const rows = this.db
      .prepare(
        `SELECT COALESCE(currency,'') AS currency, SUM(value) AS total, COUNT(*) AS purchases
         FROM events
         ${whereSql}
         GROUP BY currency
         ORDER BY total DESC`,
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

  private segment(
    column: "source" | "country",
    opts: { sinceMs?: number },
  ): SegmentRow[] {
    const args: unknown[] = [];
    let whereSql = "";
    if (opts.sinceMs) {
      whereSql = "WHERE ts >= ?";
      args.push(opts.sinceMs);
    }
    // Window function: SQLite >= 3.25. Node 22 e Bun trazem versoes bem mais
    // novas que isso. Ver a nota no driver Postgres sobre por que a origem
    // precisa ser propagada por usuario.
    const rows = this.db
      .prepare(
        `WITH tagged AS (
           SELECT
             event,
             user_id,
             COALESCE(MAX(${column}) OVER (PARTITION BY user_id), '(desconhecido)') AS k
           FROM events
           ${whereSql}
         )
         SELECT
           k,
           COUNT(DISTINCT CASE WHEN event = 'paywall_view' THEN user_id END) AS v,
           COUNT(DISTINCT CASE WHEN event = 'checkout_initiated' THEN user_id END) AS c,
           COUNT(DISTINCT CASE WHEN event IN (${inList(PURCHASE_EVENTS)}) THEN user_id END) AS p
         FROM tagged
         GROUP BY k
         ORDER BY v DESC`,
      )
      .all(...args) as { k: string; v: number; c: number; p: number }[];

    return rows
      .map((r) => {
        const v = Number(r.v ?? 0);
        const p = Number(r.p ?? 0);
        return {
          key: r.k,
          paywall_view: v,
          checkout_initiated: Number(r.c ?? 0),
          purchase: p,
          view_to_purchase: rate(p, v),
        };
      })
      .filter((r) => r.paywall_view > 0 || r.purchase > 0);
  }

  async bySource(opts: { sinceMs?: number }): Promise<SegmentRow[]> {
    return this.segment("source", opts);
  }

  async byCountry(opts: { sinceMs?: number }): Promise<SegmentRow[]> {
    return this.segment("country", opts);
  }

  async clearAll(): Promise<void> {
    this.db.exec("DELETE FROM events;");
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
