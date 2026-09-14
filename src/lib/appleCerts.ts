/**
 * Apple root certificates.
 *
 * Apple signs every notification as a JWS and puts the certificate chain in
 * the `x5c` header. Verifying the signature without anchoring that chain to
 * Apple's root proves nothing — anyone can mint a well-formed JWS and POST it
 * at your endpoint. With no root, the webhook is an open form where a
 * competitor (or a bot) writes "3,000 cancellations" into your dashboard.
 *
 * The .cer files are public Apple binaries, fetched by `npm run certs:apple`
 * and meant to be committed. With the folder empty the server still boots,
 * logs loudly, and the webhook answers 503 — never 200 for unverified data.
 *
 * Alternative for people who would rather not commit files:
 * APPLE_ROOT_CERTS_B64 with base64 certificates, comma separated (fits in a
 * Render env var).
 */

import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { config } from "../config";

/** PEM (-----BEGIN CERTIFICATE-----) -> the DER buffer the library expects. */
function pemToDer(pem: string): Buffer {
  const b64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  return Buffer.from(b64, "base64");
}

/** Apple's .cer is binary DER, but some mirrors serve PEM. Accept both. */
function normalize(buf: Buffer): Buffer {
  const head = buf.subarray(0, 32).toString("ascii");
  return head.includes("BEGIN CERTIFICATE")
    ? pemToDer(buf.toString("ascii"))
    : buf;
}

function fromEnv(): Buffer[] {
  if (!config.appleRootCertsB64) return [];
  return config.appleRootCertsB64
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => normalize(Buffer.from(s, "base64")));
}

function fromDir(): Buffer[] {
  const dir = isAbsolute(config.appleRootCertsDir)
    ? config.appleRootCertsDir
    : join(process.cwd(), config.appleRootCertsDir);

  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => /\.(cer|pem|crt|der)$/i.test(n));
  } catch {
    return []; // missing folder behaves like an empty one
  }
  return names.map((n) => normalize(readFileSync(join(dir, n))));
}

let cache: Buffer[] | null = null;

/**
 * DER roots for `SignedDataVerifier`. The env var wins over the folder.
 * An empty list means "webhook disabled" — the caller decides what to do.
 */
export function loadAppleRootCertificates(): Buffer[] {
  if (cache) return cache;
  const certs = fromEnv();
  cache = certs.length > 0 ? certs : fromDir();
  return cache;
}

/** Test helper — forces a re-read from disk on the next call. */
export function resetAppleRootCertificatesCache(): void {
  cache = null;
}
