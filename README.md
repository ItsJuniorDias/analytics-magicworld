# Magic World — Analytics Backend

First-party analytics sink for the Magic World audiobook app. Receives events from `ANALYTICS_ENDPOINT` and shows the pre-purchase funnel that RevenueCat can't see (paywall view → checkout initiated → trial start → subscribe).

Stack: **Fastify + TypeScript**, **node:sqlite** for local dev (zero native deps), **Postgres** in production. Deploys on Render via `render.yaml` (Blueprint).

---

## ⚠️ The leaked ADMIN_TOKEN

`.env` is committed to this repository, and the repository is **public**
(`github.com/ItsJuniorDias/analytics-magicworld`). The file is readable by
anyone, without logging in — verified again just now. The `ADMIN_TOKEN` inside
it is the only thing protecting `/admin/*`: every event, every user id, the
whole funnel.

The `.gitignore` in this drop stops the *next* commit. It does **not** rewrite
history: the token stays in every past commit and in anyone's clone. So the
token has to be replaced, not hidden.

```bash
# 1. stop tracking the files (they stay on disk)
git rm --cached .env data/analytics.db
git commit -m "stop tracking .env and local db"

# 2. rotate the token on Render: Environment → ADMIN_TOKEN → Generate → deploy
#    (the old value is public; treat it as burned)

# 3. optional but worth it — scrub the history
#    git-filter-repo is the tool Git's own docs recommend over filter-branch
pip3 install git-filter-repo
git filter-repo --invert-paths --path .env --path data/analytics.db
git push --force
```

Making the repo private helps but is **not** a substitute for step 2: the token
has already been public, and public repos get scraped automatically.

The same reasoning applies to `SUB_HASH_SECRET` below — with one twist. That
one cannot simply be rotated: changing it orphans every subscription already
stored, because `sub_key` is derived from it. Set it once, in Render, and leave
it alone.

---

## Cancellation, renewal and refund (Apple webhook)

Everything in the funnel above comes from the app. The app only knows what
happens inside itself, which leaves the entire post-purchase life invisible:

| What happens | Where | Did the app see it? |
|---|---|---|
| Cancelling a subscription | Settings → Apple ID → Subscriptions | ❌ never |
| A trial turning into money | Apple's servers | ❌ never |
| Renewal (month 2, year 2) | Apple's servers | ❌ never |
| Refund | Apple support | ❌ never |

**This cannot be fixed in the app.** Checking
`Product.SubscriptionInfo.status` at launch looks like it solves cancellation,
but it only catches the cancellations of people who *came back* — and whoever
cancels a trial usually does not. You would be measuring precisely the wrong
minority.

The complete source is **App Store Server Notifications V2**: Apple POSTs to
your server on every state change. It is what RevenueCat packages and resells.

### Turning it on

```bash
npm run certs:apple      # downloads Apple's PUBLIC root certificates
git add certs/apple      # commit them: the Render build should not depend on apple.com
```

Set `APPLE_BUNDLE_ID` in **Render → Environment**. It must match the app's
bundle id **exactly** — Apple is case-sensitive, and a mismatch rejects every
real notification with a 401.

> The bundle for this app is `com.alexandre.juniort10.magicworld` (the rebuild
> ships as an update to the existing app). `src/config.ts` used to hard-code
> `com.magicworld.audiobooks` for display; verification now reads the
> environment instead, so the two can never silently disagree.

Then, in **App Store Connect → Magic World → App Information → App Store
Server Notifications**:

- **Version**: `Version 2` (V1 is a different format and is not parsed here)
- **Production Server URL**: `https://YOUR-SERVICE.onrender.com/apple/notifications`

There is no test button on that screen — it only stores the URL. Firing a test
is an **App Store Server API** endpoint, and this project has a shortcut:

```bash
npm run apple:test
```

It asks for the `TEST` notification, waits for delivery and prints the result
**Apple recorded** — including when your own server answered wrong. That is how
you spot a 503 or a 401 without digging through Render's logs. Needs an
**In-App Purchase** key (App Store Connect → Users and Access → Integrations →
App Store Connect API → In-App Purchase tab); the variables are in
`.env.example`.

> ⚠️ The subscriptions live under the **original Magic World app registration,
> in a different Apple Developer account**. Both the notification URL and the
> In-App Purchase key have to come from *that* account, not from the one you
> use for the other apps.

> The `.p8` is a PRIVATE key and is gitignored. The `.cer` files under
> `certs/apple/` are the opposite: public certificates, meant to be committed.

> **Sandbox can stay empty.** With `APPLE_ENVIRONMENT=Production`, a sandbox
> notification landing here is **rejected with 401** during verification — the
> environment is part of what gets checked. That is protection, not a bug: it
> keeps test purchases out of the real numbers. To measure sandbox, run a
> second service.

While `APPLE_BUNDLE_ID` is unset the webhook answers **503 on purpose**: 503
makes Apple requeue (up to 5 attempts over ~3 days), so nothing is lost while
you finish the setup. A 200 would be the destructive answer — Apple would mark
it delivered and never send it again.

### The two distinctions most home-grown dashboards get wrong

**1. Cancelling ≠ expiring.** `DID_CHANGE_RENEWAL_STATUS/AUTO_RENEW_DISABLED`
is the tap on "cancel". The person **keeps access** until `expiresDate`. Access
ends at `EXPIRED`, days or eleven months later. Counting both as one inflates
churn and erases the win-back window — which is exactly the gap between them.
That is why the dashboard has an *"Ainda com acesso"* card: those are the
subscriptions where an offer still has somewhere to go.

