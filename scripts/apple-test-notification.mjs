#!/usr/bin/env node
// Pede pra Apple mandar uma notificação de TESTE no seu webhook.
//
// ⚠️ Não existe botão "Send Test Notification" no App Store Connect. A tela de
// App Store Server Notifications só guarda a URL. O disparo é um endpoint da
// **App Store Server API** (`POST /inApps/v1/notifications/test`), autenticado
// com JWT ES256 — que é o que este script monta, via a lib oficial da Apple.
//
// A notificação vai pra URL do MESMO ambiente que você chamar: chamar a API de
// produção manda pro seu Production Server URL.
//
//   node scripts/apple-test-notification.mjs
//
// Precisa de uma chave da App Store Connect API do tipo **In-App Purchase**:
//   App Store Connect → Users and Access → Integrations → App Store Connect API
//   → aba In-App Purchase → (+) → baixe o .p8 (só dá pra baixar UMA vez).
//
// Depois coloque no .env:
//   APPLE_KEY_ID=ABC123DEFG
//   APPLE_ISSUER_ID=57246542-96fe-1a63-e053-0824d011072a
//   APPLE_PRIVATE_KEY_PATH=./certs/apple/SubscriptionKey_ABC123DEFG.p8
//   APPLE_BUNDLE_ID=com.seudominio.pedagogy
//   APPLE_ENVIRONMENT=Production

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// O projeto lê env direto do process.env (sem dotenv). Aqui um parser mínimo
// pra você não ter que exportar cinco variáveis na mão toda vez.
function carregarEnv(arquivo = ".env") {
  try {
    for (const linha of readFileSync(resolve(arquivo), "utf8").split("\n")) {
      const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* sem .env — usa o que já estiver no ambiente */
  }
}
carregarEnv();

const {
  APPLE_KEY_ID: keyId,
  APPLE_ISSUER_ID: issuerId,
  APPLE_BUNDLE_ID: bundleId,
  APPLE_PRIVATE_KEY_PATH: keyPath,
  APPLE_ENVIRONMENT: env = "Production",
} = process.env;

const faltando = Object.entries({
  APPLE_KEY_ID: keyId,
  APPLE_ISSUER_ID: issuerId,
  APPLE_BUNDLE_ID: bundleId,
  APPLE_PRIVATE_KEY_PATH: keyPath,
})
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (faltando.length) {
  console.error(`Faltando no .env: ${faltando.join(", ")}`);
  console.error("Veja o comentário no topo deste arquivo.");
  process.exit(1);
}

let signingKey;
try {
  signingKey = readFileSync(resolve(keyPath), "utf8");
} catch {
  console.error(`Não consegui ler a chave em ${keyPath}`);
  process.exit(1);
}

const { AppStoreServerAPIClient, Environment } = await import(
  "@apple/app-store-server-library"
);

const client = new AppStoreServerAPIClient(
  signingKey,
  keyId,
  issuerId,
  bundleId,
  env === "Sandbox" ? Environment.SANDBOX : Environment.PRODUCTION,
);

console.log(`Pedindo notificação de teste (${env}, bundle=${bundleId})…`);

let token;
try {
  ({ testNotificationToken: token } = await client.requestTestNotification());
} catch (err) {
  console.error("\n✗ A Apple recusou o pedido.");
  // O erro 4040007 é o mais comum e a mensagem dele não ajuda: quase sempre é
  // o bundle id com a caixa errada, ou a URL configurada em OUTRO ambiente.
  if (String(err?.apiError) === "4040007" || /4040007/.test(String(err))) {
    console.error(
      "  4040007 = nenhuma URL configurada para ESTE ambiente.\n" +
        `  • confira se o Bundle ID está idêntico (é case-sensitive): ${bundleId}\n` +
        `  • confira se a URL de ${env} está preenchida no App Store Connect`,
    );
  } else {
    console.error(" ", err?.errorMessage ?? err?.message ?? err);
  }
  process.exit(1);
}

console.log(`token: ${token}\naguardando a entrega…\n`);

// A Apple leva alguns segundos e registra o resultado — inclusive o código HTTP
// que o SEU servidor devolveu. É o jeito de descobrir que o webhook respondeu
// 503 (não configurado) ou 401 (payload não verificado) sem ter acesso ao log.
for (let i = 1; i <= 10; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  try {
    const status = await client.getTestNotificationStatus(token);
    const tentativas = status.sendAttempts ?? [];
    if (tentativas.length === 0) {
      process.stdout.write(".");
      continue;
    }
    console.log("\nresultado das tentativas:");
    for (const t of tentativas) {
      const quando = new Date(t.attemptDate).toLocaleString("pt-BR");
      console.log(`  ${quando} → ${t.sendAttemptResult}`);
    }
    const ok = tentativas.some((t) => t.sendAttemptResult === "SUCCESS");
    console.log(
      ok
        ? "\n✓ Webhook recebeu e respondeu 200. Deve aparecer no dashboard agora."
        : "\n✗ A entrega falhou. O resultado acima diz o porquê " +
            "(OTHER costuma ser código de erro do seu servidor).",
    );
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error("\nErro ao consultar status:", err?.errorMessage ?? err);
    process.exit(1);
  }
}

console.log("\nA Apple ainda não registrou a tentativa. Rode de novo daqui a pouco:");
console.log(`  node -e "…getTestNotificationStatus('${token}')"`);
