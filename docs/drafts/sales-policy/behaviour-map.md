# Behaviour map for the sales policy draft (#415)

Each B number marks a clause in `sales-policy.draft.md` that describes
what the site or the farm's tools do. "Verified" means I read the code
named. Nothing was run, since a cloud lane has no browser, server or
staging data.

| ID | Clause | Code | Status |
| --- | --- | --- | --- |
| B1 | An order is placed only after payment. Methods: card, Apple Pay, Google Pay, Cash App Pay, Venmo. | `assets/scripts/order/pay.js` (`initApplePay`, `initGooglePay`, `initCashAppPay`), `order-form.js` (`venmoCreate`), `netlify/functions/lib/checkout.mjs` | Verified |
| B2 | The farm may cancel and refund in full for a price mistake or an order it can't fill. | `templates.mjs` `CANCEL_REASONS` (`mistake`, `sold-out`), `admin.mjs` `cancelOrder` | Verified |
| B3 | An order keeps the prices and discounts of the day it was placed. | `assets/scripts/order/lib/validate.mjs:102-105` (`moneyOn(..., placed)`), `money-on.mjs` | Verified |
| B4 | Chickens are sold in weight ranges, one price each. No repricing after weighing. | `data/catalog.json` (SKUs such as `NFF-CHK-WHL-25-29`), no weight-based pricing anywhere in `lib/` | Verified by absence |
| B5 | Bulk tiers apply to every order. The highest tier applies. Discounts never combine. | `data/delivery.json` `bulkTiers`, `assets/scripts/order/lib/totals.mjs` | Tiers verified. "Never combine" is the live policy's claim. I did not trace it in `totals.mjs`. |
| B6 | Stock is checked at checkout. A near-simultaneous last pack can oversell. The farm cancels and refunds. | `netlify/functions/lib/stock.mjs` (header comment, `just sold out`), `templates.mjs` `sold-out` | Verified |
| B8 | Change or cancel from the account page until the cutoff. Delivery Wednesday noon. Both pickups 11:59 PM the day before. | `netlify/functions/lib/jobs.mjs` `cutoffAt`, `account.mjs` `actionable`, `canCancel`, `canChange`, `data/delivery.json` `delivery` | Delivery and on-farm verified. Scheduled pickup uses `eveningBefore` from `events.mjs`, not read. |
| B9 | Change items reprices and charges or refunds the difference. | `assets/scripts/account/main.js` (the `/order/?edit=` link), `netlify/functions/lib/edit.mjs` | Verified |
| B10 | An open farm question keeps change and cancel open past the cutoff. | `account.mjs` `actionable` (`questionOpen`) | Verified |
| B11 | After the cutoff the customer cannot cancel or change. | `account.mjs` `cancelOrder` returns 409 | Verified. "We'll do what we can" is policy, see Q7. |
| B12 | Cancel refunds in full to the way they paid, at once. Venmo goes through PayPal. | `account.mjs` `cancelOrder` calling `admin.mjs` `cancelOrder` and `refundOrder`, `settle.mjs` (PayPal's word is the customer's money) | Verified. "A few business days" is the processor's timing and the live email wording. |
| B13 | A farm cancel refunds in full, less a kept fee. | `admin.mjs:413-420` | Verified |
| B14 | A failed automatic refund is flagged and the farm refunds by hand, telling the customer. | `account.mjs:253-290` (`cancelRequested`, `orderCancelled`, `farmRefundNeeded`) | Verified |
| B15 | A lower total after a change refunds the difference. | `edit.mjs` `refundOrder` | Verified |
| B16 | A missed delivery for a customer cause keeps the delivery fee (including the outside-area charge). The farm may waive it. A second attempt charges again. The order is held 7 days. | `admin.mjs:505-545` (`attempted.fee`, `waived`, `CUSTOMER_CAUSES`), `records.mjs` `keptFee`, `edit.mjs` `creditOn`, `jobs.mjs` `holdExpired`, `data/delivery.json` `holdDays` | Verified |
| B17 | "Report a problem" records a request. The farm answers by hand, with no automatic email or refund. | `account.mjs:~712` (`returns`), `admin.mjs` `resolveReturn` | Verified. The 48 hours, and the remedies, are Q2 to Q4, not behaviour. |

## Clauses that are not behaviour

These are policy choices, each tied to a question: the 48-hour window
(Q2), the three remedies (Q3), photos (Q4), no repricing after
weighing (Q5), food safety text and the disclaimer (Q6), after-cutoff
(Q7), no substitutions (Q11), price in US dollars and tax (Q10).
