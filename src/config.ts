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
  // ⚠️ Display only. The bundle id the Apple webhook VERIFIES against is
  // `appleBundleId` below, read from the environment — because a wrong value
  // here would silently reject every real notification, and a hard-coded
  // string is exactly the thing that goes stale after a bundle change.
  appBundleId: process.env.APPLE_BUNDLE_ID || "com.magicworld.audiobooks",

  // ── App Store Server Notifications V2 ─────────────────────────────────────
  appleBundleId: process.env.APPLE_BUNDLE_ID?.trim() || "",
  appleAppId: Number(process.env.APPLE_APP_ID) || null,
  // Which environment this service accepts. Apple posts sandbox and production
  // to DIFFERENT URLs, configured separately in App Store Connect, so one
  // service only ever needs to know about one. Mixing them turns a sandbox
  // test purchase into a real sale on the dashboard.
  appleEnvironment:
    process.env.APPLE_ENVIRONMENT?.trim() === "Sandbox"
      ? "Sandbox"
      : "Production",
  appleRootCertsDir: process.env.APPLE_ROOT_CERTS_DIR?.trim() || "./certs/apple",
  appleRootCertsB64: process.env.APPLE_ROOT_CERTS_B64?.trim() || "",
  // Webhook path. Can be swapped for something unguessable as an extra layer —
  // signature verification is the real protection, this just cuts scanner noise.
  appleWebhookPath:
    process.env.APPLE_WEBHOOK_PATH?.trim() || "/apple/notifications",
  // Online certificate checks (OCSP + validity against today). Costs a few ms
  // per notification; turn off only if Render starts blowing Apple's timeout.
  appleOnlineChecks: process.env.APPLE_ONLINE_CHECKS !== "false",
  // Escape hatch to run without the .cer files. ⚠️ With verification off,
  // ANYONE who finds the URL can write to your database. Never in production.
  appleSkipVerification: process.env.APPLE_SKIP_VERIFICATION === "true",
  // HMAC secret that turns originalTransactionId into `sub_key`. Changing it
  // orphans every subscription already stored. Set once, never touch.
  subHashSecret:
    process.env.SUB_HASH_SECRET?.trim() || process.env.ADMIN_TOKEN || "",
} as const;

export type Config = typeof config;
