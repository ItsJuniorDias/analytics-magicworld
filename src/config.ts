/**
 * Central config. Reads environment variables once and exposes a typed object.
 * Every module imports from here — no `process.env` scattered around.
 */

const num = (v: string | undefined, d: number): number => {
  if (!v) return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const list = (v: string | undefined): string[] =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  port: num(process.env.PORT, 3000),
  host: process.env.HOST || "0.0.0.0",
  env: process.env.NODE_ENV || "development",

  databaseUrl: process.env.DATABASE_URL || "",
  sqlitePath: process.env.SQLITE_PATH || "./data/analytics.db",

  adminToken: process.env.ADMIN_TOKEN || "",
  corsOrigins: list(process.env.CORS_ORIGINS),

  maxBodyBytes: num(process.env.MAX_BODY_BYTES, 32 * 1024),
  ingestRatePerMinute: num(process.env.INGEST_RATE_PER_MINUTE, 240),

  defaultCurrency: (process.env.DEFAULT_CURRENCY || "BRL").toUpperCase(),

  // Product identity — used only for display/logging, never for gating.
  appName: "Magic World",
  appBundleId: "com.alexandre.juniort10.magicworld",
} as const;

/**
 * Qual driver de armazenamento este boot vai usar.
 *
 * Isto existe porque a diferenca entre os dois e invisivel de fora e muda
 * tudo: em Postgres o dado sobrevive; em SQLite no Render ele mora num disco
 * efemero e some a cada spin-down e a cada deploy. Um dashboard vazio pode
 * ser "ninguem usou o app" ou "o banco evaporou ontem", e sem isto exposto
 * nao ha como saber qual dos dois.
 *
 * Aparece no log de boot e em GET /health.
 */
export const storageDriver: "postgres" | "sqlite" = config.databaseUrl
  ? "postgres"
  : "sqlite";

export type Config = typeof config;
