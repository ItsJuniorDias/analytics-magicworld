/**
 * POST /apple/notifications — App Store Server Notifications V2.
 *
 * This is what RevenueCat sells. Apple POSTs here every time something happens
 * to a subscription — including, above all, when someone cancels, which they
 * do in Settings -> Apple ID -> Subscriptions: a place this app is not and
 * never will be.
 *
 * Why it cannot be solved in the app:
 *   • whoever cancels a trial usually does not open the app again, so a
 *     StoreKit check at launch only finds the cancellations of people who came
 *     back — the minority who may not have really left;
 *   • renewal (the moment a trial turns into money) runs on Apple's servers
 *     with no device connected;
 *   • refunds likewise.
 *
 * The contract with Apple:
 *   • body = { "signedPayload": "<JWS>" };
 *   • 2xx means "got it, stop". Anything else means resend (up to 5 attempts
 *     over ~3 days). So: our fault (database down) -> answer 500 ON PURPOSE so
 *     Apple brings it back. Payload that will not verify -> 401, because
 *     resending will not make it verify;
 *   • the same notification can arrive twice even after a 200 —
 *     `claimAppleNotification` (primary key on notificationUUID) handles that.
 */

import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";

import { config } from "../config";
import type { Db, SubscriptionPatch } from "../db";
import { fromMilliunits, isFreeTrial, toSubEvent } from "../lib/appleMap";
import {
  getAppleVerifier,
  type DecodedRenewalInfo,
  type DecodedTransaction,
} from "../lib/appleVerifier";
import { SUB_EVENT } from "../lib/events";
import { storefrontToAlpha2 } from "../lib/storefront";

/**
 * originalTransactionId -> a stable, anonymous key.
 *
 * Apple's raw id is a permanent subscriber identifier and never goes into the
 * database. An HMAC with a server-side secret preserves the only thing we
 * need — "is this the same subscription as before?" — without storing the
 * original. To investigate one case, HMAC the id the customer gives you and
 * search for it.
 */
function subKey(originalTransactionId: string): string {
  return crypto
    .createHmac("sha256", config.subHashSecret)
    .update(originalTransactionId)
    .digest("hex")
    .slice(0, 32);
}

