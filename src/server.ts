/**
 * Boot the Fastify server.
 *
 * Responsibilities:
 *   • trustProxy so req.ip is the client behind Render's proxy
 *   • CORS if CORS_ORIGINS is set (the iOS client doesn't need it)
 *   • Static dashboard at /
 *   • Ingest route at POST /events, admin routes at /admin/*
 *   • Graceful shutdown so in-flight writes are not truncated
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import Fastify from "fastify";

import { config, storageDriver } from "./config";
import { makeDb } from "./db";
import { registerAdmin } from "./routes/admin";
import { registerIngest } from "./routes/ingest";

async function main(): Promise<void> {
  const app = Fastify({
    logger: { level: config.env === "production" ? "info" : "debug" },
    trustProxy: true,
    bodyLimit: config.maxBodyBytes,
  });

  // CORS minimo, inline pra evitar mais uma dependencia. O cliente iOS nao
  // manda Origin (URLSession), entao nada disto afeta a ingestao.
  //
  // `/admin/*` nunca recebe `*`: sao rotas com token, e liberar qualquer
  // origem a le-las significa que qualquer pagina que o navegador abrir pode
  // fazer a leitura se conseguir o token de algum jeito. Sem CORS_ORIGINS
  // configurado, o dashboard continua funcionando porque e servido pela
  // mesma origem — requisicao de mesma origem nao passa por CORS.
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    const isAdmin = req.url.startsWith("/admin");
    const listed =
      typeof origin === "string" && config.corsOrigins.includes(origin);

    if (isAdmin) {
      if (listed) {
        reply.header("Access-Control-Allow-Origin", origin as string);
        reply.header("Vary", "Origin");
        reply.header("Access-Control-Allow-Methods", "GET,DELETE,OPTIONS");
        reply.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
      }
    } else if (config.corsOrigins.length === 0 || listed) {
      reply.header(
        "Access-Control-Allow-Origin",
        config.corsOrigins.length === 0 ? "*" : (origin as string),
      );
      if (config.corsOrigins.length > 0) reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Content-Type");
    }

    if (req.method === "OPTIONS") {
      reply.code(204).send();
    }
  });

  const db = await makeDb();

  // Esta linha e o primeiro lugar pra olhar quando o dashboard estiver
  // vazio. "sqlite" em producao quer dizer que DATABASE_URL nao chegou e o
  // dado esta indo pro disco efemero do container — some no proximo
  // spin-down. O mesmo aparece em GET /health, sem precisar do log.
  app.log.info({ driver: storageDriver }, "storage initialized");
  if (storageDriver === "sqlite" && config.env === "production") {
    app.log.warn(
      "DATABASE_URL ausente em producao: gravando em SQLite efemero, " +
        "os eventos serao perdidos no proximo restart",
    );
  }

  registerIngest(app, db);
  registerAdmin(app, db);

  // Serve the dashboard. We load the file once at boot and cache the bytes —
  // small (~20KB), no reason to hit disk on every request.
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
