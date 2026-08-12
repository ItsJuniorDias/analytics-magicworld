# Magic World — Analytics Backend

First-party analytics sink for the Magic World audiobook app. Receives events from `ANALYTICS_ENDPOINT` and shows the pre-purchase funnel that RevenueCat can't see (paywall view → checkout initiated → trial start → subscribe).

Stack: **Fastify + TypeScript**, **node:sqlite** for local dev (zero native deps), **Postgres** in production. Deploys on Render via `render.yaml` (Blueprint).

---

## Quickstart (local, 30s)

```bash
npm install
cp .env.example .env
# Optional: edit ADMIN_TOKEN in .env
npm run seed    # ~14 days of fake data so the dashboard has something to show
npm run dev     # http://localhost:3000 → dashboard prompts for ADMIN_TOKEN
```

Requires **Node 22.11+** (for the built-in `node:sqlite`). The `.node-version` file pins this so Render picks the right version too.

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
- `GET /admin/events?since=…&event=…&limit=100&offset=0`
- `DELETE /admin/clear?confirm=DELETE_ALL` — wipes the events table

The dashboard prompts for the token on first load and stores it in `localStorage` under `mw_analytics_token`. Clear it from DevTools if you rotate the token.

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

```bash
npm run typecheck   # tsc --noEmit
npm run dev         # tsx watch, auto-reload
npm run build       # tsc → dist/
npm run start       # node dist/server.js  (prod entry)
npm run seed        # populate ~14d of fake events
```

---

## Notes on scope

- **No PII by design.** The client sends `user_id` (RevenueCat's anonymous id), never emails, phone numbers, or advertising IDs. This backend has no place to receive them.
- **Single-instance.** Rate limiter is in-memory. If you ever scale horizontally, swap for Redis. Not worth the dep today.
- **RevenueCat is the source of truth for entitlements.** This backend measures the *pre-purchase* funnel and lets you correlate app-side friction with post-purchase outcomes. Don't gate features on data in this DB.
