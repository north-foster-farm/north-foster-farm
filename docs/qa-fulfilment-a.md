# QA guide: fulfilment step A

What to try once the on-page checkout is on staging, what should
happen, and where to look when it does not. Work through it on the
staging deploy against the Square and PayPal sandboxes
(`docs/staging.md`), with `bin/nff --staging` for the records; a
final pass on production uses a real $7 egg order refunded at the
end. Every check names the command or page that shows the truth; the
emails are the second witness.

Before starting, on the staging context: `ACCOUNTS_ENABLED=true`,
`SQUARE_APPLICATION_ID`, the sandbox `SQUARE_ACCESS_TOKEN` and
`SQUARE_LOCATION_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY` for the sandbox
webhook, and for Venmo `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`,
`PAYPAL_ENV=sandbox` and `PAYPAL_WEBHOOK_ID`. Without the first,
emails carry no links to the account pages and the deny email asks
for a reply; without the PayPal pair the Venmo button does not
appear; without either processor the payment section says online
payment is unavailable. On this machine, `.env.staging` holds every
key in `.env.sample`: the same sandbox token and location, the Netlify
pair, `MAIL_DRIVER=outbox`, `ACCOUNTS_ENABLED=true` and `SITE_URL`
set to the staging address, so
`bin/nff --staging` meets the same sandbox and its emails land in the
toolbar's inbox; a production location id there makes every Square
update from the CLI fail with "Immutable field cannot be changed".

Read a record at any point with `bin/nff --staging orders show <id>`.
The `history` list is the order's diary; `emails` is every send,
keyed by template, so "did it send" is a lookup, not a guess;
`payment` says how the money came.

## 1. Sign in and the header

- [ ] Home page, signed out: the header shows **Sign in** between
      About and Order.
- [ ] `/login/`: the intro paragraph sits above one card, "Send me a
      magic link": a label column and a field column, a plain input,
      one button under the field column.
      The header still shows Sign in, marked as the current page.
- [ ] Submit an empty email: red field and a message under it, button
      stays in place.
- [ ] Submit your email: the card is replaced by "Check your email"
      naming the address. The email is "Your secure sign-in link to
      North Foster Farm"; the link signs you in and lands on
      `/account/`. Following it a second time lands on `/login/` with
      "already used" explained.
- [ ] Signed in, the header shows **Account** with its menu. On
      `/account/` too.
- [ ] Four link requests within 15 minutes: the fourth answers the
      same "Check your email" but sends nothing (rate limit; the
      earlier link still works).

## 2. Paying on the page

Fill a cart and the details, choose on-farm pickup for a date a few
days out, and scroll to Payment.

- [ ] The Payment section shows Square's card fields. In Chrome a
      Google Pay button and, with PayPal configured, a Venmo button
      sit under "Or pay with"; in Safari an Apple Pay button appears
      once the domain is verified. The submit button reads "Place
      your order"; the total is in the cart.
- [ ] Press the button with an empty required field: the field is
      marked and nothing is charged (no `order.paid` in the log).
- [ ] Square's test card `4111 1111 1111 1111`, any future expiry, CVV
      `111`, ZIP `94103`: the button reads "Taking your payment…",
      then the form is replaced by "Thank you, <name>. Your order is
      placed." with "$X paid with Visa ending 1111", the email the
      confirmation goes to, the order number and a "View your
      receipt" link to Square's receipt.
- [ ] `bin/nff --staging orders show <id>`: `status` is `paid`,
      `payment.via` is `square`, `payment.method` `card`, `last4`
      `1111`, `square.squareOrderId` set, `history[0].event` is
      `paid`, stock moved down.
- [ ] The Square sandbox dashboard shows the order with its fulfilment
      and the payment against it.
- [ ] The customer email is "Your order is confirmed" with "your
      pickup time is set" and "When: <day>, <window>" (W11d: booked by
      paying), and the farm's "New order ... on-farm pickup" carries
      "Paid: **$X by Visa ending 1111**" and no confirm command.
- [ ] Reload the page: the cart is empty, the draft gone.

Declined:

- [ ] New cart, card `4000 0000 0000 0002`: no success card. Under the
      card fields, "Your card was declined. Try another card." in
      red; the form stays as it was. `bin/nff --staging orders list`
      shows no new order; the Square sandbox shows the order for it
      as Canceled, not open. The log has `payment.declined` and the
      next morning report counts one decline.
