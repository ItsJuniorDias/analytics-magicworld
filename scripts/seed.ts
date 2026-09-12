/**
 * Seed the DB with ~14 days of realistic-looking events.
 *
 * Not a substitute for real data — just makes the dashboard look alive on
 * first boot. Safe to re-run; it does NOT clear existing rows.
 *
 * Usage: `npm run seed`
 */

import { config } from "../src/config";
import { makeDb } from "../src/db";
import { normalize } from "../src/lib/normalize";

const DAYS = 14;
const rnd = (min: number, max: number): number =>
  Math.floor(min + Math.random() * (max - min + 1));

const PLATFORMS = ["ios", "android"];
const COUNTRIES = ["BR", "US", "GB", "PT", "FR", "DE", "ES", "MX"];
const LOCALES = ["pt-BR", "en-US", "en-GB", "es-ES", "fr-FR", "de-DE"];
const PRODUCTS = [
  "mw_monthly_2990",
  "mw_annual_19900",
];

// Magic World subscription price (R$29,90/month, R$199/year).
const priceFor = (sku: string): number =>
  sku === "mw_annual_19900" ? 199.0 : 29.9;

function makeUserId(): string {
  return "u_" + Math.random().toString(36).slice(2, 12);
}

async function main(): Promise<void> {
  const db = await makeDb();
  const now = Date.now();
  const dayMs = 86_400_000;

  let inserted = 0;
  for (let d = 0; d < DAYS; d++) {
    // A day gets a slightly random number of paywall views. Trend up so
    // the graph doesn't look totally flat.
    const dayFactor = 1 + d * 0.03;
    const viewCount = Math.round(rnd(80, 140) * dayFactor);
    const users: string[] = [];
    for (let i = 0; i < viewCount; i++) users.push(makeUserId());

    // Timestamps within the day.
    const baseTs = now - (DAYS - d) * dayMs;
    const jitter = () => baseTs + rnd(0, dayMs - 1);

    // 1) All users see the paywall
    for (const u of users) {
      const row = normalize({
        event: "paywall_view",
        ts: jitter(),
        params: {
          user_id: u,
          session_id: "s_" + u.slice(2),
          platform: PLATFORMS[rnd(0, PLATFORMS.length - 1)],
          app_version: "1.4.0",
          country: COUNTRIES[rnd(0, COUNTRIES.length - 1)],
          locale: LOCALES[rnd(0, LOCALES.length - 1)],
          source: "onboarding",
        },
      });
      if (row) {
        await db.insertEvent(row);
        inserted++;
      }
    }

    // 2) ~18% initiate checkout
    const checkoutUsers = users.filter(() => Math.random() < 0.18);
    for (const u of checkoutUsers) {
      const sku = PRODUCTS[rnd(0, PRODUCTS.length - 1)];
      const row = normalize({
        event: "checkout_initiated",
        ts: jitter(),
        params: {
          user_id: u,
          product_id: sku,
          platform: PLATFORMS[rnd(0, PLATFORMS.length - 1)],
          country: COUNTRIES[rnd(0, COUNTRIES.length - 1)],
          currency: "BRL",
          value: priceFor(sku),
        },
      });
      if (row) {
        await db.insertEvent(row);
        inserted++;
      }
    }

    // 3) ~55% of checkouts start a trial
    const trialUsers = checkoutUsers.filter(() => Math.random() < 0.55);
    for (const u of trialUsers) {
      const sku = PRODUCTS[rnd(0, PRODUCTS.length - 1)];
      const row = normalize({
        event: "start_trial",
        ts: jitter(),
        params: {
          user_id: u,
          product_id: sku,
          currency: "BRL",
          value: priceFor(sku),
          country: COUNTRIES[rnd(0, COUNTRIES.length - 1)],
        },
      });
      if (row) {
        await db.insertEvent(row);
        inserted++;
      }
    }

    // 4) ~35% of trials convert to paid (day 8 of the seed data onward)
    if (d >= 7) {
      const subscribers = trialUsers.filter(() => Math.random() < 0.35);
      for (const u of subscribers) {
        const sku = PRODUCTS[rnd(0, PRODUCTS.length - 1)];
        const row = normalize({
          event: "subscribe",
          ts: jitter(),
          params: {
            user_id: u,
            product_id: sku,
            currency: "BRL",
            value: priceFor(sku),
            country: COUNTRIES[rnd(0, COUNTRIES.length - 1)],
          },
        });
        if (row) {
          await db.insertEvent(row);
          inserted++;
        }
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `Seed complete: ${inserted} events over ${DAYS} days (driver=${
      config.databaseUrl ? "postgres" : "sqlite"
    })`,
  );
  await db.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("seed_failed", err);
  process.exit(1);
});
