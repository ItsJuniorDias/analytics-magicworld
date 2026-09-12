#!/usr/bin/env node
/**
 * End-to-end test of the Apple webhook, without Apple.
 *
 * Boots the server against a throwaway SQLite file with
 * APPLE_SKIP_VERIFICATION=true, posts the notifications that matter and checks
 * the numbers coming out of /admin/subscriptions. Run it next to
 * `npm run typecheck` — the webhook is the kind of code that compiles fine and
 * still gets the meaning wrong (cancellation counted as expiry, a resend
 * double-counting, price off by a factor of a thousand).
 *
 *   node scripts/check-apple-webhook.mjs
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 3198;
const TOKEN = "local-test";
const dir = mkdtempSync(join(tmpdir(), "magicworld-apple-"));

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jws = (payload) => `${b64({ alg: "none" })}.${b64(payload)}.x`;

let seq = 0;
const notification = (type, subtype, tx = {}, renewal = {}, uuid = null) => ({
  signedPayload: jws({
    notificationType: type,
    subtype,
    notificationUUID: uuid ?? `uuid-${++seq}`,
    signedDate: Date.now(),
    data: {
      environment: "Production",
      bundleId: "com.test.magicworld",
      signedTransactionInfo: jws({
        originalTransactionId: "2000000777",
        transactionId: `tx-${seq}`,
        productId: "members_annual",
        originalPurchaseDate: Date.now(),
        expiresDate: Date.now() + 7 * 86400_000,
        storefront: "BRA",
        currency: "BRL",
        price: 29900, // milliunits -> R$ 29.90
        appAccountToken: "user-abc",
        ...tx,
      }),
      signedRenewalInfo: jws({
        originalTransactionId: "2000000777",
        autoRenewProductId: "members_annual",
        autoRenewStatus: 1,
        ...renewal,
      }),
    },
  }),
});

const trial = { offerType: 1, offerDiscountType: "FREE_TRIAL", price: 0 };

const server = spawn("npx", ["tsx", "src/server.ts"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    NODE_ENV: "development",
    ADMIN_TOKEN: TOKEN,
    SQLITE_PATH: join(dir, "test.db"),
    DATABASE_URL: "",
    APPLE_BUNDLE_ID: "com.test.magicworld",
    APPLE_SKIP_VERIFICATION: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

const logs = [];
server.stdout.on("data", (d) => logs.push(String(d)));
server.stderr.on("data", (d) => logs.push(String(d)));

const cleanup = () => {
  server.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
};

const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  console.error("\n--- server log ---\n" + logs.join(""));
  cleanup();
  process.exit(1);
};

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return;
    } catch {
      /* still booting */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  fail("server did not come up within 15s");
}

const send = (body) =>
  fetch(`http://127.0.0.1:${PORT}/apple/notifications`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const stats = async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/admin/subscriptions?since=all`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!r.ok) fail(`/admin/subscriptions returned HTTP ${r.status}`);
  return (await r.json()).subscriptions;
};

const check = (name, actual, expected) => {
  if (actual !== expected) fail(`${name}: expected ${expected}, got ${actual}`);
  console.log(`  ✓ ${name} = ${actual}`);
};

await waitForServer();
console.log("server up\n");

// ── 1. a trial began ───────────────────────────────────────────────────────
await send(notification("SUBSCRIBED", "INITIAL_BUY", trial));
let s = await stats();
console.log("trial started:");
check("sub_trial_started", s.period.sub_trial_started, 1);
check("trialing now", s.now.trialing, 1);

// ── 2. cancelled DURING the trial ──────────────────────────────────────────
await send(
  notification("DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_DISABLED", trial, {
    autoRenewStatus: 0,
  }),
);
s = await stats();
console.log("\ncancelled during trial:");
check("sub_cancelled (total)", s.period.sub_cancelled, 1);
check("sub_trial_cancelled (subset)", s.period.sub_trial_cancelled, 1);
// The check that matters most: cancelling is NOT expiring. They still have
// access, and this is exactly where win-back still works.
check("sub_expired still zero", s.period.sub_expired, 0);
check("cancelled but still has access", s.now.cancelPending, 1);
check("trial cancel rate", s.rates.trial_cancel, 1);

// ── 3. Apple resends the SAME notification ─────────────────────────────────
await send(
  notification("DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_DISABLED", trial, {}, "uuid-2"),
);
s = await stats();
console.log("\nresent notification:");
check("sub_cancelled still 1", s.period.sub_cancelled, 1);

// ── 4. the trial expired without paying ────────────────────────────────────
await send(notification("EXPIRED", "VOLUNTARY", trial, { expirationIntent: 1 }));
s = await stats();
console.log("\ntrial expired:");
check("sub_expired", s.period.sub_expired, 1);
check("sub_trial_expired", s.period.sub_trial_expired, 1);
check("trial conversion", s.rates.trial_conversion, 0);

// ── 5. a second subscription: trial that turned into money ─────────────────
const other = { originalTransactionId: "2000000222", appAccountToken: "user-xyz" };
await send(notification("SUBSCRIBED", "INITIAL_BUY", { ...trial, ...other }, other));
await send(notification("DID_RENEW", null, other, other));
s = await stats();
console.log("\ntrial converted:");
check("sub_trial_converted", s.period.sub_trial_converted, 1);
check("sub_renewed", s.period.sub_renewed, 1);
// 1 converted out of 2 resolved trials (one expired, one converted).
check("trial conversion", s.rates.trial_conversion, 0.5);
check("active subscription", s.now.active, 1);

const brl = s.revenue.find((r) => r.currency === "BRL");
if (!brl) fail("BRL revenue row missing");
// price 29900 milliunits = R$ 29.90 — not R$ 29,900.00.
check("gross revenue (BRL)", brl.gross, 29.9);

// ── 6. the appAccountToken joins webhook rows to the app's funnel ──────────
const events = await fetch(
  `http://127.0.0.1:${PORT}/admin/events?event=sub_trial_converted&since=all`,
  { headers: { Authorization: `Bearer ${TOKEN}` } },
).then((r) => r.json());
console.log("\njoin with the app's own events:");
check("user_id carried over", events.events[0]?.user_id, "user-xyz");
check("country from storefront", events.events[0]?.country, "BR");

console.log("\n✓ Apple webhook OK");
cleanup();
process.exit(0);