- [ ] Enter the good card and pay: it goes through as a fresh
      attempt (`meta.attempt` is `2`).

The total moved under them:

- [ ] Change the cart after pressing Pay once (say a decline first),
      then pay again: the charge is the new total, never the old one.

A wallet:

- [ ] Google Pay in Chrome with a test card in the sandbox wallet:
      the sheet shows the cart's total; approving it places the order
      with "paid with Google Pay", `payment.method` `googlepay`.

## 3. On-farm pickup: the farm's schedule (W11d)

The schedule is staging's `PICKUP_SCHEDULE`; the order page offers only
its days and times.

- [ ] The pickup day list has exactly the schedule's days from
      tomorrow on, a Saturday or a holiday included if listed; each
      day's times appear as radios ("9 AM – noon") and change with the
      day.
- [ ] `/account/#orders`: an on-farm order's card has no "we'll
      confirm" note, and "Paid with: Visa ending 1111" under the
      totals.
- [ ] A time dropped from the schedule while the page is open: press
      Pay and a dialog says "That pickup time is no longer available",
      "Nothing has been charged.", with the open times as radios. "Use
      this time" puts it on the form and says "Pickup is now ... Pay
      to place your order." by the Pay button; "Never mind" and Escape
      leave the page as it was; with no times left, "Choose the drop
      site or delivery" leads to the choice of ways.

The farm can't keep a booked time:

- [ ] New on-farm order, paid. `bin/nff --staging orders deny <id>
      --reason "We're at the market that morning."`: customer gets
      "We can't make your pickup time" with "we can't be here for your
      pickup at <window> on <day>", "Here's why: ...", a "Reschedule
      or cancel" button and the line that cancelling is a full refund.
- [ ] `bin/nff --staging orders show <id>`: `question.kind` is
      `window`, `answeredAt` null, `fulfilment.state` still `agreed`.
- [ ] `bin/nff --staging jobs run` the day after its date: not closed
      while the question is open.
- [ ] Click "Reschedule or cancel" (works for a week): lands signed in
      on that order's card, which says "We can't make that pickup
      time: ... Please choose another day and time with Change, or
      cancel the order." Change and Cancel are offered even past the
      cutoff.