export async function registerAppleNotifications(
  app: FastifyInstance,
  db: Db,
): Promise<void> {
  const verifier = await getAppleVerifier();

  if (!verifier.enabled) {
    app.log.warn({ reason: verifier.reason }, "apple_webhook_disabled");
  } else if (!verifier.verifying) {
    app.log.error(
      "apple_webhook_unverified: APPLE_SKIP_VERIFICATION=true — anyone who " +
        "finds this URL can write to the database. Local testing only.",
    );
  } else {
    app.log.info(
      {
        path: config.appleWebhookPath,
        environment: config.appleEnvironment,
        bundleId: config.appleBundleId,
      },
      "apple_webhook_ready",
    );
  }

  app.post<{ Body: { signedPayload?: unknown } }>(
    config.appleWebhookPath,
    async (req, reply) => {
      if (!verifier.enabled) {
        // 503, not 200: Apple requeues, so notifications arriving while you
        // finish the setup are not lost.
        return reply
          .code(503)
          .send({ ok: false, error: "apple_webhook_disabled", reason: verifier.reason });
      }

      const signedPayload = req.body?.signedPayload;
      if (typeof signedPayload !== "string") {
        return reply.code(400).send({ ok: false, error: "missing_signed_payload" });
      }

      let notification;
      try {
        notification = await verifier.verifyNotification(signedPayload);
      } catch (err) {
        req.log.warn({ err }, "apple_payload_unverified");
        return reply.code(401).send({ ok: false, error: "invalid_payload" });
      }

      const type = notification.notificationType ?? "UNKNOWN";
      const subtype = notification.subtype ?? null;
      const uuid = notification.notificationUUID ?? crypto.randomUUID();
      const now = Date.now();

      // Replay guard, BEFORE any write: a repeated notification stops here and
      // duplicates neither events nor counters.
      let isNew: boolean;
      try {
        isNew = await db.claimAppleNotification(uuid, type, subtype, now);
      } catch (err) {
        req.log.error({ err }, "apple_claim_failed");
        return reply.code(500).send({ ok: false, error: "internal" }); // Apple retries
      }
      if (!isNew) {
        req.log.info({ uuid, type }, "apple_duplicate_ignored");
        return reply.code(200).send({ ok: true, duplicate: true });
      }

      // The TEST notification (npm run apple:test) has no transaction attached.
      // Worth recording to confirm the URL is right, then bail out before
      // reading data that is not there.
      if (type === "TEST") {
        await db.insertEvent({
          event: SUB_EVENT.appleTest,
          ts: now,
          session_id: null,
          user_id: null,
          platform: "apple_webhook",
          app_version: null,
          country: null,
          locale: null,
          currency: null,
          value: null,
          product_id: null,
          params_json: JSON.stringify({
            environment: notification.data?.environment ?? null,
          }),
        });
        req.log.info("apple_test_notification_received");
        return reply.code(200).send({ ok: true, test: true });
      }

      let tx: DecodedTransaction = {};
      let renewal: DecodedRenewalInfo = {};
      try {
        if (notification.data?.signedTransactionInfo) {
          tx = await verifier.verifyTransaction(notification.data.signedTransactionInfo);
        }
        if (notification.data?.signedRenewalInfo) {
          renewal = await verifier.verifyRenewalInfo(notification.data.signedRenewalInfo);
        }
      } catch (err) {
        req.log.warn({ err, type }, "apple_transaction_unverified");
        return reply.code(401).send({ ok: false, error: "invalid_transaction" });
      }

      const originalId = tx.originalTransactionId ?? renewal.originalTransactionId;
      if (!originalId) {
        req.log.warn({ type, subtype }, "apple_no_original_transaction_id");
        return reply.code(200).send({ ok: true, ignored: true });
      }

      const key = subKey(originalId);

      // The PREVIOUS state is what answers "was that cancellation a trial or a
      // payer?". Apple's notification alone does not say.
      let previous = null;
      try {
        previous = await db.getSubscription(key);
      } catch (err) {
        req.log.error({ err }, "apple_read_subscription_failed");
        return reply.code(500).send({ ok: false, error: "internal" });
      }

      const isTrialNow = isFreeTrial(tx);
      const wasTrial = previous?.is_trial ?? isTrialNow;
      const mapped = toSubEvent(type, subtype, isTrialNow, wasTrial);

      // Storefront is where they PAY (and in which currency) — a better country
      // than anything the device reports, which is only where they opened the app.
      const country = storefrontToAlpha2(tx.storefront);
      const price = fromMilliunits(tx.price) ?? fromMilliunits(renewal.renewalPrice);
      const currency = tx.currency ?? renewal.currency ?? null;
      const productId = tx.productId ?? renewal.autoRenewProductId ?? null;

      // If the app passes `appAccountToken` at purchase time, Apple echoes it
      // back here — which lets these rows JOIN against the app's own funnel
      // events by user_id. Nothing breaks when it is absent; the column is
      // simply null and the webhook data stands alone.
      const userId = tx.appAccountToken ?? renewal.appAccountToken ?? null;

      // Only these carry money; the rest must not pollute revenue. A refund is
      // stored positive and subtracted in the query.
      const carriesValue =
        mapped.event === SUB_EVENT.started ||
        mapped.event === SUB_EVENT.resubscribed ||
        mapped.event === SUB_EVENT.renewed ||
        mapped.event === SUB_EVENT.refunded;

      const params = {
        source: "apple_webhook",
        notification_type: type,
        subtype,
        environment: tx.environment ?? notification.data?.environment ?? null,
        storefront: country,
        expires_at: tx.expiresDate ?? null,
        expiration_intent: renewal.expirationIntent ?? null,
        in_trial: wasTrial,
      };

      // `ts` is when Apple SIGNED it, not when Render received it — so a
      // delayed (or replayed) notification lands on the day the thing actually
      // happened.
      const eventTs = notification.signedDate ?? tx.purchaseDate ?? now;

      const names = [mapped.event, mapped.extra].filter(
        (n): n is string => typeof n === "string",
      );

      try {
        for (const event of names) {
          await db.insertEvent({
            event,
            ts: eventTs,
            session_id: null,
            user_id: userId,
            platform: "apple_webhook",
            app_version: null,
            country,
            locale: null,
            // Only the primary event carries value: the extra is a narrower cut
            // of the same fact (sub_trial_cancelled inside sub_cancelled).
            // Repeating the amount would count one sale twice.
            currency: event === mapped.event && carriesValue ? currency : null,
            value: event === mapped.event && carriesValue ? price : null,
            product_id: productId,
            params_json: JSON.stringify(params),
          });
        }

        const patch: SubscriptionPatch = {
          sub_key: key,
          product_id: productId,
          status: mapped.status,
          // `is_trial` only changes when the notification settles it: became
          // paid (DID_RENEW after a trial), or a new trial began.
          is_trial:
            mapped.extra === SUB_EVENT.trialConverted
              ? false
              : mapped.event === SUB_EVENT.trialStarted
                ? true
                : undefined,
          auto_renew:
            mapped.autoRenew ??
            (renewal.autoRenewStatus === undefined
              ? undefined
              : renewal.autoRenewStatus === 1),
          environment: tx.environment ?? notification.data?.environment ?? null,
          country,
          currency,
          price,
          user_id: userId,
          started_at: tx.originalPurchaseDate ?? null,
          expires_at: tx.expiresDate ?? null,
          cancelled_at: mapped.event === SUB_EVENT.cancelled ? eventTs : null,
          expired_at: mapped.event === SUB_EVENT.expired ? eventTs : null,
          renewalsInc: mapped.event === SUB_EVENT.renewed ? 1 : 0,
          last_notification: subtype ? `${type}/${subtype}` : type,
          updated_at: now,
        };
        await db.upsertSubscription(patch);
      } catch (err) {
        req.log.error({ err, type }, "apple_write_failed");
        return reply.code(500).send({ ok: false, error: "internal" }); // Apple retries
      }

      req.log.info({ type, subtype, events: names, productId }, "apple_notification_handled");
      return reply.code(200).send({ ok: true, events: names });
    },
  );
}
