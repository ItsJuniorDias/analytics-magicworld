#!/usr/bin/env node
// Baixa os certificados raiz PÚBLICOS da Apple pra certs/apple/.
//
// Eles são o que prova que uma notificação veio mesmo da Apple: o JWS traz a
// cadeia de certificados no header `x5c`, e sem a raiz pra ancorar essa cadeia
// a verificação não prova nada — qualquer um consegue assinar um JWS.
//
// São arquivos públicos e estáveis (validade até 2035+). Pode commitar no
// repo: não é segredo, e evita que um deploy dependa do site da Apple estar de
// pé. No Render, commitar é a opção mais segura — o build não tem rede pra
// tudo, e o alternativo é a env var APPLE_ROOT_CERTS_B64.
//
//   npm run certs:apple

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEST = join(process.cwd(), "certs", "apple");

// As duas raízes que assinam a cadeia das App Store Server Notifications.
// A G3 é a que está em uso; a antiga fica junto porque cadeia emitida antes
// da migração ainda ancora nela, e sobra não custa nada.
const CERTS = [
  {
    name: "AppleRootCA-G3.cer",
    url: "https://www.apple.com/certificateauthority/AppleRootCA-G3.cer",
    required: true,
  },
  {
    name: "AppleRootCA-G2.cer",
    url: "https://www.apple.com/certificateauthority/AppleRootCA-G2.cer",
    required: false,
  },
  {
    name: "AppleIncRootCertificate.cer",
    url: "https://www.apple.com/appleca/AppleIncRootCertificate.cer",
    required: false,
  },
];

async function baixar({ name, url, required }) {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());

    // Sanidade mínima: DER de certificado começa com SEQUENCE (0x30).
    // Sem isto, uma página de erro em HTML viraria um "certificado" de 4 KB
    // e o erro só apareceria meses depois, na primeira notificação real.
    const ok = buf[0] === 0x30 || buf.subarray(0, 32).includes("BEGIN CERT");
    if (!ok) throw new Error("conteúdo não parece um certificado");

    await writeFile(join(DEST, name), buf);
    console.log(`  ✓ ${name} (${buf.length} bytes)`);
    return true;
  } catch (err) {
    const nivel = required ? "✗" : "·";
    console.log(`  ${nivel} ${name} — ${err.message}`);
    return false;
  }
}

await mkdir(DEST, { recursive: true });
console.log(`Baixando certificados raiz da Apple para ${DEST}`);

const resultados = await Promise.all(CERTS.map(baixar));
const obrigatorios = CERTS.filter((c) => c.required);
const faltando = obrigatorios.filter((c, i) => !resultados[CERTS.indexOf(c)]);

if (faltando.length > 0) {
  console.error(
    "\nFalta certificado obrigatório. Baixe à mão em " +
      "https://www.apple.com/certificateauthority/ e salve em certs/apple/.",
  );
  process.exit(1);
}

console.log("\nPronto. O webhook /apple/notifications já pode verificar assinaturas.");
