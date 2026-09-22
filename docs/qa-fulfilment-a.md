# QA guide: fulfilment step A

What to try after PR #106 ships, what should happen, and where to look
when it does not. Work through it with a real card or a $1 test item
and cancel or refund at the end. Every check names the command or
page that shows the truth; the emails are the second witness.

Before starting, on Netlify: `ACCOUNTS_ENABLED=true`,
`RESEND_WEBHOOK_SECRET` (the Svix secret of the Resend webhook),
`RESEND_READ_KEY` (a key that can read received mail). In Resend: a
webhook for `email.received` pointed at
`https://www.northfosterfarm.com/api/venmo/inbound`. Without the
first, emails carry no links to the account pages and the deny email
asks for a reply; without the other two, Venmo notifications are
ignored (the endpoint answers 401) and only the manual path works.

Read a record at any point with `bin/nff orders show <id>`. The
`history` list is the order's diary; `emails` is every send, keyed by
template, so "did it send" is a lookup, not a guess.

## 1. Sign in and the header

- [ ] Home page, signed out: the header shows **Sign in** between
      About and Order.
- [ ] `/login/`: the intro paragraph sits above two cards, "Send me a
      magic link" and "Find my order". Each is a label column and a
      field column, plain inputs, one button under the field column.
      The header still shows Sign in, marked as the current page.
- [ ] Submit an empty email: red field and a message under it, button
      stays in place.
- [ ] Submit your email: the card is replaced by "Check your email"
      naming the address. The email is "Your secure sign-in link to
      North Foster Farm"; the link signs you in and lands on
      `/account/`. Following it a second time lands on `/login/` with
      "already used" explained.
- [ ] Signed in, the header shows **Account** with Orders, Invoices,
      Settings, Sign out. On `/account/` too.
- [ ] Four link requests within 15 minutes: the fourth answers the
      same "Check your email" but sends nothing (rate limit; the
      earlier link still works).

## 2. Settings: reminder preferences

- [ ] `/account/#settings` has "Email reminders" with two checked
      boxes. Untick payment, Save. Reload: still unticked.
- [ ] `bin/nff customers show <email>` shows
      `reminders: { payment: false, delivery: true }`.
- [ ] Place an unpaid order as that customer and wait an hour past
      placing (or run `bin/nff jobs run` after the hour): the report
      lists `muted: [{ id, kind: "payment" }]` and no reminder is sent.
      The order still abandons at its cutoff.
- [ ] Tick it back on; the next due reminder sends.

## 3. On-farm pickup: the farm's agreement

Place an on-farm order for a date a few days out.

- [ ] Success card says the pickup time is a request and the order is
      confirmed once paid and the time is set.
- [ ] Customer email "One more step: pay for your order" has the
      button "Pay and complete your checkout", the Venmo paragraph,
      the "We'll check to make sure..." paragraph, and "Requested:"
      (not "When:") in Order details, plus an outline "View or edit
      this order" button.
- [ ] Farm email "New order ... on-farm pickup" carries "Pickup time:
      **Requested, not yet confirmed**" and the confirm and deny
      command lines.
- [ ] `bin/nff orders show <id>`: `fulfilment.state` is `requested`.
- [ ] `/account/#orders`: the card says "Pickup time requested. We'll
      confirm it by email."

Paid first:

- [ ] Pay the invoice. Customer gets "Payment received" naming the
      day before the pickup; no "confirmed" email yet. Farm gets
      "Paid: order ...".
- [ ] `bin/nff orders confirm <id>`: customer gets "Your order is
      confirmed" with "Your payment of $X came through and your pickup
      time is set" and "When:" in Order details. `fulfilment.state` is
      `agreed`, `agreedAt` set.
- [ ] Run confirm again: nothing sent, nothing changed.

Agreed first:

- [ ] New on-farm order, `bin/nff orders confirm <id>` while unpaid:
      no email. Then pay: "Your order is confirmed" arrives once.

Denied:

- [ ] New on-farm order. `bin/nff orders deny <id> --reason "We're at
      the market that morning."`: customer gets "One more step: pick a
      new pickup time" with the bold "The morning of ... doesn't work
      for us.", "Here's why:" in bold italic, your paragraph, a "Pick
      a new time" button, and (unpaid) the paused-reminders line.
- [ ] `bin/nff orders show <id>`: `question.kind` is `window`,
      `answeredAt` null.
- [ ] `bin/nff jobs run` after the reminder hour: no reminder, no
      abandon for that order while the question is open.
- [ ] Click "Pick a new time" (works for a week): lands signed in on
      that order's card, which says "We can't do that pickup time: ...
      Please choose another day or window with Change, or cancel the
      order." Change and Cancel are offered even past the cutoff.
- [ ] Change the window or date and save: "Order updated" email shows
      "Requested:"; farm gets "Pickup time to confirm: <id>";
      `question.answer` is `reschedule`; `fulfilment.state` back to
      `requested`. Reminders and the cutoff run again on the new date.
