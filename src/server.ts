/**
 * Boot the Fastify server.
 *
 * Responsibilities:
 *   • trustProxy so req.ip is the client behind Render's proxy
 *   • CORS if CORS_ORIGINS is set (mobile client doesn't need it)
 *   • Static dashboard at /
 *   • Ingest route at POST /events, admin routes at /admin/*
 *   • Graceful shutdown so in-flight writes are not truncated
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import Fastify from "fastify";

import { config } from "./config";
import { makeDb } from "./db";
import { registerAdmin } from "./routes/admin";
import { registerAppleNotifications } from "./routes/appleNotifications";
import { registerIngest } from "./routes/ingest";

async function main(): Promise<void> {
  const app = Fastify({
    logger: { level: config.env === "production" ? "info" : "debug" },
    trustProxy: true,
    bodyLimit: config.maxBodyBytes,
  });

  // Minimal CORS. We inline it to avoid a plugin dependency; the mobile
  // client sends no Origin header (React Native fetch), so this only matters
  // if you ever call /events from a browser.
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    const allowed =
      config.corsOrigins.length === 0 ||
      (typeof origin === "string" && config.corsOrigins.includes(origin));
    if (allowed) {
      const allowValue =
        config.corsOrigins.length === 0 ? "*" : (origin as string);
      reply.header("Access-Control-Allow-Origin", allowValue);
      reply.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
      reply.header(
        "Access-Control-Allow-Headers",
        "Content-Type,Authorization",
      );
    }
    if (req.method === "OPTIONS") {
      reply.code(204).send();
    }
  });

  const db = await makeDb();
  app.log.info(
    { driver: config.databaseUrl ? "postgres" : "sqlite" },
    "storage initialized",
  );

  registerIngest(app, db);
  registerAdmin(app, db);
  // Apple's webhook. Deliberately outside the ingest rate limiter: Apple
  // bursts retries when it thinks you did not receive something, and a 429
  // from us would create exactly the data loss this endpoint exists to stop.
  await registerAppleNotifications(app, db);

  // Serve the dashboard. We load the file once at boot and cache the bytes —
  // small (~15KB), no reason to hit disk on every request.
  //
  // Look in a few plausible spots so both `tsx src/server.ts` (dev) and
  // `node dist/src/server.js` (prod) work without a copy step in the build.
  const dashboardCandidates = [
    join(process.cwd(), "public", "index.html"), // most common — matches package.json cwd
    join(__dirname, "..", "public", "index.html"), // src/server.ts case
    join(__dirname, "..", "..", "public", "index.html"), // dist/src/server.js case
  ];
  const dashboardPath = dashboardCandidates.find((p) => existsSync(p));
  if (!dashboardPath) {
    throw new Error(
      "dashboard_not_found: expected public/index.html in one of " +
        dashboardCandidates.join(", "),
    );
  }
  const dashboard = readFileSync(dashboardPath);
  app.get("/", async (_req, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8");
    return dashboard;
  });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      await db.close();
    } catch (err) {
      app.log.error({ err }, "shutdown_error");
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal_boot_error", err);
  process.exit(1);
});
