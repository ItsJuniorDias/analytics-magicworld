# Magic World — Analytics Backend

First-party analytics sink for the Magic World audiobook app. Receives events from `ANALYTICS_ENDPOINT` and shows the pre-purchase funnel that RevenueCat can't see (paywall view → checkout initiated → trial start → subscribe).

Stack: **Fastify + TypeScript**, **node:sqlite** for local dev (zero native deps), **Postgres** in production. Deploys on Render via `render.yaml` (Blueprint).

---

## Quickstart (local, 30s)

### With Node 22.11+ (uses `node:sqlite`)

```bash
npm install
cp .env.example .env
# Optional: edit ADMIN_TOKEN in .env
npm run seed    # ~14 days of fake data so the dashboard has something to show
npm run dev     # http://localhost:3000 → dashboard prompts for ADMIN_TOKEN
```

Requires **Node 22.11+** (for the built-in `node:sqlite`). The `.node-version` file pins this so Render picks the right version too.

### With Bun (uses `bun:sqlite`)

```bash
bun install
cp .env.example .env
bun run seed:bun   # ~14 days of fake data (via bun runtime)
bun run dev:bun    # http://localhost:3000
```

The backend detects the runtime at boot and picks the right SQLite driver. **Production on Render always uses Node** (pinned via `.node-version` + `render.yaml`), and once `DATABASE_URL` is set it uses Postgres regardless of runtime.

---

## Wire the app to it

In `lib/analytics.ts` inside the Magic World app, set:

```ts
const ANALYTICS_ENDPOINT = "https://<your-render-service>.onrender.com/events";
```

The client posts either a single event or a batch:

```jsonc
// single
{ "event": "paywall_view", "ts": 1755000000000, "params": { ... } }

// batch (max 100 per request)
{ "events": [ { "event": "...", "ts": 0, "params": {...} }, ... ] }
```

Response: `202 { ok: true, accepted: N, rejected: M }`.

---

## Event schema

Every event has `event` (snake_case, `[a-z0-9_]{1,64}`), an optional `ts` (client-side ms; server falls back to now if missing or absurd), and a `params` bag. We store the full bag as JSON *and* pull well-known fields into indexed columns for the funnel and revenue queries.

### Well-known params (all optional, all indexed)

| snake_case         | camelCase alias    | Column        | Use                                             |
| ------------------ | ------------------ | ------------- | ----------------------------------------------- |
| `session_id`       | `sessionId`        | `session_id`  | Group events into a single app session          |
| `user_id`          | `userId` / `app_user_id` / `rc_user_id` | `user_id` | Anonymous / RevenueCat app user id  |
| `platform`         | `os`               | `platform`    | `ios` / `android`                               |
| `app_version`      | `appVersion` / `version` | `app_version` | e.g. `1.4.0`                             |
| `country`          | `country_code` / `countryCode` / `region` | `country`  | ISO country                        |
| `locale`           | `language` / `lang`| `locale`      | `pt-BR`, `en-US`, ...                           |
| `currency`         | `currency_code` / `currencyCode` | `currency` | ISO 4217. Defaults to `BRL` for subscribe/trial |
| `value` / `price` / `amount` / `revenue` | — | `value` | Purchase amount (numeric)                  |
| `product_id`       | `productId` / `sku` / `package_identifier` | `product_id` | RevenueCat / App Store product id  |

### Funnel events (must-emit)

These four are what the dashboard funnels on. Emit them from the app exactly.

| Event                 | When                                                          |
| --------------------- | ------------------------------------------------------------- |
| `paywall_view`        | Paywall becomes visible (screen mount / becomes focused)      |
| `checkout_initiated`  | User taps "Subscribe" / "Start free trial" (BEFORE StoreKit)  |
| `start_trial`         | RevenueCat confirms a trial period started                    |
| `subscribe`           | RevenueCat confirms an active (paid) entitlement              |

Emit anything else freely (`onboarding_step`, `story_open`, `chapter_finished`, ...) — it goes into the raw events browser and event-count panel, so you can spot friction *before* the paywall.

---

## Endpoints

Public:
- `POST /events` — ingest (single or batch). Rate-limited per IP.
- `GET /health` — returns `{ ok: true, ts }`. Used by Render's health check.
- `GET /` — the dashboard.

Admin (all require `Authorization: Bearer $ADMIN_TOKEN`):
- `GET /admin/funnel?since=24h|7d|30d|all`
- `GET /admin/revenue?since=…`
- `GET /admin/counts?since=…` — events grouped by name
- `GET /admin/countries?since=…` — volume and conversion per country, with flag and name
- `GET /admin/events?since=…&event=…&limit=100&offset=0`
- `DELETE /admin/clear?confirm=DELETE_ALL` — wipes the events table

The dashboard prompts for the token on first load and stores it in `localStorage` under `mw_analytics_token`. Clear it from DevTools if you rotate the token.

---

## Countries

Every event carries a two-letter country code. The IP is never read, logged, or
stored.

