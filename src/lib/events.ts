/**
 * Canonical event names — the single source of truth.
 *
 * The funnel names used to live as bare strings inside the SQL of three
 * different drivers (pg, sqlite, sqlite-bun). That works until one of them
 * drifts: rename `subscribe` in the app and the funnel silently reports zero
 * while the events table is full. Keeping the names here means a rename is one
 * edit, and the drivers cannot disagree.
 *
 * ⚠️ These values are the CONTRACT with the app. Renaming one does not rewrite
 * the rows already in the database — old events keep the old name forever.
 */

// ── Funnel: emitted by the app ───────────────────────────────────────────────
export const EVENT = {
  paywallView: "paywall_view",
  checkoutInitiated: "checkout_initiated",
  startTrial: "start_trial",
  subscribe: "subscribe",
} as const;

/**
 * Subscription lifecycle — emitted by the Apple webhook, NOT by the app.
 *
 * The app is blind to everything that happens after the purchase button:
 *
 *   • cancelling happens in Settings -> Apple ID -> Subscriptions, outside the
 *     app, and whoever cancels a trial usually never opens the app again — so
 *     no client-side check can catch it reliably;
 *   • renewal (month 2, year 2) happens on Apple's servers, with no device
 *     involved. `subscribe` only ever fires on the FIRST purchase;
 *   • refunds likewise.
 *
 * The `sub_` prefix separates origin: `subscribe`/`start_trial` are what the
 * app SAW; `sub_*` is what Apple CONFIRMED. Never add the two to the same
 * revenue total — a single sale produces one of each.
 */
export const SUB_EVENT = {
  /** SUBSCRIBED/INITIAL_BUY with no trial offer — paid from day one. */
  started: "sub_started",
  /** SUBSCRIBED/INITIAL_BUY with a free trial offer. */
  trialStarted: "sub_trial_started",
  /** SUBSCRIBED/RESUBSCRIBE — came back after leaving. */
  resubscribed: "sub_resubscribed",

  /**
   * The event this backend was missing. DID_CHANGE_RENEWAL_STATUS with
   * AUTO_RENEW_DISABLED. NOTE: they still HAVE ACCESS until `expires_at`.
   * Cancelling is not expiring — see `expired`.
   */
  cancelled: "sub_cancelled",
  /**
   * Subset of `cancelled`: cancelled WHILE IN TRIAL. Always emitted alongside
   * `cancelled` (the total), never instead of it. Apple's notification is
   * identical in both cases, and the two call for opposite responses: a
   * cancelled trial is a first-week value problem, a cancelled paying
   * subscriber is a retention problem.
   */
  trialCancelled: "sub_trial_cancelled",
  /** Changed their mind before expiry (AUTO_RENEW_ENABLED). */
  reactivated: "sub_reactivated",

  /** DID_RENEW — charged again. This is real revenue. */
  renewed: "sub_renewed",
  /** First DID_RENEW after a trial: the trial turned into money. */
  trialConverted: "sub_trial_converted",

  /** EXPIRED / GRACE_PERIOD_EXPIRED — access actually ended. */
  expired: "sub_expired",
  /** Subset of `expired`: the trial ran out without ever paying. */
  trialExpired: "sub_trial_expired",

  /** DID_FAIL_TO_RENEW — card declined. Involuntary churn, recoverable. */
  billingIssue: "sub_billing_issue",
  /** DID_RENEW/BILLING_RECOVERY — the card went through after a failure. */
  billingRecovered: "sub_billing_recovered",

  /** REFUND — Apple gave the money back. NEGATIVE revenue. */
  refunded: "sub_refunded",
  /** REFUND_REVERSED — Apple undid the refund. */
  refundReversed: "sub_refund_reversed",
  /** REVOKE — lost access, e.g. removed from Family Sharing. */
  revoked: "sub_revoked",

  /** DID_CHANGE_RENEWAL_PREF — switched plan (upgrade/downgrade). */
  planChanged: "sub_plan_changed",
  /** PRICE_INCREASE — price change proposed or accepted. */
  priceIncrease: "sub_price_increase",
  /** OFFER_REDEEMED — redeemed a promo code or offer. */
  offerRedeemed: "sub_offer_redeemed",

  /** TEST — the notification triggered by `npm run apple:test`. */
  appleTest: "apple_test_notification",
} as const;

/** Money Apple confirmed. Do NOT mix with the app's `subscribe`. */
export const APPLE_REVENUE_EVENTS = [
  SUB_EVENT.started,
  SUB_EVENT.resubscribed,
  SUB_EVENT.renewed,
] as const;

/** Money Apple gave back. Subtracted from the net total. */
export const APPLE_REFUND_EVENTS = [SUB_EVENT.refunded] as const;

/** Every name the webhook can write — used to scope queries by origin. */
export const SUB_EVENTS: readonly string[] = Object.values(SUB_EVENT);

/**
 * Build a list to interpolate into an `IN (...)`.
 *
 * Interpolating strings into SQL is normally injection. Here it is not: the
 * only possible inputs are the constants in this file, which are code
 * literals. The quote escaping stays anyway, because "no outside data will
 * ever reach here" is the kind of assumption that ages badly.
 */
export function sqlList(events: readonly string[]): string {
  return events.map((e) => `'${e.replace(/'/g, "''")}'`).join(", ");
}
