#!/usr/bin/env node
/**
 * Asks Apple to send a TEST notification to your configured URL, then polls
 * for the delivery result.
 *
 * This is the only way to confirm the webhook end to end. The App Store
 * Connect screen where you paste the URL has no test button — it just stores
 * the string. This endpoint lives in the App Store Server API instead, and
 * reports the status APPLE recorded, including when your own server answered
 * wrong. That is how you spot a 503 or a 401 without digging through Render's
 * logs.
 *
 * Needs an In-App Purchase key: App Store Connect -> Users and Access ->
 * Integrations -> App Store Connect API -> In-App Purchase tab.
 * Variables in .env.example: APPLE_KEY_ID, APPLE_ISSUER_ID,
 * APPLE_PRIVATE_KEY_PATH, APPLE_BUNDLE_ID, APPLE_ENVIRONMENT.
 */

import crypto from "node:crypto";
import { readFileSync } from "node:fs";

const {
  APPLE_KEY_ID,
  APPLE_ISSUER_ID,
  APPLE_PRIVATE_KEY_PATH,
  APPLE_BUNDLE_ID,
  APPLE_ENVIRONMENT = "Production",
} = process.env;

const missing = Object.entries({
  APPLE_KEY_ID,
  APPLE_ISSUER_ID,
  APPLE_PRIVATE_KEY_PATH,
  APPLE_BUNDLE_ID,
})
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length) {
  console.error("Missing environment variables: " + missing.join(", "));
  console.error("See .env.example — the In-App Purchase key is a different key from the one used for app metadata.");
  process.exit(1);
}

const HOST =
  APPLE_ENVIRONMENT === "Sandbox"
    ? "https://api.storekit-sandbox.itunes.apple.com"
    : "https://api.storekit.itunes.apple.com";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

function token() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: APPLE_KEY_ID, typ: "JWT" };
  const payload = {
    iss: APPLE_ISSUER_ID,
    iat: now,
    exp: now + 600,
    aud: "appstoreconnect-v1",
    bid: APPLE_BUNDLE_ID,
  };
  const body = `${b64(header)}.${b64(payload)}`;
  const key = readFileSync(APPLE_PRIVATE_KEY_PATH, "utf8");
  const sig = crypto
    .sign("sha256", Buffer.from(body), { key, dsaEncoding: "ieee-p1363" })
    .toString("base64url");
  return `${body}.${sig}`;
}

const jwt = token();
const auth = { Authorization: `Bearer ${jwt}` };

console.log(`environment: ${APPLE_ENVIRONMENT}`);
console.log(`bundle id:   ${APPLE_BUNDLE_ID}\n`);

const req = await fetch(`${HOST}/inApps/v1/notifications/test`, {
  method: "POST",
  headers: auth,
});
if (!req.ok) {
  console.error(`Apple refused the request: HTTP ${req.status}`);
  console.error(await req.text());
  process.exit(1);
}
const { testNotificationToken } = await req.json();
console.log(`Apple accepted. Token: ${testNotificationToken}\nWaiting for delivery…\n`);

for (let i = 1; i <= 12; i++) {
  await new Promise((r) => setTimeout(r, 2500));
  const res = await fetch(
    `${HOST}/inApps/v1/notifications/test/${encodeURIComponent(testNotificationToken)}`,
    { headers: auth },
  );
  if (res.status === 404) {
    process.stdout.write(`  attempt ${i}: not delivered yet\n`);
    continue;
  }
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const body = await res.json();
  const history = body.sendAttempts ?? [];
  console.log("Delivery attempts recorded by Apple:");
  for (const a of history) {
    console.log(`  ${new Date(a.attemptDate).toISOString()} — ${a.sendAttemptResult}`);
  }
  const ok = history.some((a) => a.sendAttemptResult === "SUCCESS");
  if (ok) {
    console.log("\n✓ Apple reached your server. Check the dashboard for `apple_test_notification`.");
    process.exit(0);
  }
  if (history.length) {
    console.error(
      "\n✗ Apple could not deliver. Common causes:\n" +
        "  OTHER / 503        — APPLE_BUNDLE_ID unset on Render (webhook disabled on purpose)\n" +
        "  UNAUTHORIZED / 401 — bundle id or environment mismatch in verification\n" +
        "  NO_RESPONSE        — wrong URL, or the Render free instance is asleep",
    );
    process.exit(1);
  }
}
console.error("Timed out waiting for Apple. Re-run to poll again — the token stays valid for a while.");
process.exit(1);
