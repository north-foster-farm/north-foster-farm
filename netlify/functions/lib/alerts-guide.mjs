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
  "client.checkout_failed": {
    means: "The order page itself gave up: retries exhausted or a " +
      "permanent error. It carries the message the customer saw and the " +
      "method. Expect it beside order.create_failed; alone, it means the " +
      "page could not reach the site at all.",
    action: "If the site is up, look at the log for the same minute. If " +
      "many arrive, check Netlify status.",
  },
  "mail.failed": {
    means: "A customer or farm email could not be sent. The order and " +
      "its record are fine; the email is not.",
    action: "Check Resend status and the daily quota (100 on the free " +
      "plan). The failing send is logged with the template name and " +
      "order id; resend with bin/nff or from the order page once mail " +
      "works.",
  },
  "square.record_failed": {
    means: "A Venmo payment was captured but its Square order and " +
      "external tender could not be made. The order is recorded and " +
      "the customer is fine; the Square dashboard does not show it yet.",
    action: "The jobs try again every run (squareSynced in the report). " +
      "If square.missing shows up in the invariants a day later, check " +
      "SQUARE_ACCESS_TOKEN and Square status.",
  },
  "venmo.amount_mismatch": {
    means: "PayPal captured a different amount than the order's total. " +
      "The order is recorded as paid all the same.",
    action: "bin/nff orders show <id>, compare with the capture in " +
      "PayPal, and refund or charge the difference by hand.",
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
};
