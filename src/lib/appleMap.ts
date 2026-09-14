/**
 * Apple notification -> internal event.
 *
 * Translates `notificationType` + `subtype` from App Store Server
 * Notifications V2 into SUB_EVENT names. Two distinctions live here that most
 * home-grown dashboards get wrong:
 *
 *   1. CANCELLING != EXPIRING.
 *      `DID_CHANGE_RENEWAL_STATUS/AUTO_RENEW_DISABLED` is the tap on "cancel
 *      subscription". The person KEEPS ACCESS until `expiresDate`. Access ends
 *      at `EXPIRED`, which arrives days (or eleven months) later. Counting
 *      both as the same thing inflates churn and erases the win-back window —
 *      which is exactly the gap between the two.
 *
 *   2. CANCELLED TRIAL != CANCELLED PAYING SUBSCRIBER.
 *      Apple's notification is identical. What tells them apart is the STATE
 *      of the subscription at that moment, which only exists if you store it —
 *      hence the `wasTrial` argument.
 *
 * Unmapped types are still recorded (as `apple_<type>`): Apple does not resend
 * after you answer 200, so a silently dropped notification is data lost for
 * good.
 */

import { SUB_EVENT } from "./events";

export type SubStatus =
  | "active" // paying and renewing
  | "trialing" // inside the free trial
  | "cancelled" // auto-renew off, but still has access
  | "expired" // access ended
  | "billing_retry" // charge failed, Apple is retrying
  | "refunded"
  | "revoked";

export type SubEventResult = {
  /** Primary event. Always present. */
  event: string;
  /** Extra event — a narrower cut of the same fact (never a second fact). */
  extra?: string;
  /** New subscription status, when the notification defines one. */
  status?: SubStatus;
  /** true = renews; false = cancelled; undefined = unchanged. */
  autoRenew?: boolean;
};

/**
 * @param type     Apple's notificationType
 * @param subtype  Apple's subtype (may be absent)
 * @param isTrial  is THIS notification's transaction a free trial?
 * @param wasTrial did our stored state say the subscription was in trial?
 */
export function toSubEvent(
  type: string,
  subtype: string | null,
  isTrial: boolean,
  wasTrial: boolean,
): SubEventResult {
  switch (type) {
    case "SUBSCRIBED":
      if (subtype === "RESUBSCRIBE") {
        return {
          event: SUB_EVENT.resubscribed,
          status: isTrial ? "trialing" : "active",
          autoRenew: true,
        };
      }
      return isTrial
        ? { event: SUB_EVENT.trialStarted, status: "trialing", autoRenew: true }
        : { event: SUB_EVENT.started, status: "active", autoRenew: true };

    case "DID_CHANGE_RENEWAL_STATUS":
      if (subtype === "AUTO_RENEW_DISABLED") {
        return {
          event: SUB_EVENT.cancelled,
          // `cancelled` is always the total; the trial cut is tagged
          // separately, never in its place, so "how many cancelled" stays a
          // single sum.
          extra: wasTrial ? SUB_EVENT.trialCancelled : undefined,
          status: "cancelled",
          autoRenew: false,
        };
      }
      if (subtype === "AUTO_RENEW_ENABLED") {
        return {
          event: SUB_EVENT.reactivated,
          status: wasTrial ? "trialing" : "active",
          autoRenew: true,
        };
      }
      // Apple has sent this without a subtype. With no direction to the
      // change, recording it without touching status beats guessing
      // "cancelled".
      return { event: SUB_EVENT.cancelled };

    case "DID_RENEW":
      // A DID_RENEW on a subscription that was in trial is THE number that
      // matters: trial -> paid. After it, the subscription is no longer trial.
      if (wasTrial) {
        return {
          event: SUB_EVENT.renewed,
          extra: SUB_EVENT.trialConverted,
          status: "active",
        };
      }
      if (subtype === "BILLING_RECOVERY") {
        return {
          event: SUB_EVENT.renewed,
          extra: SUB_EVENT.billingRecovered,
          status: "active",
        };
      }
      return { event: SUB_EVENT.renewed, status: "active" };

    case "EXPIRED":
    case "GRACE_PERIOD_EXPIRED":
      // A trial that expired without renewing is the denominator of the
      // conversion rate: trials that have already resolved, without paying.
      return {
        event: SUB_EVENT.expired,
        extra: wasTrial ? SUB_EVENT.trialExpired : undefined,
        status: "expired",
        autoRenew: false,
      };

    case "DID_FAIL_TO_RENEW":
      // INVOLUNTARY churn: the card was declined, nobody asked to leave.
      // Lumping it in with voluntary cancellation makes you fix the wrong
      // problem — this one is solved with a billing prompt, not a discount.
      return { event: SUB_EVENT.billingIssue, status: "billing_retry" };

    case "REFUND":
      return { event: SUB_EVENT.refunded, status: "refunded" };

    case "REFUND_REVERSED":
      return { event: SUB_EVENT.refundReversed, status: "active" };

    case "REVOKE":
      return { event: SUB_EVENT.revoked, status: "revoked", autoRenew: false };

    case "DID_CHANGE_RENEWAL_PREF":
      return { event: SUB_EVENT.planChanged };

    case "PRICE_INCREASE":
    case "PRICE_CHANGE":
      return { event: SUB_EVENT.priceIncrease };

    case "OFFER_REDEEMED":
      return { event: SUB_EVENT.offerRedeemed };

    case "TEST":
      return { event: SUB_EVENT.appleTest };

    default:
      // CONSUMPTION_REQUEST, RENEWAL_EXTENDED, METADATA_UPDATE, MIGRATION,
      // ONE_TIME_CHARGE... keep the raw name instead of throwing it away.
      return { event: `apple_${type.toLowerCase()}` };
  }
}

/**
 * Is this transaction a free trial?
 *
 * `offerType 1` is an introductory offer, and `offerDiscountType FREE_TRIAL`
 * is its free flavour (the others — PAY_AS_YOU_GO, PAY_UP_FRONT — cost money).
 * The `price === 0` check is the safety net for older payloads that did not
 * carry `offerDiscountType`.
 */
export function isFreeTrial(tx: {
  offerType?: number | string;
  offerDiscountType?: string;
  price?: number;
}): boolean {
  if (tx.offerDiscountType === "FREE_TRIAL") return true;
  if (Number(tx.offerType) === 1 && (tx.price ?? 0) === 0) return true;
  return false;
}

/**
 * Apple price -> currency units.
 *
 * Apple sends `price` and `renewalPrice` in MILLIUNITS: 29900 means R$ 29.90.
 * Storing the raw number multiplies revenue by a thousand, and it is the kind
 * of bug that goes unnoticed until someone celebrates the wrong month.
 */
export function fromMilliunits(price: unknown): number | null {
  return typeof price === "number" && Number.isFinite(price)
    ? price / 1000
    : null;
}