**Three sources, in priority order:**

1. `params.country` — whatever the app sends. Best signal when it's the
   storefront country, because that's where the user actually pays, which is
   not always where they open the app.
2. `params.locale` — `pt-BR` carries a region, so `BR` is recoverable. Only
   used when the tag *has* a region subtag.
3. The edge header — Cloudflare fronts Render and resolves the IP to a country
   before the request reaches Fastify. `cf-ipcountry` is read; the IP is not.

Source 3 is what makes this work for clients already installed: no app release,
no waiting for review, results starting on deploy.

**A trap worth knowing about.** A bare `pt` is a *language*, not a country.
Treating it as one would file every Portuguese-speaking user under Portugal.
`countryFromLocale` therefore returns `null` for a tag with no region subtag —
only `pt-BR`, `en_US`, `zh-Hant-TW` and friends resolve.

`XX` (edge couldn't determine) and `T1` (Tor) are discarded rather than stored:
they look like country codes and would invent a nation in the report.

**The column is now normalized.** It always held a `country`, but whatever the
app sent went in verbatim — which is fine right up until `BR`, `br` and `pt-BR`
become three separate countries in the same table. Ingest now folds them to ISO
3166-1 alpha-2. Rows written before this keep their old value and show up under
that raw string with a white flag, so nothing is silently lost.

**Flags need no lookup table.** A flag emoji is the two Regional Indicator
Symbols for the letters of the code, so `BR` → 🇧🇷 is arithmetic over code
points. Names come from `Intl.DisplayNames`. No new dependency, no list to keep
up to date.

Rates under 10 paywall views render as `—`: one subscribe out of two views is
not "50% conversion", it's two people.

```bash
curl -s "https://YOUR-SERVICE/admin/countries?since=7d" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## Checking the dashboard before you deploy

```bash
npm run check:dashboard
```

`public/index.html` is the only part of this project TypeScript never looks at:
loose JS inside a `<script>` tag, served as a string by `server.ts`. `npm run
build` passes, the deploy goes green, and the page can still break silently — a
syntax error there kills the whole script, so even the `try/catch` in
`refresh()` never runs and no error banner appears. The symptom is panels that
stay empty forever.

The script executes that `<script>` in a `vm` with a fake DOM and a fake
`fetch`, and fails if any panel renders empty. Run it next to `typecheck`.

---

## Deploy on Render (Blueprint, 2 min)

1. Push this repo to GitHub.
2. On Render: **New +** → **Blueprint** → select the repo.
3. Render reads `render.yaml`, provisions the web service **and** a free Postgres, wires `DATABASE_URL` into the web service, and generates a random `ADMIN_TOKEN`.
4. First deploy pins Node 22.11 (`NODE_VERSION` env + `.node-version`).
5. Open the service URL, enter the `ADMIN_TOKEN` when prompted.

The service auto-switches from `node:sqlite` (local) to Postgres (Render) — no code change. Render's disk is ephemeral, so SQLite would lose data on every redeploy; Postgres persists.

---

## Environment variables

See `.env.example` for the complete list. The essentials:

| Var              | Required in prod | Notes                                            |
| ---------------- | ---------------- | ------------------------------------------------ |
| `DATABASE_URL`   | ✅ (Render sets)  | If set → Postgres; if empty → local sqlite       |
| `ADMIN_TOKEN`    | ✅                | Bearer token for `/admin/*` and the dashboard    |
| `PORT`           | (Render sets)    | Default 3000                                     |
| `DEFAULT_CURRENCY` | ⛔               | Fallback currency for `subscribe`/`start_trial`, default `BRL` |
| `CORS_ORIGINS`   | ⛔               | Comma-separated. Empty = allow all               |
| `INGEST_RATE_PER_MINUTE` | ⛔        | Per-IP token bucket, default 240 rpm             |
| `MAX_BODY_BYTES` | ⛔               | Ingest body limit, default 32KB                  |

---

## Development

Node scripts (default):

```bash
npm run typecheck   # tsc --noEmit
npm run dev         # tsx watch, auto-reload
npm run build       # tsc → dist/
npm run start       # node dist/src/server.js  (prod entry)
npm run seed        # populate ~14d of fake events
```

Bun scripts (local dev on Bun):

```bash
bun run dev:bun     # bun --watch, auto-reload
bun run start:bun   # bun runs src/server.ts directly (no build step)
bun run seed:bun    # populate ~14d of fake events via bun
```

---

## Notes on scope

- **No PII by design.** The client sends `user_id` (RevenueCat's anonymous id), never emails, phone numbers, or advertising IDs. This backend has no place to receive them.
- **Single-instance.** Rate limiter is in-memory. If you ever scale horizontally, swap for Redis. Not worth the dep today.
- **RevenueCat is the source of truth for entitlements.** This backend measures the *pre-purchase* funnel and lets you correlate app-side friction with post-purchase outcomes. Don't gate features on data in this DB.
