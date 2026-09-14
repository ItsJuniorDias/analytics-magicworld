/**
 * Thin wrapper over `@apple/app-store-server-library` (the official one, pure
 * JS — no node-gyp, which keeps the Render build green). It exists to:
 *
 *   • load lazily, so anyone running without the webhook pays nothing;
 *   • say WHY it is off, instead of throwing something generic;
 *   • offer an explicitly dangerous "decode without verifying" mode that
 *     unblocks local testing before the .cer files are in place.
 *
 * The verifier checks the chain up to Apple's root AND that bundleId and
 * environment match yours. Without that, the endpoint accepts any JSON signed
 * by anyone.
 */

import { config } from "../config";
import { loadAppleRootCertificates } from "./appleCerts";

/** Minimal shape of what we consume from the decoded payload. */
export type DecodedNotification = {
  notificationType?: string;
  subtype?: string;
  notificationUUID?: string;
  signedDate?: number;
  data?: {
    environment?: string;
    bundleId?: string;
    signedTransactionInfo?: string;
    signedRenewalInfo?: string;
    status?: number;
  };
};

export type DecodedTransaction = {
  originalTransactionId?: string;
  transactionId?: string;
  productId?: string;
  purchaseDate?: number;
  originalPurchaseDate?: number;
  expiresDate?: number;
  type?: string;
  /** The UUID your app passes as `appAccountToken` at purchase time. */
  appAccountToken?: string;
  offerType?: number;
  offerDiscountType?: string;
  environment?: string;
  storefront?: string;
  currency?: string;
  price?: number;
  revocationDate?: number;
  revocationReason?: number;
  transactionReason?: string;
};

export type DecodedRenewalInfo = {
  originalTransactionId?: string;
  autoRenewStatus?: number;
  autoRenewProductId?: string;
  expirationIntent?: number;
  isInBillingRetryPeriod?: boolean;
  gracePeriodExpiresDate?: number;
  renewalDate?: number;
  currency?: string;
  renewalPrice?: number;
  offerDiscountType?: string;
  appAccountToken?: string;
  recentSubscriptionStartDate?: number;
};

export type AppleVerifier = {
  enabled: boolean;
  /** Why it is off — goes to the boot log and to the 503 body. */
  reason: string | null;
  verifying: boolean;
  verifyNotification(signedPayload: string): Promise<DecodedNotification>;
  verifyTransaction(jws: string): Promise<DecodedTransaction>;
  verifyRenewalInfo(jws: string): Promise<DecodedRenewalInfo>;
};

/** Decodes a JWS body WITHOUT checking the signature. Unsafe mode only. */
function decodeUnsafe<T>(jws: string): T {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new Error("malformed JWS");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as T;
}

function disabled(reason: string): AppleVerifier {
  const fail = async (): Promise<never> => {
    throw new Error(reason);
  };
  return {
    enabled: false,
    reason,
    verifying: false,
    verifyNotification: fail,
    verifyTransaction: fail,
    verifyRenewalInfo: fail,
  };
}

let cached: AppleVerifier | null = null;

export async function getAppleVerifier(): Promise<AppleVerifier> {
  if (!cached) cached = await build();
  return cached;
}

async function build(): Promise<AppleVerifier> {
  if (!config.appleBundleId) {
    return disabled(
      "APPLE_BUNDLE_ID is not set — without it there is no way to validate " +
        "which app a notification came from.",
    );
  }

  // Explicit unsafe mode: decode and move on, proving nothing.
  if (config.appleSkipVerification) {
    return {
      enabled: true,
      reason: null,
      verifying: false,
      async verifyNotification(p) {
        return decodeUnsafe<DecodedNotification>(p);
      },
      async verifyTransaction(p) {
        return decodeUnsafe<DecodedTransaction>(p);
      },
      async verifyRenewalInfo(p) {
        return decodeUnsafe<DecodedRenewalInfo>(p);
      },
    };
  }

  const roots = loadAppleRootCertificates();
  if (roots.length === 0) {
    return disabled(
      `No Apple root certificates in "${config.appleRootCertsDir}". ` +
        "Run `npm run certs:apple` (or set APPLE_ROOT_CERTS_B64).",
    );
  }

  type VerifierCtor = new (
    roots: Buffer[],
    onlineChecks: boolean,
    environment: string,
    bundleId: string,
    appAppleId?: number,
  ) => {
    verifyAndDecodeNotification(p: string): Promise<unknown>;
    verifyAndDecodeTransaction(p: string): Promise<unknown>;
    verifyAndDecodeRenewalInfo(p: string): Promise<unknown>;
  };

  let SignedDataVerifier: VerifierCtor;
  try {
    // Dynamic import, matching the pattern used by db/index.ts: the library is
    // only loaded when the webhook will actually use it.
    ({ SignedDataVerifier } = (await import(
      "@apple/app-store-server-library"
    )) as unknown as { SignedDataVerifier: VerifierCtor });
  } catch {
    return disabled(
      "@apple/app-store-server-library is missing — run `npm install`.",
    );
  }

  // Apple omits appAppleId in sandbox; passing undefined there is correct
  // behaviour, not an oversight.
  const verifier = new SignedDataVerifier(
    roots,
    config.appleOnlineChecks,
    config.appleEnvironment,
    config.appleBundleId,
    config.appleEnvironment === "Sandbox"
      ? undefined
      : (config.appleAppId ?? undefined),
  );

  return {
    enabled: true,
    reason: null,
    verifying: true,
    async verifyNotification(p) {
      return (await verifier.verifyAndDecodeNotification(
        p,
      )) as DecodedNotification;
    },
    async verifyTransaction(p) {
      return (await verifier.verifyAndDecodeTransaction(
        p,
      )) as DecodedTransaction;
    },
    async verifyRenewalInfo(p) {
      return (await verifier.verifyAndDecodeRenewalInfo(
        p,
      )) as DecodedRenewalInfo;
    },
  };
}

/** Test helper. */
export function resetAppleVerifier(): void {
  cached = null;
}
