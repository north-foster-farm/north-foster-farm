// What each alert means and what to do about it, in the words the
// alert email carries and docs/monitoring.md repeats (a test keeps the
// two in step). `kind` is the alert's dotted name.

export const RUNBOOK_URL = "https://github.com/north-foster-farm/" +
  "north-foster-farm/blob/main/docs/monitoring.md";

export const RUNBOOK_ALERTS = `${RUNBOOK_URL}#the-alerts-and-what-to-do`;

export const GUIDE = {
  "order.create_failed": {
    means: "POST /api/orders could not create the Square order or " +
      "take the payment after retries, or a processor rejected it " +
      "outright. A declined card is not this: the customer just sees " +
      "the decline. The customer saw the failure card with your email " +
      "and phone.",
    action: "Check Square or PayPal status and the log (event " +
      "order.failed; the detail is the processor's answer). A retryable " +
      "failure is the processor or the network; a permanent one is " +
      "usually a bad token or application id.",
  },
  "order.after_paid_failed": {
    means: "The payment went through and the order was recorded, but a " +
      "step after that failed: the customer record or the stock " +
      "counts. The customer saw their confirmation; the store was the " +
      "problem. The emails are not part of this: they go after the " +
      "answer, and the jobs send any that did not.",
    action: "Open the order (bin/nff orders show <id>) and check what is " +
      "missing: its lines against the stock counts (stock set puts one " +
      "right), and the customer's record.",
  },
  "order.id_collision": {
    means: "A customer's order turned up under another customer's " +
      "order id. Nothing of the other order went back to them; they " +
      "saw the failure card. Each id is reserved before the charge, so " +
      "this should never happen. The stage says when it was caught: " +
      "recording (the payment went through and the order could not be " +
      "written), venmo (finishing a Venmo payment) or answer (just " +
      "before the reply to the page). A squarePaymentId or " +
      "paypalCaptureId in the alert is this customer's money, taken " +
      "with no order recorded for it.",
    action: "With a payment id: find it in Square (or the capture in " +
      "PayPal), then refund it, or ask the customer what they ordered " +
      "and record it by hand. Without one, nothing was charged. Either " +
      "way tell the developers: a reservation failed (#253).",
  },
  "payment.unreconciled": {
    means: "Money was taken for an order that could not be settled on " +
      "its own, and the customer was not charged again. Either a " +
      "payment turned up in Square for an order id whose record was " +
      "never written, but for another amount than the order now " +
      "totals (the customer changed the cart between tries), or " +
      "PayPal captured a Venmo payment for an order that was already " +
      "recorded as paid another way, or a customer changed the cart " +
      "after a Venmo payment that was recorded as it was paid. The " +
      "alert says which. A lost answer that is reconciled cleanly " +
      "raises no alert, only the log event payment.reconciled; the " +
      "first one in production, check by hand (the order, the one " +
      "Square payment, no second charge): Square's order search " +
      "cannot be tested against a payment seconds old.",
    action: "Find the order id in Square (the order's reference id) " +
      "and the payment in Square or PayPal. If the payment is good " +
      "and the order should stand, record the order by hand; if the " +
      "customer paid twice, refund the extra payment (in Square or " +
      "PayPal; bin/nff orders refund works on a recorded order) and " +
      "write to them.",
  },
  "order.reserve_failed": {
    means: "POST /api/orders could not reserve an order id in the " +
      "orders store, so it stopped before any payment. Nothing was " +
      "charged; the customer's page says to try again and retries.",
    action: "Check Netlify status (Blobs). One alone is a blip. " +
      "Several mean nobody can pay: look at the log (event " +
      "order.reserve_failed) for the store's error.",
  },
  "client.checkout_failed": {
    means: "The order page itself gave up: retries exhausted or a " +
      "permanent error. It carries the message the customer saw and the " +
      "method. Expect it beside order.create_failed; alone, it means the " +
      "page could not reach the site at all.",
    action: "If the site is up, look at the log for the same minute. If " +
      "many arrive, check Netlify status.",
  },
  "order.edit_failed": {
    means: "A customer's change to a paid order failed for a reason " +
      "other than a decline: Square or PayPal would not take or refund " +
      "the difference, or the record could not be written. The customer " +
      "was told to try again in a minute. The edit's key was written " +
      "first, so a retry finishes the same edit and never charges or " +
      "refunds twice.",
    action: "Check Square or PayPal status and the log (event " +
      "order.edit_failed; the detail is the processor's answer). " +
      "bin/nff orders show <id> shows whether the edit is still pending. " +
      "If the customer does not retry, finish or undo it with them.",
  },
  "client.payment_unavailable": {
    means: "A customer's order page could not offer any way to pay, so " +
      "it told them to email the order instead. The where field says " +
      "why: checkout.config or checkout.init (/api/checkout/config " +
      "failed or named no processor), square.load (Square's script " +
      "would not load or start), or sdks.gone (neither the card nor " +
      "Venmo came up). The square and paypal fields give each one's " +
      "state and load time.",
    action: "Open /order/ yourself. If it pays, it was the customer's " +
      "network or a blocker: one alone needs nothing. If it does not, " +
      "check Square status, then the log for the same minute and " +
      "GET /api/checkout/config. bin/nff errors show maps the stack.",
  },
  "client.error": {
    means: "Not an alert: logged at warn only, never emailed. Something " +
      "on the order page threw or failed where the customer could " +
      "carry on: the card field would not attach, PayPal would not load " +
      "or render, a wallet would not tokenize, or an uncaught error. " +
      "The where field names the place.",
    action: "Query the log (event client.error) for a pattern: the same " +
      "where from many browsers is ours to fix, one browser alone " +
      "rarely is. bin/nff errors show maps the stack to the source " +
      "line.",
  },
  "mail.failed": {
    means: "An email could not be sent: to a customer or the farm about " +
      "an order, or a contact-form message to the farm. Any order and " +
      "its record are fine; the email is not. A contact message is kept " +
      "(messages/<id> in the customers store), and its writer was told " +
      "it did not send.",
    action: "Check Resend status and the daily quota (100 on the free " +
      "plan). The failing send is logged with the template name and the " +
      "order or message id. Resend an order's email with bin/nff or from " +
      "the order page once mail works; for a contact message, write back " +
      "to its sender.",
  },
  "square.record_failed": {
    means: "A Venmo payment was captured but its Square order and " +
      "external tender could not be made: for a new order, or for the " +
      "difference a customer paid by Venmo when changing one. The order " +
      "is recorded and the customer is fine; the Square dashboard does " +
      "not show that payment yet.",
    action: "For a new order the jobs try again every run (squareSynced " +
      "in the report); if square.missing shows up in the invariants a " +
      "day later, check SQUARE_ACCESS_TOKEN and Square status. For a " +
      "change, nothing retries: record the difference in Square by hand.",
  },
  "square.edit_failed": {
    means: "A customer's change to a paid order went through and is " +
      "recorded, but Square's fulfillment could not follow it, so what " +
      "Square shows to pack or where is out of date. The order is " +
      "flagged squareOutOfSync.",
    action: "Pack from bin/nff orders show <id>, not from Square. Check " +
      "Square status and the log (event square.update_failed), then fix " +
      "the fulfillment in the Square dashboard by hand.",
  },
  "square.complete_failed": {
    means: "An order was fulfilled and the record says so, but Square " +
      "could not be told, so the order stays open there. The order is " +
      "flagged squareOutOfSync and the farm has its own email.",
    action: "Complete the order in the Square dashboard by hand. The " +
      "log (event square.complete_failed) has Square's answer.",
  },
  "square.refund_failed": {
    means: "A refund made in PayPal could not be repeated on the Square " +
      "copy of the Venmo payment. The customer has the money back and " +
      "the order records the refund; only Square's books disagree.",
    action: "In the Square dashboard, refund the same amount on that " +
      "Venmo payment so Square agrees with PayPal. Its tender is " +
      "external, so no money moves. The alert names the order and the " +
      "PayPal refund.",
  },
  "venmo.amount_mismatch": {
    means: "PayPal captured a different amount than was asked: the " +
      "order's total, or for a change to an order, the difference. The " +
      "order is recorded as paid all the same.",
    action: "bin/nff orders show <id>, compare with the capture in " +
      "PayPal, and refund or charge the difference by hand.",
  },
  "pass.used_twice": {
    means: "A paid order came in with a single-use pass that another " +
      "order had already used up, so one code covered two orders under " +
      "the delivery minimum or with no fee. Both are recorded as paid.",
    action: "bin/nff orders show <id> for both orders, then bin/nff " +
      "passes list for the code; charge the second order's fee or " +
      "cancel it by hand if the farm did not mean to allow it, and " +
      "revoke the code.",
  },
  "refund.failed": {
    means: "Square reports a refund FAILED or REJECTED, or PayPal a " +
      "Venmo refund FAILED or CANCELLED: the customer did not get that " +
      "money back. A refund from bin/nff is marked so on the order and " +
      "no longer counts as refunded; one made in the Square dashboard " +
      "was never recorded. The webhook raises it as it happens; the " +
      "daily refund check raises what the webhooks missed.",
    action: "Look up the refund in Square or PayPal for the reason " +
      "(often a card or account that has closed). Refund again with " +
      "bin/nff orders refund <id>, or pay the customer another way and " +
      "tell them.",
  },
  "refund.stalled": {
    means: "A refund made five or more days ago has still not " +
      "settled, or has no Square or PayPal id to check it by. The " +
      "customer was told it takes a few days. Raised once per refund.",
    action: "Look up the refund in Square or PayPal. If it is still " +
      "pending there, ask their support why. If it is not there at " +
      "all, refund again with bin/nff orders refund <id>. " +
      "bin/nff refunds check lists every refund still waiting.",
  },
  "webhook.rejected": {
    means: "Square, PayPal or Resend sent a webhook this site refused: " +
      "its secret is not set here (unconfigured), its timestamp is too " +
      "old (stale, Resend only), or it was signed and the signature did " +
      "not verify (mismatch). Scanners send no signature, so a signed " +
      "delivery that fails means a wrong secret, and the refunds, " +
      "payment updates or unsubscribes it carried were dropped. An " +
      "unsigned POST is only logged.",
    action: "Check the provider's secret on Netlify for this context: " +
      "Square, SQUARE_WEBHOOK_SIGNATURE_KEY (and SQUARE_WEBHOOK_URL, the " +
      "URL Square signs with); PayPal, PAYPAL_WEBHOOK_ID and the client " +
      "id and secret; Resend, RESEND_WEBHOOK_SECRET. Compare it with the " +
      "provider's webhook settings, set it, redeploy, then resend a " +
      "test event from the provider. The log (event webhook.rejected) " +
      "has every refusal.",
  },
  "pickup.lapsed": {
    means: "A Venmo payment approved on the order page was finished by " +
      "the jobs after its pickup time had left the schedule. The order " +
      "is paid and booked for that time.",
    action: "Keep the time if you can be there. If not, cancel it with " +
      "bin/nff orders cancel <id> --reason <why> (or --reason-text " +
      "\"...\"), which refunds it.",
  },
  "jobs.errors": {
    means: "An order's work in the 15-minute run threw. The rest of the " +
      "run finished. The report lists the order and the step.",
    action: "bin/nff orders show <id>; the error names the step. Fix the " +
      "record or the code.",
  },
  "jobs.invariants": {
    means: "The run finished but the records are not in the state a " +
      "healthy run leaves them. Each violation names its rule and its " +
      "order.",
    action: "Read the rule in the runbook; each names what should have " +
      "happened to that order.",
  },
  "jobs.crashed": {
    means: "The run itself threw before it could do its work. This is " +
      "the one that also stops the heartbeat.",
    action: "The log has the stack (event jobs.crashed). Fix and " +
      "redeploy; the next run catches up.",
  },
  "backup.failed": {
    means: "The nightly backup export did not reach the R2 bucket: a " +
      "BACKUP_ variable is unset or wrong, the store could not be " +
      "read, or R2 refused the upload. The Backup check pushes too. " +
      "Last night's copy is still in the bucket; tonight's is missing.",
    action: "The error names the cause (and the log, event " +
      "backup.failed). Fix the variable or the token, then take a copy " +
      "now with bin/nff --production export. A Backup check that goes " +
      "down with no alert means the run never started: check the " +
      "function's schedule in Netlify.",
  },
  "alert.test": {
    means: "Someone ran bin/nff alert test. Nothing is wrong. It went " +
      "through the same path as a real alert, past the hourly limit, " +
      "so this email and a down-then-up push on the phone prove both " +
      "channels work.",
    action: "Nothing, if the phone buzzed too. If it did not, check the " +
      "Alerts check's integrations in Healthchecks.",
  },
  "function.crashed": {
    means: "A site function threw an exception nothing in it caught, " +
      "so whoever called it got Netlify's bare 500. The alert names " +
      "the function, the path and the error, with the top of the stack. " +
      "One is sent an hour for each function.",
    action: "Read the stack in the alert or the log (event " +
      "function.crashed, by function). If it is the order or payment " +
      "path, check bin/nff orders list for an order that half happened. " +
      "Fix and redeploy; a POST to /api/staging/throw on staging raises " +
      "one on purpose.",
  },
};
