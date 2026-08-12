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
  appBundleId: "com.magicworld.audiobooks",
} as const;

export type Config = typeof config;
