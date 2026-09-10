/**
 * Normalize incoming events.
 *
 * The client sends { event, params, ts } — params is an open bag. We keep
 * the full bag in `params_json` for future analysis and *also* pull the
 * well-known fields into indexed columns so the funnel and revenue queries
 * are fast.
 *
 * We are deliberately liberal about aliases (user_id/userId, product_id/productId,
 * app_version/appVersion) — the mobile client evolves over time and we don't
 * want a rename in the app to blow up our funnel. Prefer snake_case, fall back
 * to camelCase.
 */

import { config } from "../config";
import type { EventInsert } from "../db";

export type IncomingEvent = {
  event: string;
  ts?: number;
  params?: Record<string, unknown>;
};

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s.slice(0, 256) : null;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Read a value from params under any of the given keys, first match wins.
 * The client historically uses snake_case; some newer code emits camelCase.
 */
const pick = <T,>(
  p: Record<string, unknown> | undefined,
  keys: string[],
  cast: (v: unknown) => T | null,
): T | null => {
  if (!p) return null;
  for (const k of keys) {
    if (k in p) {
      const c = cast(p[k]);
      if (c !== null) return c;
    }
  }
  return null;
};

const EVENT_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/i;

/** Eventos em que a moeda faz sentido e pode faltar. */
const MONETARY = new Set(["subscribe", "start_trial", "subscription_renewed"]);

export function normalize(raw: IncomingEvent): EventInsert | null {
  if (!raw || typeof raw !== "object") return null;
  const event = str(raw.event);
  if (!event || !EVENT_NAME_RE.test(event)) return null;

  const p = (raw.params && typeof raw.params === "object" ? raw.params : {}) as Record<
    string,
    unknown
  >;

  const nowMs = Date.now();
  const clientTs = num(raw.ts);
  // Clamp obviously-wrong client timestamps (device clock skew) to now.
  // Anything more than 30d in the future or 365d in the past is nonsense.
  const ts =
    clientTs !== null &&
    clientTs > nowMs - 365 * 86400_000 &&
    clientTs < nowMs + 30 * 86400_000
      ? clientTs
      : nowMs;

  return {
    event,
    ts,
    session_id: pick(p, ["session_id", "sessionId"], str),
    user_id: pick(p, ["user_id", "userId", "app_user_id", "install_id"], str),
    platform: pick(p, ["platform", "os"], str),
    app_version: pick(p, ["app_version", "appVersion", "version"], str),
    country: pick(p, ["country", "country_code", "countryCode", "region"], str),
    locale: pick(p, ["locale", "language", "lang"], str),
    currency:
      pick(p, ["currency", "currency_code", "currencyCode"], str) ??
      (MONETARY.has(event) ? config.defaultCurrency : null),
    value: pick(p, ["value", "price", "amount", "revenue"], num),
    product_id: pick(p, ["product_id", "productId", "sku"], str),
    // O que levou a pessoa ao paywall. So o cliente sabe: a tela de historia
    // bloqueada e o paywall que abre sozinho depois do onboarding sao coisas
    // muito diferentes, e sem isto os dois viram o mesmo numero.
    source: pick(p, ["source", "trigger", "origin"], str),
    params_json: JSON.stringify(p),
  };
}
