# The daily payments check

Nothing yet catches a payment that was never recorded as an order:
the detector that raises `orders.not_recorded` is #375, not built
(`docs/rollback.md`, "The one-tap rollback"). Until it lands, this
check stands in for it.

- **Who:** James.
- **When:** every morning from launch day, covering the day before.
  On a Monday, cover Friday to Sunday. About ten minutes.
- **Until:** #375 lands on production. Then delete this page and its
  links.

It reads production's orders store, so it runs on the Mac with the
Keychain's Netlify token. Every `bin/nff` command below only reads;
none asks for the typed confirmation.

## What exists and what does not

| To list | How |
| --- | --- |
| The day's Square payments (card, wallets) | No `bin/nff` command. Square Dashboard, Transactions |
| The day's Venmo captures | No `bin/nff` command. PayPal, Activity. Each also shows in Square as a payment with an external tender |
| Venmo payments approved, not yet captured | `bin/nff --production netlify blobs:list orders --prefix checkout/` |
| One order by id | `bin/nff --production orders show <id>` |
| The order a payment id belongs to | `bin/nff --production netlify blobs:get orders by-payment/<payment id>` |
| Every paid order | `bin/nff --production orders list --status=paid` |

`orders list` prints `id status total place date email`, where the
date is the delivery or pickup day, not the day it was placed, so it
cannot list one day's orders on its own. The farm's "New order
NFF-..." emails in sales@ are the day's list; `orders show` is the
truth for each.

Every site payment carries its order id, `NFF-YYYY-XXXX`:

- **Square:** the payment's note says "North Foster Farm order
  NFF-...", and the payment and its Square order carry the id as the
  reference id. The order's source is `northfosterfarm.com v<x.y>`.
  A payment with no NFF id and no such source was taken at a market
  or on the farm, not on the site: skip it.
- **PayPal:** the capture's description says "North Foster Farm order
  NFF-...", and its custom id and reference id are the order id.

## The routine

1. **Square.** In the Square Dashboard, Transactions, set the date
   range to yesterday. For each site payment, note the order id and
   the amount.
2. **PayPal.** In PayPal, Activity, the same day. For each Venmo
   payment, note the order id and the amount. It should also be in
   step 1's list, as an external payment under the same id; one
   missing from Square only is a `square.record_failed` (the order is
   recorded, the jobs retry), not a payment with no order.
3. **Match each payment to its order:**
   ```
   bin/nff --production orders show NFF-2026-AB12
   ```
   A match is a record whose payments include this one, for this
   amount, and that says `paid`, `fulfilled` or `cancelled` (with the
   refund). A changed order has several payments under one id, each
   on the record. With no id to go on, look the payment up by its
   Square payment id or PayPal capture id with `blobs:get orders
   by-payment/<id>`.
4. **Check the other way.** Each "New order" email from yesterday
   should have its payment in step 1 or 2.
5. **Venmo in flight.** List `checkout/` (table above). A key there
   is a Venmo approval waiting for capture; the webhook or the jobs
   finish it. One older than a day whose PayPal order shows a
   completed capture in step 2 is a payment with no order.

## On a mismatch

**A payment with no order.** Money was taken and nothing will be
packed. Act the same morning.

1. Look for an alert first: `order.id_collision` or
   `payment.unreconciled` in dev@ names the payment and says what to
   do (`netlify/functions/lib/alerts-guide.mjs`).
2. There is no `bin/nff` command to record an order by hand, and
   `bin/nff orders refund` needs a recorded order. So refund it where
   it was taken: a card or wallet payment in Square (open the
   payment, Issue refund); a Venmo payment in PayPal (open the
   payment, Refund; Venmo tells the customer), then the same amount
   on its Square copy so the books agree. Refunding only the Square
   copy of a Venmo payment moves no money: its tender is external.
3. Write to the customer from sales@: their payment went through but
   the order did not reach the farm, it is refunded in full, and how
   to order again. If they would rather not, the refund stands.
4. Note it in the gitignored `incidents/` directory: the order id,
   the payment id, the amount, the time. Tell the developers: a
   payment with no order is the bug #375 exists to catch. Two in a
   day, or one with no alert, is the "orders not recorded" emergency:
   maintenance mode on and `docs/rollback.md`, "At launch".

**An order with no payment.** Records are born paid, so this should
not happen. It points to a payment refunded or voided in the
dashboard by hand, or to a record written by mistake.

1. `bin/nff --production orders show <id>`: read its payments and
   history. Find each payment id in Square or PayPal.
2. If the money is there under another id or a later day, it is a
   match; nothing to do.
3. If it is truly unpaid, do not pack it. Ask the customer, then
   either take payment the usual way (they order again) or cancel:
   `bin/nff --production orders cancel <id> --no-refund
   --reason-text "..."`, which emails them. Tell the developers.

**An amount that differs** from the record (the customer changed the
cart between tries) is a `payment.unreconciled` case: refund the
extra in Square or PayPal, or with `bin/nff --production orders
refund <id> --amount 12.34` once the order is recorded, and write to
the customer.
