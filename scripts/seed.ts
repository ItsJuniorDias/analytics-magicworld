/**
 * Seed the DB with ~14 days of fake events.
 *
 * So pra ver a forma do dashboard antes de existir trafego real. NUNCA rode
 * isto contra producao: os eventos entram na mesma tabela dos reais, sem
 * marcador, e depois nao ha como separar.
 *
 * Uso: `npm run seed` (ou `npm run seed:bun`)
 */

import { config, storageDriver } from "../src/config";
import { makeDb } from "../src/db";
import { normalize } from "../src/lib/normalize";

const DAYS = 14;
const rnd = (min: number, max: number): number =>
  Math.floor(min + Math.random() * (max - min + 1));
const pickOne = <T,>(xs: readonly T[]): T => xs[rnd(0, xs.length - 1)];

const COUNTRIES = ["BR", "US", "GB", "PT", "ES", "MX"] as const;
const LOCALES = ["pt-BR", "en-US", "en-GB", "es-MX"] as const;

// De onde o paywall foi aberto. Tem de bater com Analytics.Source no app.
const SOURCES = ["intro", "story_gate", "home", "profile"] as const;

// Os produtos de verdade, de `Magic World.storekit`.
//
// O anual tem uma semana gratis e o mensal nao. Isso e o que decide se a
// compra vira `start_trial` ou `subscribe`, entao o seed precisa respeitar,
// senao o dashboard mostra uma divisao que o app nunca produz.
const MONTHLY = "com.alexandre.juniort10.magicworld.monthly";
const ANNUAL = "pro_annual";
const priceFor = (sku: string): number => (sku === ANNUAL ? 39.99 : 4.99);

function makeUserId(): string {
  return "u_" + Math.random().toString(36).slice(2, 12);
}

async function main(): Promise<void> {
  if (config.env === "production") {
    // eslint-disable-next-line no-console
    console.error(
      "seed recusado: NODE_ENV=production. Isto e dado falso e nao sai " +
        "mais da tabela depois de entrar.",
    );
    process.exit(1);
  }

  const db = await makeDb();
  const now = Date.now();
  const dayMs = 86_400_000;

  let inserted = 0;
  const push = async (
    event: string,
    ts: number,
    params: Record<string, unknown>,
  ) => {
    const row = normalize({ event, ts, params });
    if (row) {
      await db.insertEvent(row);
      inserted++;
    }
  };

  for (let d = 0; d < DAYS; d++) {
    const dayFactor = 1 + d * 0.03;
    const viewCount = Math.round(rnd(80, 140) * dayFactor);
    const baseTs = now - (DAYS - d) * dayMs;
    const jitter = () => baseTs + rnd(0, dayMs - 1);

    // Cada pessoa tem um pais e uma origem fixos no dia. Antes o seed
    // sorteava pais por EVENTO, o que fazia a mesma pessoa aparecer no Brasil
    // no paywall e no Mexico no checkout — e ai o corte por pais nao fechava
    // com o funil geral.
    const people = Array.from({ length: viewCount }, () => ({
      id: makeUserId(),
      country: pickOne(COUNTRIES),
      locale: pickOne(LOCALES),
      // O paywall de intro abre sozinho pra todo mundo, entao domina o volume.
      source: Math.random() < 0.55 ? "intro" : pickOne(SOURCES),
    }));

    const base = (u: (typeof people)[number]) => ({
      user_id: u.id,
      session_id: "s_" + u.id.slice(2),
      platform: "ios",
      app_version: "1.4.0",
      country: u.country,
      locale: u.locale,
    });

    for (const u of people) {
      await push("app_open", jitter(), base(u));
      await push("paywall_view", jitter(), { ...base(u), source: u.source });
    }

    // Quem chegou pelo gate de uma historia converte muito melhor que quem
    // levou o paywall na cara depois do onboarding. E o motivo do corte
    // por origem existir.
    for (const u of people) {
      const p = u.source === "story_gate" ? 0.3 : 0.12;
      if (Math.random() > p) continue;

      const sku = Math.random() < 0.65 ? ANNUAL : MONTHLY;
      const money = {
        product_id: sku,
        currency: u.country === "BR" ? "BRL" : "USD",
        value: priceFor(sku),
      };
      await push("checkout_initiated", jitter(), { ...base(u), ...money });

      // ~72% concluem depois de abrir a folha de pagamento.
      if (Math.random() > 0.72) continue;

      // Anual tem periodo gratis, mensal nao. Ramos irmaos, nao sequencia.
      await push(sku === ANNUAL ? "start_trial" : "subscribe", jitter(), {
        ...base(u),
        ...money,
        // Trial nao e receita ainda: entra com valor zero pra nao inflar o
        // faturamento com dinheiro que pode nunca chegar.
        value: sku === ANNUAL ? 0 : money.value,
      });
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `Seed complete: ${inserted} events over ${DAYS} days (driver=${storageDriver})`,
  );
  await db.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("seed_failed", err);
  process.exit(1);
});