**2. Cancelled trial ≠ cancelled payer.** Apple's notification is **identical**
in both cases. What separates them is the *state* of the subscription at that
moment — and state does not exist in an append-only stream. Hence the
`subscriptions` table. `sub_cancelled` is always the total;
`sub_trial_cancelled` is the subset, emitted alongside it and never in its
place, so "how many cancelled" stays a single sum.

The two call for opposite responses: a cancelled trial is a first-week value
problem, a cancelled payer is retention. And `DID_FAIL_TO_RENEW` (declined
card) is neither — it is involuntary churn, solved with a billing prompt, not a
discount.

### Events the webhook writes

| Event | Apple notification |
|---|---|
| `sub_started` / `sub_trial_started` | `SUBSCRIBED/INITIAL_BUY` (with or without a trial offer) |
| `sub_resubscribed` | `SUBSCRIBED/RESUBSCRIBE` |
| **`sub_cancelled`** + `sub_trial_cancelled` | `DID_CHANGE_RENEWAL_STATUS/AUTO_RENEW_DISABLED` |
| `sub_reactivated` | `.../AUTO_RENEW_ENABLED` — cancelled, then changed their mind |
| `sub_renewed` + `sub_trial_converted` | `DID_RENEW` |
| `sub_expired` + `sub_trial_expired` | `EXPIRED`, `GRACE_PERIOD_EXPIRED` |
| `sub_billing_issue` / `sub_billing_recovered` | `DID_FAIL_TO_RENEW` / `DID_RENEW/BILLING_RECOVERY` |
| `sub_refunded` / `sub_revoked` | `REFUND` / `REVOKE` |

An unknown type becomes `apple_<type>` rather than being dropped: Apple does
not resend after a 200, so a discarded notification is data lost for good.

### Why `sub_*` and not `subscribe`

The **same sale** produces a `subscribe` (the app saw it) and a `sub_started`
(Apple confirmed it). If both counted, all revenue would double. The prefix
separates origin, and `/admin/revenue` (app) and `/admin/subscriptions` (Apple)
stay distinct blocks on the dashboard:

- the **app** measures the funnel up to the purchase button — only it sees that;
- **Apple** measures what survived afterwards — only it sees that.

### Joining the two halves

The events table already has `user_id`. If the app passes an `appAccountToken`
at purchase time:

```swift
try await product.purchase(options: [.appAccountToken(myAnonymousUserUUID)])
```

Apple echoes that UUID back in every notification for that subscription, and
the webhook writes it into `user_id`. From then on the Apple rows JOIN cleanly
against the app's own funnel events — you can ask "which paywall variant did
the people who cancelled in trial see?", which neither half answers alone.
Nothing breaks without it; the column is simply null.

The webhook also converts Apple's three-letter `storefront` (`BRA`) into the
two-letter code the rest of the table uses (`BR`), so these rows line up with
the app's own country values — and render with the same flag in the dashboard's
Country column.

### Privacy

Apple's `originalTransactionId` is a permanent subscriber identifier. It is
**never stored**: it becomes `sub_key`, an HMAC-SHA256 keyed with
`SUB_HASH_SECRET`. That preserves the only question that matters — "is this the
same subscription as before?" — without keeping the original. To look up one
case, HMAC the id the customer gives you.

This changes nothing about what the app collects: the data travels from Apple
to your server, not from the device. The App Store privacy label is unaffected,
which matters here because Magic World is listed in the **Kids** category.

### Testing without Apple

```bash
npm run check:apple
```

Boots the server against a throwaway SQLite file, simulates the real sequence
(trial → cancellation → expiry, plus a second trial that converts) and checks
the numbers. It covers the failures that compile fine and still mean the wrong
thing: cancellation counted as expiry, a resend double-counting, and `price`
in milliunits (29900 = R$ 29.90, not R$ 29,900.00).

For the HTTP path without certificates, `APPLE_SKIP_VERIFICATION=true` accepts
payloads without checking the signer. **Never in production**: with no
verification, anyone who finds the URL writes "3,000 cancellations" into your
dashboard.

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
- `POST /apple/notifications` — Apple's webhook. Not open: every payload must
  carry a signature that verifies against Apple's root certificates. Outside
  the ingest rate limiter on purpose — Apple bursts retries, and a 429 from us
  would cause exactly the data loss this endpoint exists to prevent.

Admin (all require `Authorization: Bearer $ADMIN_TOKEN`):
- `GET /admin/funnel?since=24h|7d|30d|all`
- `GET /admin/revenue?since=…`
- `GET /admin/counts?since=…` — events grouped by name
- `GET /admin/subscriptions?since=…` — Apple lifecycle: cancellation, renewal, refund
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
| `APPLE_BUNDLE_ID` | ✅ (for the webhook) | Exact, case-sensitive. Unset → webhook disabled (503) |
| `APPLE_APP_ID`   | ⛔               | App Store Connect → App Information              |
| `APPLE_ENVIRONMENT` | ⛔            | `Production` or `Sandbox` — never both on one service |
| `SUB_HASH_SECRET` | ✅ (for the webhook) | HMAC for `sub_key`. Set once; changing it orphans subscriptions |
| `APPLE_SKIP_VERIFICATION` | ⛔      | ⚠️ Accepts unverified payloads. Local testing only |

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