- [ ] Alternatively cancel from the card: `question.answer` is
      `cancel`; the cancellation email arrives.
- [ ] Alternatively `bin/nff orders confirm <id>` after a deny: the
      time works after all; `question.answer` is `confirmed`,
      `by: farm`.
- [ ] `bin/nff orders deny <id>` on a delivery order: refused with
      "Only an on-farm pickup needs confirming."

The morning report:

- [ ] With an on-farm order still `requested` (or denied and not
      re-picked) within two days of its date, the first jobs run after
      8:00 sends "Pickups to confirm: <today>" to ADMIN_EMAILS, one
      line per order with the confirm command, once that day. Nothing
      is sent on a day with no such order.

## 4. Find my order and resending the invoice

- [ ] Signed out, `/login/`, Find my order with the right email and
      an unpaid order's number: "Check your email" naming the address.
      The email is the pay-link email again, with the Pay button and
      a "View or edit this order" button that signs you in and lands
      on that order's card.
- [ ] Same with a paid order: a plain sign-in email whose link lands
      on that order's card.
- [ ] Wrong email for the order, or a made-up number: the same
      "Check your email" card, and nothing arrives.
- [ ] Type the number in lower case or with the hyphens missing: still
      matches.
- [ ] Signed in, an unpaid order's card has **Resend the invoice**:
      pressing it sends the pay-link email again. The sixth press on
      one order (counting Find my order sends) says "We've sent that a
      few times already." `bin/nff orders show <id>` lists
      `invoiceResent-1` ... `invoiceResent-5` under `emails`.

## 5. Venmo by hand

- [ ] An unpaid order's card says "Not final until it's paid. Pay the
      invoice, or send $X to @northfosterfarm on Venmo with <id> in the
      note and press "I paid by Venmo" below." and has that button.
- [ ] Press it: the card says "Thanks, we're checking Venmo for your
      payment." Farm gets "Venmo to check: order <id> — $X" with where
      to look and the two commands. `paymentPending.source` is `venmo`.
- [ ] `bin/nff jobs run` past the reminder hour: no reminder, no
      abandon while held.
- [ ] Press again: "We're already looking for that payment."
- [ ] `bin/nff orders unpaid <id>`: hold lifted, `history` ends
      `payment.unclaimed`, reminders resume.
- [ ] Press again, then `bin/nff orders paid <id> --via venmo`: order
      `paid`, `payment.via` is `venmo`, the customer's confirmation (or
      "Payment received" for a requested on-farm window) arrives, and
      the Square invoice shows Canceled in the Square dashboard.
- [ ] `bin/nff orders paid <id>` with no flag records `via: cash` and
      also cancels the invoice.

## 6. Venmo by notification

Needs the webhook and the two Resend variables. Use a real $1 payment
to @northfosterfarm with a test order's number in the note; cancel the
order afterwards and refund the dollar by hand.

- [ ] Within a minute or two of the Venmo email arriving, the order is
      `paid` with `payment.via: venmo` and `history` shows
      `source: venmo`; the customer's email arrives; the Square invoice
      is cancelled. Netlify function log for `venmo-inbound` shows
      `venmo.received ... matched: true`.
- [ ] `bin/nff venmo list` shows the payment as `applied` with its
      19-digit transaction id.
- [ ] Pay $1 with a note that names no order (a market-style payment):
      nothing happens to any order; `bin/nff venmo list` shows it
      `unmatched`; the first jobs run after 18:00 sends "Venmo payments
      with no order: <today>" as a table, once, and the record gains
      `reportedAt`.
- [ ] Pay the wrong amount for a real order number: not applied,
      reported that evening with "names <id> ($X due)".
- [ ] A Venmo email that is not a payment (a verification, a profile
      change) does nothing; the function log says `not a payment`.
- [ ] Netlify function log after a webhook: a 401 means the secret is
      wrong or missing; a 502 means the read key cannot fetch the
      message (Resend retries those).

## 7. Nothing else changed

- [ ] A delivery order is born `agreed`, pays and confirms exactly as
      before, with the Venmo paragraph as the only new line in its pay
      link, and gets the cooler reminder the evening before.
- [ ] A Scituate order likewise.
- [ ] The About page says "the orders page".

## Undo

- Take the account pages off: `accounts = false` in
  `config/_default/hugo.toml` and unset `ACCOUNTS_ENABLED`. Emails
  drop their account links; the deny email asks for a reply.
- Stop Venmo notifications: delete the Resend webhook, or unset
  `RESEND_WEBHOOK_SECRET` (the endpoint then refuses everything).
- Close a test order: `bin/nff orders cancel <id> --refund` after
  refunding in Square by hand, or `bin/nff orders delete <id>` to
  remove the record entirely.
