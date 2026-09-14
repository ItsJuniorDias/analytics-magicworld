#!/usr/bin/env node
/**
 * Downloads Apple's PUBLIC root certificates into certs/apple/.
 *
 * These anchor the JWS chain that App Store Server Notifications arrive with.
 * Without them the webhook cannot prove a payload came from Apple, and it
 * refuses to run at all (503) rather than trusting unverified data.
 *
 * They are public binaries and SHOULD be committed — the Render build should
 * not depend on apple.com being reachable at deploy time.
 *
 *   npm run certs:apple && git add certs/apple
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "certs", "apple");

const CERTS = [
  ["AppleIncRootCertificate.cer", "https://www.apple.com/appleca/AppleIncRootCertificate.cer"],
  ["AppleRootCA-G2.cer", "https://www.apple.com/certificateauthority/AppleRootCA-G2.cer"],
  ["AppleRootCA-G3.cer", "https://www.apple.com/certificateauthority/AppleRootCA-G3.cer"],
];

mkdirSync(DIR, { recursive: true });

let failed = 0;
for (const [name, url] of CERTS) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) throw new Error(`suspiciously small (${buf.length} bytes)`);
    writeFileSync(join(DIR, name), buf);
    console.log(`  ✓ ${name} (${buf.length} bytes)`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

if (failed) {
  console.error(`\n${failed} certificate(s) failed. The webhook stays disabled until all are present.`);
  process.exit(1);
}
console.log("\nDone. Commit them: git add certs/apple");
