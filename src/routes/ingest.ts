/**
 * POST /events — public ingest endpoint.
 *
 * Accepts either a single event `{event, params, ts}` or a batch
 * `{events: [{event, params, ts}, ...]}`. We return 202 Accepted on success
 * so the client never blocks a UI thread waiting for a DB write to confirm.
 *
 * Rate limit is per-IP. A misbehaving client can only stall itself.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";

import { config } from "../config";
import type { Db } from "../db";
import { normalize, type IncomingEvent } from "../lib/normalize";
import { RateLimiter } from "../lib/rateLimit";

const limiter = new RateLimiter(config.ingestRatePerMinute);
setInterval(() => limiter.gc(), 5 * 60_000).unref();

type Body = IncomingEvent | { events: IncomingEvent[] };

function clientKey(req: FastifyRequest): string {
  // Render sets X-Forwarded-For; Fastify's `req.ip` respects trustProxy.
  return req.ip || "unknown";
}

export function registerIngest(app: FastifyInstance, db: Db): void {
  app.post<{ Body: Body }>("/events", async (req, reply) => {
    if (!limiter.allow(clientKey(req))) {
      return reply.code(429).send({ ok: false, error: "rate_limited" });
    }

    const body = req.body as Body | undefined;
    if (!body || typeof body !== "object") {
      return reply.code(400).send({ ok: false, error: "invalid_body" });
    }

    const incoming: IncomingEvent[] =
      "events" in body && Array.isArray(body.events)
        ? body.events
        : [(body as IncomingEvent)];

    if (incoming.length === 0) {
      return reply.code(400).send({ ok: false, error: "empty_batch" });
    }
    if (incoming.length > 100) {
      return reply.code(413).send({ ok: false, error: "batch_too_large" });
    }

    let accepted = 0;
    let rejected = 0;
    for (const raw of incoming) {
      const row = normalize(raw);
      if (!row) {
        rejected += 1;
        continue;
      }
      try {
        await db.insertEvent(row);
        accepted += 1;
      } catch (err) {
        req.log.error({ err }, "insert_event_failed");
        rejected += 1;
      }
    }

    return reply.code(202).send({ ok: true, accepted, rejected });
  });

  // Simple health probe for Render.
  app.get("/health", async () => ({ ok: true, ts: Date.now() }));
}
