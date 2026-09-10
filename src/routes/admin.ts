/**
 * /admin/* — bearer-token protected.
 *
 * These endpoints power the dashboard. They're never called by the mobile
 * client, so we can afford richer JSON and no rate limit.
 *
 * `since` is a query param in ms since epoch. Convenience shorthand:
 *   ?since=24h  ?since=7d  ?since=30d  ?since=all
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

import { config } from "../config";
import type { Db } from "../db";

function parseSince(s: unknown): number | undefined {
  if (typeof s !== "string" || !s || s === "all") return undefined;
  const m = /^(\d+)([hdw])$/.exec(s.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const mult = unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 604_800_000;
    return Date.now() - n * mult;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function requireAuth(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!config.adminToken) {
    reply.code(500).send({ ok: false, error: "admin_token_not_configured" });
    return false;
  }
  const h = req.headers.authorization || "";
  const expected = `Bearer ${config.adminToken}`;
  if (h !== expected) {
    reply.code(401).send({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

export function registerAdmin(app: FastifyInstance, db: Db): void {
  app.get<{ Querystring: { since?: string } }>(
    "/admin/funnel",
    async (req, reply) => {
      if (!requireAuth(req, reply)) return;
      const sinceMs = parseSince(req.query.since);
      const funnel = await db.funnel({ sinceMs });
      return { ok: true, sinceMs: sinceMs ?? null, funnel };
    },
  );

  app.get<{ Querystring: { since?: string } }>(
    "/admin/counts",
    async (req, reply) => {
      if (!requireAuth(req, reply)) return;
      const sinceMs = parseSince(req.query.since);
      const counts = await db.countsByEvent({ sinceMs });
      return { ok: true, sinceMs: sinceMs ?? null, counts };
    },
  );

  app.get<{ Querystring: { since?: string } }>(
    "/admin/revenue",
    async (req, reply) => {
      if (!requireAuth(req, reply)) return;
      const sinceMs = parseSince(req.query.since);
      const revenue = await db.revenue({ sinceMs });
      return { ok: true, sinceMs: sinceMs ?? null, revenue };
    },
  );

  app.get<{ Querystring: { since?: string } }>(
    "/admin/countries",
    async (req, reply) => {
      if (!requireAuth(req, reply)) return;
      const sinceMs = parseSince(req.query.since);
      const countries = await db.countries({ sinceMs });
      return { ok: true, sinceMs: sinceMs ?? null, countries };
    },
  );

  app.get<{
    Querystring: {
      since?: string;
      event?: string;
      limit?: string;
      offset?: string;
    };
  }>("/admin/events", async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const sinceMs = parseSince(req.query.since);
    const event = req.query.event?.trim() || undefined;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const [rows, total] = await Promise.all([
      db.listEvents({ limit, offset, event, sinceMs }),
      db.countEvents({ event, sinceMs }),
    ]);
    return { ok: true, total, limit, offset, events: rows };
  });

  app.delete<{ Querystring: { confirm?: string } }>(
    "/admin/clear",
    async (req, reply) => {
      if (!requireAuth(req, reply)) return;
      if (req.query.confirm !== "DELETE_ALL") {
        return reply
          .code(400)
          .send({ ok: false, error: "missing_confirm_DELETE_ALL" });
      }
      await db.clearAll();
      return { ok: true, cleared: true };
    },
  );
}