- [ ] Change the day or time (the form offers the schedule's) and
      save: "Order updated" email shows "When:"; farm gets "Pickup
      moved: <id>"; `question.answer` is `reschedule`;
      `fulfilment.state` stays `agreed`.
- [ ] Alternatively cancel from the card: `question.answer` is
      `cancel`; the order is refunded in full and `cancelled` at once
      (T1d); the cancellation email says the refund is on its way;
      the farm gets "Cancelled: <id>" saying there's nothing to run.
- [ ] `bin/nff --staging orders deny <id> --reason x` on a delivery
      order: refused with "Only an on-farm pickup has a time to give
      up."

The morning report:

- [ ] With an on-farm order whose time the farm gave up and the
      customer hasn't re-picked, within two days of its date, the
      first jobs run after 8:00 (the toolbar's "As 8:00 today") sends
      "Morning report: <today>" to ADMIN_EMAILS, the vital signs
      first, then one line per such pickup, once that day. If the
      schedule doesn't reach the week after next, it says so first,
      with `bin/nff schedule set <file>`.

## 4. The receipts

- [ ] `/account/#receipts`: one row per payment with the order, the
      day paid, the total, "Visa ending 1111" (or "Venmo"), the status
      and a Receipt link for a card payment. No Pay, Resend or "I paid
      by Venmo" anywhere on the account page.

## 5. Venmo

Needs the PayPal sandbox with Venmo enabled and the SDK's
`buyer-country=US`, which the page adds in the sandbox on its own.
Use a PayPal sandbox personal account as the buyer.

- [ ] The Venmo button opens PayPal's sandbox approval. Approve it:
      the success card says "paid with Venmo"; `payment.via` is
      `venmo`, `paypalOrderId` and `paypalCaptureId` set,
      `square.squareOrderId` set, `payment.squarePaymentId` set.
- [ ] The Square sandbox shows the order with an external "Venmo"
      tender for the total.
- [ ] Close the window during approval (Cancel): no order, no
      message; the form stays.
- [ ] Interrupt the second step: approve, then kill the network
      before the page's capture request lands. Within a minute the
      PayPal webhook's `PAYMENT.CAPTURE.COMPLETED` finishes it: the
      order exists with `paid`, the log's `paypal.webhook` line says
      `recovered: true`. The page, once back online, retries and finds
      the same order.
- [ ] `bin/nff --staging orders show <id>` a day later, with the
      checkout key gone from the store (the jobs sweep it;
      `checkoutsSwept` in the run report).

## 6. Refunds

- [ ] `bin/nff --staging orders refund <id> --amount 5 --reason
      "Short one dozen"` on a card order: prints "Refunded $5 of $X by
      Visa ending 1111"; `refund.amount` is 500, `total` false; the
      Square sandbox shows the refund; the customer gets Square's
      refund receipt. The account card says "Refunded $5 on <date>".
- [ ] Run it again: refused, "Already refunded $5 on <date>".
- [ ] `bin/nff --staging orders cancel <id> --reason-text "Test order."`
      on a paid Venmo order: PayPal refunds the capture and the Square
      tender is noted as refunded; `status` is `cancelled`,
      `refund.total` true, stock back, the fulfilment Canceled in
      Square, the customer emailed "Your refund is on its way".
- [ ] `bin/nff --staging orders cancel <id> --no-refund`: the
      email says "Nothing more will be charged"; `refund` stays
      unset.
- [ ] Refund a card payment in the Square sandbox dashboard instead:
      the `refund.updated` webhook writes `order.refund` with
      `source: square`; `bin/nff --staging orders show <id>` shows it
      within a minute.
- [ ] Refund a Venmo capture in the PayPal sandbox: the
      `PAYMENT.CAPTURE.REFUNDED` webhook writes `order.refund` with
      `source: paypal`.

## 7. Monitoring

Needs the healthchecks.io and Axiom variables from `docs/monitoring.md`;
without them the checks below still run, but nothing outside the
inbox hears.

- [ ] `GET https://www.northfosterfarm.com/api/health` answers 200
      with `ok: true`, a `jobs.lastRunAt` within the last 15 minutes,
      and `log: true`, `heartbeat: true` once the variables are set.
      `bin/nff health` prints the same.
- [ ] healthchecks.io shows the *Jobs* check going green every 15
      minutes and the three HTTP checks up.
- [ ] Axiom shows a `jobs.run` line every 15 minutes and an
      `order.paid` line for each order placed.
- [ ] 8:00: "Morning report: <today>" arrives every day, numbers first
      (placed, by card, by Venmo, declined, cancelled, refunded, open,
      mail failures, runs, errors, violations), then pickups (or "No
      pickups waiting on a decision"). It pings the *Alerts* check
      well; that check is green after 8:00.
- [ ] 18:00: "Tomorrow, <date>: N orders" arrives every day, grouped
      delivery, Scituate, on-farm, with pack lines; "Nothing due" on an
      empty day.
- [ ] Force a checkout failure (a wrong `SQUARE_ACCESS_TOKEN` on a
      preview): the customer sees the failure card and the farm gets
      "Site alert: order.create_failed" or "Site alert:
      client.checkout_failed"; the *Alerts* check goes red. A second
      failure within the hour sends no second email; `bin/nff jobs
      history` and the log show both.
- [ ] `bin/nff jobs history` lists the last runs with `ok` and their
      counts; a run with errors shows them indented.
- [ ] Take `RESEND_API_KEY` away in a preview and place an order: the
      order is paid and recorded, the customer gets no email but
      Square's receipt, and the farm alert `mail.failed` fires;
      `/api/health` goes 503 after the third such failure in an hour.

## 8. Nothing else changed

- [ ] A delivery order pays and is confirmed at once ("Your order is
      confirmed" with "When:"), and gets the cooler reminder the
      evening before (the toolbar's "As 18:00 today" the day before).
- [ ] A Scituate order likewise.
- [ ] The About page says "the orders page".

## Undo

- Take the account pages off: `accounts = false` in
  `config/_default/hugo.toml` and unset `ACCOUNTS_ENABLED`. Emails
  drop their account links; the deny email asks for a reply.
- Take Venmo off: unset `PAYPAL_CLIENT_ID`; the button disappears and
  nothing else changes.
- Close a test order: `bin/nff orders cancel <id> --reason-text "Test
  order."`, or `bin/nff orders delete <id>` to remove the record
  entirely (the money stays where it is).
