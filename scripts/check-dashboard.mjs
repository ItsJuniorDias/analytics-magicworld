/**
 * Runs the dashboard's <script> outside a browser, against a fake DOM and a
 * fake fetch, and fails if any panel comes back empty.
 *
 * This exists because public/index.html is the only part of the project
 * TypeScript never looks at: it's loose JS inside a <script> tag, served as a
 * string by server.ts. `npm run build` passes, the deploy goes green, and the
 * page can still break silently — a syntax error there kills the whole script,
 * so even the try/catch in refresh() never runs and no error is shown.
 *
 * Usage: npm run check:dashboard
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "public", "index.html"), "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (scripts.length === 0) {
  console.error("no <script> block found in public/index.html");
  process.exit(1);
}
const script = scripts[scripts.length - 1][1];

// ── fake DOM ────────────────────────────────────────────────────────────────
const els = new Map();
function el(id) {
  if (!els.has(id)) {
    els.set(id, {
      id,
      innerHTML: "",
      textContent: "",
      style: {},
      dataset: {},
      classList: { contains: () => false, add() {}, remove() {} },
      setAttribute() {},
      addEventListener() {},
    });
  }
  return els.get(id);
}

// ── payload the admin routes would return ───────────────────────────────────
const FUNNEL = {
  ok: true,
  sinceMs: Date.now() - 86_400_000,
  funnel: {
    paywall_view: 412,
    checkout_initiated: 96,
    start_trial: 31,
    subscribe: 18,
    view_to_checkout: 0.233,
    checkout_to_trial: 0.323,
    trial_to_subscribe: 0.581,
    view_to_subscribe: 0.0437,
  },
};
const REVENUE = {
  ok: true,
  revenue: [
    { currency: "BRL", total: 1194.1, purchases: 12 },
    { currency: "USD", total: 59.94, purchases: 6 },
  ],
};
const COUNTS = {
  ok: true,
  counts: [
    { event: "paywall_view", count: 412 },
    { event: "subscribe", count: 18 },
  ],
};
// Deliberately includes the awkward cases: a null country, a legacy non-ISO
// value, and a country with too few views for a rate.
const COUNTRIES = {
  ok: true,
  countries: [
    { code: "BR", flag: "🇧🇷", name: "Brazil", country: "BR", events: 900, paywall_views: 210, trials: 18, subscribes: 11, rate: 0.0523 },
    { code: "US", flag: "🇺🇸", name: "United States", country: "US", events: 500, paywall_views: 120, trials: 9, subscribes: 5, rate: 0.0416 },
    { code: null, flag: "🏳️", name: "Unknown", country: null, events: 140, paywall_views: 60, trials: 3, subscribes: 2, rate: 0.033 },
    { code: null, flag: "🏳️", name: "Brasil", country: "Brasil", events: 30, paywall_views: 14, trials: 1, subscribes: 0, rate: 0 },
    { code: "JP", flag: "🇯🇵", name: "Japan", country: "JP", events: 20, paywall_views: 8, trials: 1, subscribes: 0, rate: 0 },
  ],
};
const EVENTS = {
  ok: true,
  total: 1590,
  events: [
    { ts: Date.now(), event: "subscribe", user_id: "u_abc123def", platform: "ios", country: "BR", value: 199, currency: "BRL", params_json: '{"sku":"mw_annual_19900"}' },
    { ts: Date.now(), event: "paywall_view", user_id: null, platform: "android", country: null, value: null, currency: null, params_json: "{}" },
  ],
};

// Pre-seed the same keys a real browser would have, so the run exercises the
// happy path instead of the first-visit path.
const store = new Map([
  ["mw_analytics_since", "7d"],
  ["mw_analytics_token", "test-token"],
]);

const sandbox = {
  console,
  Intl,
  Date,
  Math,
  JSON,
  String,
  Number,
  HTMLElement: class {},
  setInterval: () => 0,
  setTimeout,
  confirm: () => false,
  alert: () => {},
  // getToken() falls back to prompt() when nothing is stored. In the harness
  // the token is pre-seeded below, but the stub has to exist anyway — a
  // ReferenceError here would look like a dashboard bug.
  prompt: () => "test-token",
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  },
  document: {
    getElementById: el,
    querySelectorAll: () => [],
    addEventListener() {},
  },
  async fetch(url) {
    if (url.startsWith("/admin/funnel")) return json(FUNNEL);
    if (url.startsWith("/admin/revenue")) return json(REVENUE);
    if (url.startsWith("/admin/countries")) return json(COUNTRIES);
    if (url.startsWith("/admin/counts")) return json(COUNTS);
    if (url.startsWith("/admin/events")) return json(EVENTS);
    throw new Error("unexpected URL in test: " + url);
  },
};
sandbox.window = sandbox;
function json(body) {
  return { ok: true, status: 200, json: async () => body };
}

vm.createContext(sandbox);
try {
  vm.runInContext(script, sandbox, { filename: "dashboard.js" });
} catch (err) {
  console.error("❌ script failed to run:", err.message);
  process.exit(1);
}

setTimeout(() => {
  let failed = false;

  const err = els.get("err");
  if (err && err.style.display === "" && err.textContent) {
    console.log("❌ error banner:", err.textContent);
    failed = true;
  }

  for (const id of ["funnel", "revenue", "countries", "counts", "events"]) {
    const node = els.get(id);
    const html = (node && node.innerHTML) || "";
    const empty = html.trim().length === 0;
    console.log(
      (empty ? "❌" : "✅") +
        " #" +
        id.padEnd(10) +
        (empty ? "EMPTY" : html.replace(/\s+/g, " ").slice(0, 88) + "…"),
    );
    if (empty) failed = true;
  }

  // The flag must actually reach the DOM, not just the payload.
  const countriesHtml = (els.get("countries") || {}).innerHTML || "";
  const hasFlag = /\uD83C[\uDDE6-\uDDFF]/.test(countriesHtml);
  console.log((hasFlag ? "✅" : "❌") + " flags rendered in #countries");
  if (!hasFlag) failed = true;

  console.log(
    "\n" + (failed ? "RESULT: FAILED" : "RESULT: ALL PANELS RENDERED"),
  );
  process.exit(failed ? 1 : 0);
}, 300);
