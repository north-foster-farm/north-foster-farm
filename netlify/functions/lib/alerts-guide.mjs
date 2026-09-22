// What each alert means and what to do about it, in the words the
// alert email carries and docs/monitoring.md repeats (a test keeps the
// two in step). `kind` is the alert's dotted name.

export const RUNBOOK_URL = "https://github.com/north-foster-farm/" +
  "north-foster-farm/blob/main/docs/monitoring.md";

export const RUNBOOK_ALERTS = `${RUNBOOK_URL}#the-alerts-and-what-to-do`;

export const GUIDE = {
  "order.create_failed": {
    means: "POST /api/orders could not create the Square order or " +
      "invoice after retries, or Square rejected it outright. The " +
      "customer saw the failure card with your email and phone.",
    action: "Check Square status and the log (event order.failed; the " +
      "detail is Square's answer). A retryable failure is Square or the " +
      "network; a permanent one is usually an item not available at the " +
      "web location, or a bad token.",
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
  "poll.failed": {
    means: "Asking Square about an unpaid invoice threw. The next run " +
      "retries.",
    action: "Act only if it repeats for an hour: check " +
      "SQUARE_ACCESS_TOKEN and Square status.",
  },
  "venmo.fetch_failed": {
    means: "Resend's inbound webhook arrived but the message could not " +
      "be read. Resend retries the webhook.",
    action: "Check that RESEND_READ_KEY is set and can read received " +
      "mail.",
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
