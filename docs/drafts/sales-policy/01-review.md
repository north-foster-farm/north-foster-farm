# 1. Review of what exists (#415)

Read on 2026-10-24 at `next` (c5283319), then reworked against PR #416
(`lane/writer1-policy`, 7d62dcc8), whose privacy and delivery text is
the current wording. Nothing here is live text. It is a map for James.

## Where policy-like text lives today

| Place | What it says about sales, cancel or refund |
| --- | --- |
| `content/delivery-policy.md` | Everything: prices, payment, delivery, pickup, changes, cancellations, refunds, consent. |
| `content/privacy.md` | Data only. Line 125 mentions "a note that you've seen the delivery policy on the order form". |
| `content/accessibility.md` | Links to `/delivery-policy/#delivery-area`. |
| `layouts/partials/order/wrap.html:26` | "By placing an order you agree to our delivery policy." The only agreement. |
| `layouts/partials/order/fulfilment.html:3` | Links the delivery policy from the pickup or delivery choice. |
| `layouts/account/single.html` (`tpl-return`, `tpl-cancel`) | "Report a problem" and "Cancel this order?" Neither links to any policy. |
| `netlify/functions/lib/templates.mjs` | Confirmation, cancel and missed-delivery emails state refund facts. No email links a policy. |
| Packing slip (`slips.mjs`, `packing.mjs`) | No policy text or link. |
| `config/_default/menus.toml` | Footer link "Delivery" only. The header has no policy link on purpose (#267). |
| `layouts/index.llms.txt:21` | Lists `/delivery-policy` only. |
| `netlify.toml:229` | `/local-delivery-policy` redirects to `/delivery-policy`. |

There is no sales, refund or return policy anywhere. The delivery
policy carries the sale rules by accident, which is why its own
intro says its last sections "apply to every order".

## What the code does (the facts a policy can rely on)

Each is a behaviour. The clause IDs (B1, B2 ...) are used in the draft
and listed in `behaviour-map.md`.

- Order placed only when payment succeeds. Payment: card, Apple Pay,
  Google Pay, Cash App Pay (Square), Venmo (PayPal).
- Prices and bulk tiers are those in force the day the order was
  **placed**, even for later changes to it. The Jan 1 2027 change
  (delivery minimum $40 to $50, the $5-off-$50 tier ends) therefore
  applies to orders placed on or after that day, not to orders for
  delivery on or after it.
- Whole chickens are sold in weight ranges, one fixed price per range.
  Nothing in the code reprices after weighing.
- Customers can cancel or change an order from the account page until
  the cutoff (delivery: Wednesday noon. Pickup: end of the day before).
  Cancel refunds everything paid, less a kept delivery fee, to the way
  they paid, right away. If the automatic refund fails, the order is
  flagged and the farm refunds by hand.
- "Change items" on the account page reopens the order page, prices
  the change, and charges or refunds the difference.
- An open question from the farm (a missed delivery) keeps cancel and
  change open past the cutoff.
- Missed delivery for a customer cause (no cooler, no access, address
  not found): the delivery fee (which includes the outside-area charge)
  is kept unless the farm waives it with a note. The order is held
  7 days. If the customer has not chosen by then, the job cancels and
  refunds the items. A second attempt charges the fee again.
- Farm-caused misses (weather, delay) never keep the fee.
- Sold-out: stock is checked at checkout and at each change. Two orders
  in the same second can still oversell. The farm then cancels with the
  "sold out" reason and refunds in full.
- A booked pickup time the farm cannot keep is cancelled and refunded
  in full. Nothing is denied.
- A fulfilled (handed over) order cannot be cancelled. The farm
  refunds or settles a return by hand.
- "Report a problem" records a return request. The farm answers it by
  hand. No email goes out from the system, and no refund runs
  automatically.
- Refunds are checked daily against Square or PayPal. One pending more
  than 5 days alerts the farm.
- Discount groups (Friends and family 10%, Wholesale 20%), discount
  codes and passes exist. Passes (waive the minimum, sometimes the fee)
  are shown to customers as ordinary codes.

## Where today's text and the code disagree

| # | Text says | Code does | Severity |
| --- | --- | --- | --- |
| D1 | Order page: you agree to the **delivery policy**. | The delivery policy's consent covers every order, including pickup. Pickup-only customers agree to a policy named for delivery. | Wording and structure. |
| D2 | "To change what's in an order, cancel it and place a new one." | The account page has **Change items**, which reprices and charges or refunds the difference (`edit.mjs`, `canChange`). | Text is stale. |
| D3 | Delivery area section: "You may also request a refund for the order in full." | A missed delivery keeps the fee. The "On delivery day" section says so and the code does it. The two sections contradict each other. | Fix in the draft. |
| D4 | Fee kept if no cooler, no access or no findable address. | Same, but the farm may waive it with a note, and the kept fee includes the outside-area charge. Policy mentions neither. | Add one sentence each. |
| D5 | "If something is wrong with your order, tell us ... and we'll make it right." | "Report a problem" only records a request. There is no window, no remedy rules and no email. James answers by hand. | A promise with no rules. Needs Q2 to Q4. |
| D6 | "Until the cutoff" for change and cancel. | Also open past the cutoff while a farm question waits on the customer. | Harmless, worth one sentence. |
| D7 | Silent on sold-out items. | The farm cancels and refunds in full. Overselling is possible. | Add. |
| D8 | Silent on weight ranges. | One price per range, no repricing. | Add, needs Q5. |
| D9 | Silent on which prices apply across the Jan 1 2027 change. | Prices of the day the order was placed. | Add. |
| D10 | Silent on cancel after the cutoff beyond "call, text or email us". | Customer cannot cancel. Farm can. No rule exists. | Needs Q7. |
| D11 | Silent on a cancelled fulfilled order. | Cannot be cancelled. Handled as a return by hand. | Folded into D5. |
| D12 | Silent on how a failed automatic refund is handled. | Flagged, farm refunds by hand, customer told. | Add one sentence. |
| D13 | Silent on discount codes and groups. | Never combine (policy says so). Codes and groups exist. | Needs Q9. |
| D14 | Policy intro and `description` front matter promise "changes, cancellations, and refunds" under a delivery title (#416 reworded both, same promise). | Parent-child fix, see 02. | Structure. |
| D15 | `privacy.md:125` (same line in #416) calls the stored note "the delivery policy". | Will name the sales policy once D1 is fixed. | Wiring (section 4). The edit must bump #416's "Last updated October 24, 2026" line. |

#416 is a wording pass and fixed none of D1 to D15.
D3 still stands in its "Delivery area" section. D2's sentence is
unchanged ("To change what's in an order, cancel it and place a new
one"). The delivery policy line numbers I gave earlier moved by a few
lines, and no finding changed.

Checked and consistent: the delivery cutoff (Wednesday at noon), the
pickup cutoff (end of the day before), the 7-day hold, farm cancellation
refunds in full, refund to the original payment method, and the list of
payment methods.

## Not checked, because it needs a person or a browser

- Whether any sales tax applies or is charged. I found no tax code.
- What a customer sees at each step (needs a browser).
- Square and PayPal current merchant terms (see Q12).
