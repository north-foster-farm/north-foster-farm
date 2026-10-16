// A webhook delivery refused for its signature (#257). Square, PayPal
// and Resend each sign theirs; a refusal used to be a silent 401, so a
// wrong signing key or PAYPAL_WEBHOOK_ID dropped refunds and payment
// updates without a trace. Now each one is logged, and the ones that
// mean a misconfigured secret alert.
//
//   unconfigured   the secret isn't set in this context
//   unsigned       no signature header: a scanner, or a stray POST
//   stale          Resend only: the timestamp is out of tolerance
//   mismatch       signature headers present that don't verify
//
// Scanners don't send a provider's signature headers, so a signed
// delivery that fails means the secret is wrong: every reason but
// `unsigned` alerts. `unsigned` is decided first, so a scanner's POST
// to a context with no secret (a preview) is logged and never pages;
// `unconfigured` means a signed delivery arrived with no secret here.
// alert() sends one email and one ping per kind an hour; this
// instance also keeps its own hour, so a flood of forged headers costs
// a log line each and not a Blobs write each.

import { ALERT_EVERY, alert } from "./health.mjs";
import { json } from "./http.mjs";
import { log } from "./log.mjs";

export const KIND = "webhook.rejected";

export const REASONS = ["unconfigured", "unsigned", "stale", "mismatch"];

export const ALERTING = new Set(["unconfigured", "stale", "mismatch"]);

// Which secret a failing delivery points at, per provider.
export const SECRETS = {
  square: "SQUARE_WEBHOOK_SIGNATURE_KEY (and SQUARE_WEBHOOK_URL, " +
    "which Square signs with)",
  paypal: "PAYPAL_WEBHOOK_ID (and the PayPal client id and secret)",
  resend: "RESEND_WEBHOOK_SECRET",
};

let alertedAt = -Infinity;

// For the tests: forget this instance's last alert.
export const resetGuard = () => {
  alertedAt = -Infinity;
};

// Logs the refusal and, by reason, alerts; -> the same 401 as before.
// `id` is the provider's delivery id from its headers, when it sends
// one. The body is never logged: it is unverified, and may be anyone's.
export const rejected = async (stores, {
  provider, reason, body = "", id = null,
}, { env = process.env, now = new Date(), mail, fetchImpl } = {}) => {
  const detail = {
    provider,
    reason,
    bytes: Buffer.byteLength(String(body)),
    deliveryId: id ? String(id).slice(0, 100) : null,
  };
  const alerting = ALERTING.has(reason);
  const guarded = alerting && now.getTime() - alertedAt < ALERT_EVERY;

  log.warn({ event: KIND, ...detail, alert: alerting && !guarded });

  if (alerting && !guarded) {
    alertedAt = now.getTime();
    try {
      await alert(stores, "webhook.rejected", {
        ...detail, check: SECRETS[provider],
      }, { env, now, mail, fetchImpl });
    } catch (error) {
      log.error({ event: "webhook.alert_failed", error: String(error) });
    }
  }

  return json(401, { error: "Bad signature." });
};
