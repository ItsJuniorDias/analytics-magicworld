/**
 * Country codes, flags, and display names.
 *
 * WHERE THE CODE COMES FROM
 *
 * Three sources, in priority order:
 *
 *   1. `params.country` — whatever the app sends. Best signal when it's the
 *      StoreKit/Play storefront, because that's where the user actually pays.
 *   2. `params.locale` — "pt-BR" carries a region. Only used as a fallback
 *      and only when the tag has a region subtag (see countryFromLocale).
 *   3. The edge header — Cloudflare sits in front of Render and resolves the
 *      IP to a country before the request reaches Fastify. The IP itself is
 *      never read, logged, or stored; we keep two letters.
 *
 * Source 3 is what makes this work for clients already in the wild: no app
 * release needed, and it backfills nothing but starts producing immediately.
 *
 * WHY THE FLAG NEEDS NO LOOKUP TABLE
 *
 * A flag emoji is just the two Regional Indicator Symbols for the letters of
 * the ISO code. "BR" -> 🇧🇷 is arithmetic over code points, not a mapping we
 * have to ship and maintain.
 */

const LETTER_A = 0x41; // 'A'
const REGIONAL_INDICATOR_A = 0x1f1e6; // 🇦

/** Locale used for country display names in the dashboard (which is English). */
const DISPLAY_LOCALE = "en";

/**
 * Sentinel values that look like country codes but are not countries.
 * Cloudflare returns XX when it cannot determine the country and T1 for
 * requests coming out of the Tor network. Storing either would invent a
 * nation in the report.
 */
const NON_COUNTRIES = new Set(["XX", "T1", "ZZ"]);

/**
 * Strict: accepts exactly two letters and nothing else.
 *
 * Deliberately does NOT try to parse locale tags. A bare "pt" is a *language*,
 * and treating it as a country would silently file every Portuguese-speaking
 * user under Portugal. Use countryFromLocale for tags.
 */
export function normalizeCountry(raw: unknown): string | null {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== "string") return null;

  const code = first.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  if (NON_COUNTRIES.has(code)) return null;

  return code;
}

/**
 * Pulls the region out of a BCP-47 tag: "pt-BR" -> "BR", "en_US" -> "US".
 *
 * Returns null for a bare language ("pt") — see the warning above. Also skips
 * script subtags, so "zh-Hant-TW" resolves to TW rather than to "Hant".
 */
export function countryFromLocale(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const parts = raw.trim().split(/[-_]/);
  if (parts.length < 2) return null;

  // Scan from the second subtag on; the region is the first 2-letter one.
  for (const part of parts.slice(1)) {
    const code = normalizeCountry(part);
    if (code) return code;
  }
  return null;
}

/** ISO code -> flag emoji. White flag when unknown: neutral, not a country. */
export function flagEmoji(code: string | null): string {
  const c = normalizeCountry(code);
  if (!c) return "🏳️";

  return String.fromCodePoint(
    ...[...c].map((ch) => REGIONAL_INDICATOR_A + (ch.charCodeAt(0) - LETTER_A)),
  );
}

// Intl.DisplayNames is expensive to construct and always returns the same
// answer, so build it once, lazily.
let displayNames: Intl.DisplayNames | null | undefined;

function getDisplayNames(): Intl.DisplayNames | null {
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames([DISPLAY_LOCALE], {
        type: "region",
      });
    } catch {
      // Node built with small-icu has no region names. Degrade to the raw
      // code rather than throwing — the dashboard stays readable.
      displayNames = null;
    }
  }
  return displayNames;
}

/** "BR" -> "Brazil". Falls back to the code itself when Intl can't help. */
export function countryName(code: string | null): string {
  const c = normalizeCountry(code);
  if (!c) return "Unknown";

  try {
    return getDisplayNames()?.of(c) ?? c;
  } catch {
    return c;
  }
}

/**
 * Resolve the country for one incoming event.
 *
 * Kept here rather than in normalize.ts so the precedence rule lives next to
 * the parsing rules it depends on.
 */
export function resolveCountry(opts: {
  param: unknown;
  locale: unknown;
  edge: string | null;
}): string | null {
  return (
    normalizeCountry(opts.param) ??
    countryFromLocale(opts.param) ??
    countryFromLocale(opts.locale) ??
    opts.edge
  );
}

/**
 * Headers that CDNs and platform edges use for geo. Read in order; first one
 * that yields two valid letters wins.
 *
 * `cf-ipcountry` is the one that matters on Render (Cloudflare fronts it).
 * The rest cost nothing and mean one less thing to change if you migrate.
 */
const COUNTRY_HEADERS = [
  "cf-ipcountry", // Cloudflare (Render)
  "x-vercel-ip-country", // Vercel
  "fastly-client-country", // Fastly
  "x-appengine-country", // Google App Engine
  "x-country-code", // generic (nginx/traefik + GeoIP)
  "x-geo-country", // generic
];

/** Reads the country the edge already resolved. Never touches the IP. */
export function countryFromHeaders(
  headers: Record<string, unknown>,
): string | null {
  for (const h of COUNTRY_HEADERS) {
    const code = normalizeCountry(headers[h]);
    if (code) return code;
  }
  return null;
}

/** Raw aggregation row as the drivers return it. */
export type CountryAgg = {
  country: string | null;
  events: number;
  paywall_views: number;
  trials: number;
  subscribes: number;
};

export type CountryRow = CountryAgg & {
  code: string | null;
  flag: string;
  name: string;
  /** subscribes / paywall_views, 0..1 — same shape as the funnel rates. */
  rate: number;
};

/**
 * Decorate raw counts with flag, name, and conversion rate.
 *
 * Rate is against paywall views, not total events: a country where people
 * listen a lot and nobody subscribes has huge event volume and a low rate,
 * and blending the two would hide exactly that.
 */
export function toCountryRow(agg: CountryAgg): CountryRow {
  const code = normalizeCountry(agg.country);
  return {
    ...agg,
    code,
    flag: flagEmoji(code ?? agg.country),
    // Keep an unrecognized-but-present value visible instead of burying it in
    // "Unknown" — legacy rows may hold whatever the app used to send.
    name: code ? countryName(code) : (agg.country ?? "Unknown"),
    rate: agg.paywall_views > 0 ? agg.subscribes / agg.paywall_views : 0,
  };
}

/** Sorted by paywall views, then by total events. */
export function buildCountryRows(aggs: CountryAgg[]): CountryRow[] {
  return aggs
    .map(toCountryRow)
    .sort((a, b) => b.paywall_views - a.paywall_views || b.events - a.events);
}
