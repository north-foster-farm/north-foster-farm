# The order form at `/order`

The form takes an order, recomputes every figure on the server, takes
the payment on the page, and only then records the order: a Square
order with its fulfilment and the payment against it. Until the money
is in, the order is a draft in the customer's browser and nothing
else. Cards and the wallets (Apple Pay, Google Pay, Cash App Pay) go
through Square's Web Payments SDK; Venmo goes through PayPal's button
and is recorded on the same Square order as an external tender.

```
/order  (Hugo page, catalog and terms inlined as JSON)
   │  GET  /api/dates            dates and the server clock, on load
   │  GET  /api/checkout/config  the SDK ids for this deploy
   │  POST /api/orders           validate, recompute, take the money,
   ▼                             record the order
netlify/functions/{dates,checkout,orders}.mjs
   ├── lib/checkout.mjs   the two roads to a paid record
   ├── lib/square.mjs     customer → order → payment; refunds
   └── lib/paypal.mjs     PayPal order → capture; refunds; webhooks
```

## Sources of truth

- `data/catalog.json`: prices, SKUs and stock. Read by the page, the
  functions and `bin/stock`.
- `data/delivery.json`: terms, date rules, holidays and the delivery
  area. Read by the page, the functions and the policy page.
- `data/discount-codes.json`: the discount codes, `{ code, label,
  off }` with `off` in whole dollars. Read by the functions; the page
  gets only their SHA-256 hashes.

Pure logic lives in `assets/scripts/order/lib/*.mjs` and is imported by
both the browser bundle and the functions, so a price, a cutoff or a
ZIP rule exists once. `npm test` covers it.

### The catalog

`data/catalog.json` is price list 2026-v9 (its `version`, with its
`date`, 2026-10-21; James, 6305650920): 37 SKUs in 11 render groups,
every item in one array with an `inStock` flag. The identifier is the
SKU. One sold by weight carries its tier's bounds in tenths of a
pound, two digits each, inclusive: `NFF-CHK-WHL-20-24` is
"2.0 – 2.4 lbs", and an "and up" tier tops out at `99`. Eggs and
sausage carry no bounds (`NFF-CHK-EGG-LG`, `NFF-CHK-SAUMPL`). The
SKUs took this form on 2026-10-21 (#267, #287); `docs/sku-map.csv`
lists each old SKU with its new one and the date, and
`test/sku.test.mjs` holds the catalog to both. Past orders still name
the old SKUs: the order page maps an old one in a Reorder link
(`?add=`) or a saved cart to its new one through
`data/skuAliases.json`, a copy of the map the test keeps equal to it,
and a SKU it can't name gets "Some items from that order have changed.
Please add them again.", never the SKU itself. That is all the
aliasing there is: an order holding a SKU the catalog doesn't know
can't be changed (`canChange` is false), only cancelled, so a save
can never drop and refund the line. **From 1 January 2027
a SKU never changes** (James, 6305014532): moving a tier boundary is a
new variation with a new SKU, a row in the map, and the old one
`archived`. `squareVariationId` is null
until the catalog is seeded into Square; while it is null the order
handler sends an ad hoc line item with the same name and price, so the
form works before the seed and switches to catalog lines after it.

No price carries a unit word (#267, James, 6305365293): every product
reads name, tier, price, as in "Wings · 1.0 – 1.9 lbs · $10". The
catalog has no `unit` field. An item's `note` follows the price where
it says something the tier doesn't: "Grade A" for eggs, the links per
pack for sausage (6305373706).

A line is named "Group, label" ("Wings, 1.0 – 1.9 lbs") in the cart,
the stored order, the emails and the errors. A group with `"lines":
"name"` uses each item's own `name` instead: Other Items, whose lines
read "Livers, 1.0 – 1.4 lbs" and "Feet, 1 lb avg." (#267). The same
name is the item's row on the order page and in search, where a cut
shows its tier. `indexCatalog` works out `lineName`, and `row` for
the grouped cart; `order/groups.html` gives the templates `row`.

An item with a `grade` (the eggs, "Grade A"; #300, Rhode Island's
250-RICR-40-20-7) says it before its label wherever a line is named:
"Eggs, Grade A Large" in the cart, the stored order and so the
emails, the account page and the pick list, and search. Square names
a line sent with its variation id, as in production, from its own
catalog, so the egg variations there are named "Grade A Large",
"Grade A Medium" and "Grade A Small" (a step in Square, #300);
`squareName` only names a line sent without one. The order
page's row keeps "Large" and shows the grade where a note goes. Orders
placed before keep the names they were stored with. The catalog's
`grade` is the one source (`graded` in `lib/catalog.mjs`).

Pack weights (#267, James, 2026-10-20 and 21). The smallest pack sold
is 1.0 lb; anything lighter is a family pack, kept by the farm and
never entered into stock. Whole chickens and sausage are exempt. A
pack's weight rounds to the nearest tenth of a pound (.x5 up) and
matches the tier whose name holds it: 1.25 lbs is 1.3, "1.3 – 1.4
lbs". The names govern, and the SKUs carry the same bounds. No
customer page states the minimum (James, 6305274262).

The Square import CSV is generated from the same table and reads this
file for availability, so the two cannot drift.

### Stock

`bin/stock` walks the catalog one keypress per item, shows a diff,
writes the file, and offers to commit and push. Pushing `main` deploys.
That flag is the coarse switch. On top of it the `stock` store keeps a
count of packs per SKU (`counts`), set by the CLI and moved by orders:
down when an order is paid, back up when it is cancelled. `GET
/api/stock` gives every item's `{ inStock, available }`; the page asks
on load, on return to the tab, every two minutes and before paying,
marks rows out of stock, shows "N left" at five or fewer, clamps the
cart and says so. The order handler checks the same counts and
answers `422` with `lines.<sku>` errors plus the fresh `stock`.

Square's count wins (#267, James, 6304555099). Every sale, on the
phones at a market or on this site, and all stock live at one Square
location, North Foster Farm, which is `SQUARE_LOCATION_ID`. Square's
`IN_STOCK` counts there (`inventoryCounts` in `lib/square.mjs`, at
most 1.5 s) are what the page and the order check sell by, wherever
Square counts a SKU. Each order and edit check reads them fresh and
logs `stock.checked` with `via: "square"` or `"store"`. `/api/stock`
is public, so it reads them from a snapshot in the store (`square`,
with its time), refreshed at most every 15 s, so that a run of calls
cannot spend the token's rate limit, which the payment calls share;
in production it also answers 429 past 120 calls from one address in
ten minutes.

A SKU Square doesn't count (tracking off at the farm) keeps the flag
and the store's count. So does a variation that tracks inventory but
has no count entered: the farm enters a count for every variation it
tracks. If Square fails or is slow, the read logs
`stock.square_unread` and the store's counts stand, so set them with
`bin/nff stock set` as before. Website orders still move the store's
counts; no SKU is counted twice, since each sells by Square's count or
the store's. The sandbox's item library has its own ids, so staging
and development never ask and go by the store alone.

### Restock types

Every catalog item has a `restock` type (#267, James, 2026-10-20). It
is presentation only: Square stays the database for names, prices
and counts, and the field moves to Supabase with the dashboard later.
It says what an item out of stock shows in place of its quantity:

| `restock` | Out of stock, it says |
|---|---|
| `seasonal` | "Back in spring", the season from `restockSeason` |
| `soon` | "Returning soon" |
| `hiatus` | "On hiatus" |
| `discontinued` | "Not available" |
| `archived` | Nothing: hidden everywhere, whatever the stock |

Stock wins over every type but `archived`: an item in stock sells
normally. An item with no type is hidden while it is out. Today
(James, #274, 6330468558): large eggs and feet `soon`; medium and
small eggs and both sausages `hiatus`; whole chickens from 5.0 lbs,
boneless breasts from 1.5 lbs, bone-in thighs from 2.0 lbs, wings
from 2.0 lbs and tenders from 1.5 lbs (#303) `discontinued`; Cornish hens and ground chicken
`archived` (2026-v9); every other item `seasonal` with
`restockSeason: "spring"`.
Switching one is a catalog edit and a deploy. The labels live in
`layouts/partials/order/restock-label.html`.

The order page's **Show** control (`order/restock.js`, James,
6303649455) is a radio group (`role="radiogroup"`, named "Show"
for a screen reader, with no visible label since #274) alone and
centered at the top of the catalog, drawn as the cart's segmented
control, the chosen side
lighter: **"In stock"**, the default, shows only what is in stock;
**"Full catalog"** also shows every out-of-stock item with a type.
The choice is remembered on the device (`localStorage`, key
`nff-order-in-stock-only`; blocked storage leaves "In stock").
Under Full catalog an out-of-stock item is greyed, with its label in
the stock note and no quantity control; its inputs are disabled, so
it cannot be added (`?add=` of one says "Not available"). A
category with nothing showing goes, with its sidebar link, and comes
back when Full catalog shows it. The build marks a row out from the
catalog flag (`data-out`, hidden) and `/api/stock` takes over when
it answers.

Search lists every item but an archived one, whatever Show says:
one out of stock shows its label in place of its price, greyed, and
its Add is off. The build leaves archived items out of the page,
search and `llms.txt`; `/api/stock` reports them out and the
validator refuses them.

**Archived with stock.** Each `/api/stock` read looks for an archived
item stock has on hand (a count above 0, or flagged in stock and not
counted). It emails `FARM_NOTIFICATIONS_EMAIL`, and no one else, once
a product a day ("Hidden but in stock", `stock/archived/<day>` in the
jobs store), and the morning report lists each one until the type is
changed or the count zeroed. `test/restock.test.mjs` holds it.

**Archived in a paid order** (James, 6305650920). An archived item
stays in the catalog, so a paid order that holds one still names it.
Changing that order keeps the line: `validateOrder` takes `held`, what
the order already holds, and lets a line that sold out or was archived
since keep up to that many, never more ("... is not available."
past it). On the page, the product list carries every archived item
in a hidden "Not available" section (`order/archived.html`,
never in the sidebar or search). Edit mode shows the rows the order
holds, labelled "Not available", and caps each at its held
quantity. A cancel needs nothing: it doesn't read the catalog.
`test/edit.test.mjs` and `e2e/archived-edit.spec.mjs` hold it.

## Rules

Money is integer cents, in this order. Client figures are display only.

```
subtotal    = Σ qty × unitPrice
bulk        = highest tier where subtotal >= threshold   (never stacked)
group       = customer's discountGroup percent × subtotal (signed in)
code        = a known discount code's `off`, capped at the subtotal
discount    = max(bulk, group, code)                      (never stacked)
baseFee     = delivery && subtotal < 150.00 ? 5.00 : 0    (pre-discount)
areaFee     = delivery && ZIP unlisted (other RI) ? 3.00 : 0 (never waived)
deliveryFee = baseFee + areaFee
total       = subtotal - discount + deliveryFee
minimum     = delivery only: subtotal - discount >= 40.00
```

`money.discountGroups` in `data/delivery.json` names the groups
(`friends` 10%, `wholesale` 20%). A customer's group lives on their
record and is set by the CLI; the order handler reads it from the
session, never from the payload. `totals.discountLabel` names whichever
discount applied and is what every surface shows; `discountTier`,
`discountGroup` and `discountCode` say which kind it was.

A discount code is typed into the cart and sent as `code` on the
payload. The server looks it up in `data/discount-codes.json`
(`findCode` in `lib/validate.mjs`; upper case, letters and digits); a
code it does not know is harmless, the order goes through without one.
The page cannot see the codes, only their hashes (`crypto.SHA256` in
`layouts/partials/order/form.html`), so it can say "Code applied: $5
off" or "We don't know that code" without listing them. `EGGBOI` is a
joke that lives on the page alone: the cart shows a discount growing
by $40 a minute for as long as the page is open, and nothing else
changes, since the server has never heard of it.

Dates are computed at request time in `America/New_York`, holidays
skipped rather than shifted:

- On-farm: every day in the farm's pickup schedule from tomorrow on,
  each with its windows (W11d). The schedule is the only rule: no
  weekday, holiday or horizon test. It lives in the `PICKUP_SCHEDULE`
  environment variable, one date per entry (new lines, `,` or `;`),
  each with its windows: `2026-10-06 09:00-12:00 13:00-17:00`
  (`lib/schedule.mjs`; `#` starts a comment). The functions read it
  on every request (`lib/pickups.mjs`); the page never holds it, and
  gets the windows from `/api/dates`. There is no default: every
  build runs `npm run check:schedule` (`bin/check-schedule.mjs`) and
  fails on a missing, broken or past schedule, or one that doesn't
  reach the week after next, which leaves the last good deploy live.
  `bin/nff schedule check <file>` runs the same check, and
  `bin/nff schedule set <file> --staging|--production` sets the
  variable (then deploy; `PICKUP_SCHEDULE_HOOK`, a build hook in the
  env file, starts one). The morning report warns while the schedule
  runs short.
- Scituate: the next two Saturdays on or after 17 October 2026 whose
  cutoff has not passed: the end of Friday (`scituate.cutoffWeekday`
  and `cutoffHour`, 24 being midnight). Customers can change or cancel
  until then too.
- Delivery: the next two non-holiday Thursdays whose Wednesday-noon
  cutoff has not passed. The cutoff is inclusive.

Delivery ZIPs: on the approved list passes; an unlisted `028`/`029` ZIP
passes and flags the order for follow-up; anything else is blocked.

The customer: a first and last name (kept together as `name` as well,
which records from before the split carry alone), an email, a phone
number (required, ten digits or eleven with a leading 1) and whether
they prefer a text or a call (`customer.contact`, `text` or `call`).
The preference and the on-farm window go to Square in the fulfilment
note. On-farm pickup asks only for the day and the window; delivery
asks for the address, the town, the ZIP, where the cooler will be and
optional notes.

The payment rides on the payload as `payment` and `attempt`:

```
{ method: "card" | "applepay" | "googlepay" | "cashapp",
  sourceId, verificationToken? }              one request, paid
{ method: "venmo", stage: "create" }          -> { paypalOrderId }
{ method: "venmo", stage: "capture", paypalOrderId }   paid
```

Server responses the client acts on: `200` paid (or, for Venmo's first
stage, the PayPal order id), `402` declined with `{ code, message }`,
`422` field errors or a total that no longer matches (`errors.total`
plus the recomputed `totals`), `409` a stale date with a fresh list or
a payment that does not belong to this order (`errors.payment`),
`503` transient and retried, `502` permanent, `204` dropped silently
(honeypot or rate limit). The customer authorised the figure on their
screen, so a `claimedTotal` that differs from the recomputed total is
refused rather than charged.

## Recovery without a datastore

1. The whole form autosaves to `localStorage` on every change and is
   restored on return.
2. One submission key is minted per draft and kept across retries,
   with an `attempt` number beside it. Every processor call derives
   its idempotency key from the pair (`attemptKey` in
   `lib/checkout.mjs`: 32 hex characters, then a suffix per step), so
   a retry of one attempt finds what it already made and never
   double-charges. A decline, or a change to the form after the
   processor was asked, bumps the attempt: fresh keys, a fresh Square
   order.
3. The function retries 429, 5xx and network errors three times.
4. A `503` or a lost connection is sent once more, three seconds
   later, under the same keys, while the button still spins its egg
   (a wallet or Venmo shows a "Placing your order" notice instead).
   Nothing retries in the background or on the next visit (#154).
5. If that second send fails too, or on any permanent failure, the
   customer sees the order as selectable text, a prefilled `mailto:`
   and the phone number. Every terminal failure is one structured
   `console.error` in the function log, with the whole order, so
   nothing is lost.
6. A declined card is not a failure: the message shows under the card
   form and the customer tries another card or Venmo. The Square order
   made for the declined attempt is cancelled so the dashboard never
   shows an order nobody paid for.

## The page

`scripts/order/pay.js` owns the payment section
(`layouts/partials/order/payment.html`). It fetches
`/api/checkout/config` and loads the SDKs once the section is near
the screen or focused: Square's from `web.squarecdn.com` (sandbox:
`sandbox.web.squarecdn.com`), PayPal's from `www.paypal.com/sdk/js`
with `enable-funding=venmo`, `disable-funding=paylater,card,credit`
and, in the sandbox, `buyer-country=US`. The card fields are Square's
iframe; Apple Pay, Google Pay and Cash App Pay appear when the browser
and the deploy support them; the Venmo button appears when PayPal is
configured and the SDK says it is eligible. A processor that is not
configured is simply absent, and with neither the section says online
payment is unavailable.

The form validates before any processor is asked (`prepare()`,
synchronous, because Apple Pay must tokenise inside the click), and
checks stock too where it can wait (`prepareAsync()`). The card is
tokenised with the customer's details for the bank's verification
(`card.tokenize(verificationDetails)`; Square's own step, no separate
`verifyBuyer`). The submit button reads "Place your order"; the cart
says the total.
A wallet button pays the whole order in one step. The success card
says what was paid with what, links the receipt, and for an on-farm
pickup says the time is a request.

The content-security policy in `netlify.toml` allows the vendors'
hosts: Square's SDK, PCI and font hosts, Google Pay, Cash App Pay,
`*.paypal.com`, `*.paypalobjects.com` and `*.venmo.com`, with
`style-src 'unsafe-inline'` because Square's SDK needs it. Netlify
does not document how two header rules for one path merge, so the one
policy covers every page. `Cross-Origin-Opener-Policy:
same-origin-allow-popups` is set for Google Pay's popup. Apple Pay
also needs the domain verified: Square's file at
`static/.well-known/apple-developer-merchantid-domain-association`
(James adds it) and the domain registered under the app's Apple Pay
settings in the Square developer dashboard, sandbox and production.

## Square

Environment variables, set in Netlify, never in the repo:

- `SQUARE_ACCESS_TOKEN`: an app token with `CUSTOMERS_READ`,
  `CUSTOMERS_WRITE`, `ORDERS_READ`, `ORDERS_WRITE`, `PAYMENTS_READ`
  and `PAYMENTS_WRITE`, which covers refunds too, and
  `INVENTORY_READ` for the stock counts.
- `SQUARE_LOCATION_ID`: the location orders and payments belong to,
  and whose stock the site sells by. In production, North Foster Farm
  (#267): every sale lives there. An order placed at another location
  before a change is still updated where it was placed.
- `SQUARE_APPLICATION_ID`: the app id the page hands the SDK. Public;
  sandbox and production ids differ, so one value per context.
- `SQUARE_ENV`: `sandbox` (the default), `production`, or `fake` for
  local development (below). Picks the API host, the SDK host and the
  dashboard links.
- `SQUARE_VERSION`: optional, defaults to `2026-09-16`.
- `SQUARE_WEBHOOK_SIGNATURE_KEY` and, if the registered URL is not the
  site's own `/api/square/webhook`, `SQUARE_WEBHOOK_URL`.

Per card or wallet payment (`payWithSquare` in `lib/checkout.mjs`):
search the customer by email or create one; create the order with a
`PICKUP` or `DELIVERY` fulfilment scheduled for the chosen day, an
order-scope discount and a delivery-fee service charge (two charges
when the outside-area fee applies); create the payment against that
order with the SDK's token, the recomputed total and the customer's
email. A decline (`DECLINE_MESSAGES` in `lib/square.mjs` maps Square's
codes to the customer's words) cancels the order and answers `402`.
The paid order appears in the Square dashboard with its fulfilment.

A Venmo payment is recorded on Square the same way, except the
payment is an external tender: `source_id: "EXTERNAL"` with
`external_details { type: "SOCIAL", source: "Venmo", source_id: <the
PayPal capture id> }`. No money moves through Square for it; the
dashboard, the reports and the refunds keep one shape.

`refundPayment` refunds a Square payment, whole or part;
`cancelFulfilment` closes the fulfilment when an order is cancelled;
`updateFulfilment` carries a customer's date or detail change across.
`GET /api/checkout/config` gives the page the application id, the
location and the SDK host (`clientConfig`).

## PayPal

Venmo online is PayPal's. Environment variables, per context:

- `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`: the PayPal Business
  app's credentials, sandbox and live pairs.
- `PAYPAL_ENV`: `sandbox` (the default), `live`, or `fake` for local
  development (below).
- `PAYPAL_WEBHOOK_ID`: the id of the webhook subscription, which the
  signature check needs.
- `VENMO_HIDDEN`: unset normally. Set to `1`, the button shows only
  in a browser that has opened `/order/?venmo` (it remembers until
  `/order/?venmo=0`), so a live payment can prove Venmo before
  customers see it. Remove it and redeploy to show the button to all.

Without the client id the Venmo button is not rendered. With it, a
Venmo payment is two requests (`startVenmo` and `finishVenmo` in
`lib/checkout.mjs`). The first validates the order, creates the PayPal
order (`POST /v2/checkout/orders`, intent `CAPTURE`, our order id as
`reference_id` and `custom_id`, `NO_SHIPPING`) and keeps the validated
order as a checkout under `checkout/<key>` in the `orders` store,
indexed by the PayPal order id (`by-paypal/<id>`). The customer
approves in the Venmo app. The second request captures the money
(`POST /v2/checkout/orders/<id>/capture`; an order already captured
is read back instead of failing), records it on Square as above, and
writes the record. If Square cannot be reached after the capture the
record is still written, with `square: null`, the farm is alerted
(`square.record_failed`) and the jobs try the Square copy again on
every run until it takes. A captured amount that is not the order's
total is recorded all the same and alerted (`venmo.amount_mismatch`).

### A lost answer never charges twice (#268)

Netlify ends a function at 10 s. If it died after Square or PayPal took
the money and before the record was written, the page saw a failure
and no record existed. Four parts keep the retry from charging again:

- **A short request.** Every outbound call carries a timeout, and the
  calls of one request share a deadline of 8 s (`lib/http.mjs`,
  `ORDER_BUDGET_MS`). A call that moves money (Square's payment,
  PayPal's capture) is not started with under 2 s left, so a late
  request charges nothing rather than leaving a payment nobody can
  answer for. A call that times out is a retryable error, never a
  decline.
- **No mail in the request.** The record is written, then the answer
  goes. The confirmation, the farm's notice and the news welcome
  (`announceNew`) are sent after the answer (`waitUntil`) and, for any
  that did not go, by the jobs: a paid order without
  `emails.orderConfirmed` is announced on the next run.
- **Ask before paying again.** A later attempt (`attempt` over 1) has
  fresh idempotency keys, so Square cannot recognize it. Before paying,
  `square.findPaid` reads the location's orders of the last two days,
  matches `reference_id` to the order id and, for a completed payment,
  records the order from it and answers success: nothing is charged.
  A payment for another amount, or one noted from Venmo, is not
  recorded and not charged again; the farm gets `payment.unreconciled`.
  If Square cannot say, nothing is charged and the page retries. A
  Venmo attempt asks PayPal about the checkouts kept from the attempts
  before it, and finishes one already captured.
- **Keep the attempts.** A new Venmo attempt moves the checkout it
  would overwrite to `checkout/<key>~<attempt>`, still indexed by its
  PayPal order, so the jobs, the webhook and the check above find a
  payment captured for any attempt. The sweep drops them after a day.

`POST /api/paypal/webhook` (`netlify/functions/paypal-webhook.mjs`)
verifies each delivery with PayPal (`verify-webhook-signature`) and
handles two events. `PAYMENT.CAPTURE.COMPLETED` finds the checkout by
the PayPal order id and finishes it if the browser never came back to
do so; when the page already did, it is a no-op.
`PAYMENT.CAPTURE.REFUNDED` notes a refund made in PayPal on the
order. Anything else answers 200 and is ignored. Checkouts nobody
finished are swept by the jobs after `CHECKOUT_TTL` (a day).

## Records

Orders are persisted in Netlify Blobs (`netlify/functions/lib/store.mjs`
is the seam; memory off Netlify) once the money is in, with the Square
ids and the payment, and a customer record is created or touched by
email. `lib/records.mjs` owns the documents and the indexes:
`order/<id>`, `by-email/<email>/<id>`, `open/<id>` for orders the jobs
still watch (paid), `by-payment/<id>` from the Square payment id and
the PayPal capture id, for the refund webhooks, and `checkout/<key>`
with `by-paypal/<id>` for Venmo payments in flight. Statuses: paid,
fulfilled, cancelled. Records from before the checkout moved onto the
page may still say `submitted` or `abandoned`; nothing makes those any
more and the jobs flag any `submitted` one they find
(`legacy.unpaid`). Square stays the system of record for money.

Every order carries `payments`, a list, oldest first: `{ at, amount,
via, method, squarePaymentId, receiptUrl, brand, last4, wallet }`, and
for Venmo `paypalOrderId`, `paypalCaptureId` and `payer`. An order has
one payment until it is changed after paying (#160), which can add
more. `via` is `square` or `venmo` (a record made by hand may say
`cash` or `check`); `method` is `card`, `applepay`, `googlepay`,
`cashapp` or `venmo`. `paymentPhrase(order)` in `lib/templates.mjs`
turns them into "$55 by Visa ending 4242", or "$55 by Visa ending
4242, then $6 by Venmo". Each refund is added to `refunds`: `{ at,
source, amount, payment, total, squareRefundId, paypalRefundId,
status }`, where `payment` names the payment it came out of (its
Square payment id, or for Venmo its PayPal capture id) and `total`
says whether everything paid has now gone back. A record from before
2026-09-25 holds one `payment` and at most one `refund` instead;
`paymentsOf` and `refundsOf` in `lib/records.mjs` read both shapes,
and the first change to its money rewrites it as lists. `meta` keeps
the submission key and the attempt, which the jobs need to retry a
missing Square copy.

Every order is booked by paying (W11d): a pickup time the schedule
offers needs no second yes from the farm, and `fulfilment.state` is
`agreed` on every new order. `fulfilment.onfarm` keeps the window's
id and times, `{ window: "09:00-12:00", from: "09:00", to: "12:00" }`;
records from before keep `window: "morning"` or `"afternoon"` (9 to 12,
1 to 5) and may carry the hours the farm confirmed then,
`onfarm.confirmed = { from, to }` (`pickupTimes` in `lib/schedule.mjs`
reads both). Square's pickup time is the window's start. A pickup the
farm can't keep after all is cancelled like any order, with
`bin/nff orders cancel <id> --reason <why>` or `--reason-text`, and
refunded; nothing is denied (T2d). Records from before may carry a
**question** (`order.question = { kind: "window", ... }`) from the
old `orders deny`; the account pages still let such an order be moved
or cancelled past the cutoff.

A time that lapses as the customer pays (the farm dropped it, or a
day closed) answers 409 with the fresh list, and the page raises a
blocking dialog offering what is open now (`order/lapsed.js`, UX's U1
to U3); nothing has been charged, and the customer pays again with
the same button. The page asks `/api/dates` once more before a card,
wallet or Venmo payment goes out, so the dialog usually comes before
a wallet opens. A Venmo payment the jobs finish after its time left
the schedule stands, and alerts the farm (`pickup.lapsed`).

A customer record (`customer/<email>`) keeps the name, phone, avatar,
pricing group, delivery address and `reminders`, with one reminder
email, `{ delivery }`, as a boolean; a key that is missing means on,
so records from before the setting existed behave as they did
(`REMINDERS` and `reminderPrefs(customer)` in `lib/records.mjs`; a
`payment` key from the unpaid era may still be on a record, and
nothing reads it).

## Mail

`lib/mail.mjs` sends through Resend when `MAIL_DRIVER=resend`,
`RESEND_API_KEY` and `MAIL_FROM` are set, otherwise to the function
log. `MAIL_DRIVER=file` writes each message as `.html` and `.txt`
under `MAIL_OUT` (default `.ignored/outbox`) instead, so a local
`bin/nff` command, `netlify dev` or a jobs run leaves its emails
where a browser can open them; `MAIL_DRIVER=outbox` (staging) keeps
them in the jobs store. `node .ignored/render-all.mjs --open` renders
every template from the sample order into `.ignored/rendered/` with
an index page. `MAIL_REPLY_TO` and `FARM_NOTIFICATIONS_EMAIL` (comma-separated)
are optional. `lib/templates.mjs` holds every message as a pure
function with tests: order confirmed, pick a new time (a booked time
the farm gave up), delivery reminder, order changed, order cancelled,
address decision, sign-in link, farm-news confirmation, and to the
farm: address review, order placed, pickup moved, the morning report,
the Tomorrow manifest and the alerts. Square sends the card receipt;
Venmo shows its own. Every order is confirmed by paying
(`announcePaid`). The delivery reminder carries
a "Turn off delivery reminders" link to the account page's settings
tab; the jobs run reads the customer's `reminders` before it and
skips, and reports as `muted`, one the customer turned off. The
wording is James's (review of 2026-09-22). Every customer message
ends on a "Your orders | Contact us" row and the farm's on "Admin";
`mailLinks(env)` in `lib/site.mjs` supplies those from
`ACCOUNTS_ENABLED`, `CONTACT_URL` (else the farm's mailbox) and
`ADMIN_URL` (default admin.northfosterfarm.com; the order and customer
pages it links to arrive with the dashboard's order views). A resolved
return sends nothing: James answers those himself. Links point at
`SITE_URL`, else Netlify's `DEPLOY_PRIME_URL`, else `URL`.

The farm's own notice goes to every address in `FARM_NOTIFICATIONS_EMAIL`:
`farmOrderPlaced`, the moment the order is paid, since that is the
moment it exists. It carries the fulfilment sentence, how to reach
the customer, the drop-off details for a delivery, the lines, the
totals, the line `Paid: $55 by Visa ending 4242` and a link to the
order in the Square dashboard. It is recorded under the order's
`emails`, like every other send, so a retried request never sends it
twice; with `FARM_NOTIFICATIONS_EMAIL` unset it is skipped.

## Refunds

Money goes back from the CLI. `bin/nff orders refund <id> [--amount
12.34] [--reason "..."]` refunds whatever has not gone back yet
unless told the amount, out of the newest payment first: a card or
wallet through Square (`POST /v2/refunds`, Square sends its refund
receipt), Venmo through PayPal (`POST
/v2/payments/captures/<id>/refund`, Venmo tells the customer), and
for Venmo the Square copy is noted as refunded too, best effort, so
the books agree. It can be called again for the rest, until
everything is back. `bin/nff orders cancel <id> --reason <why>` (or
`--reason-text "..."`, or `--no-reason`) refunds what is left first,
then cancels: stock back, the fulfilment closed in
Square, the customer emailed "Your refund is on its way" (said only
when money went back just then). Only `--no-refund` cancels without
money back (T1c), and its email says nothing more will be charged.
A customer's cancel from the account page runs the same refund at
once (T1d); if it fails, the order is flagged and the farm told to
run `orders cancel`.

A delivery the farm could not leave (no cooler, nobody reached) keeps
its fee when the customer caused the miss, and waives it when the
farm or the weather did (James, F1 and C1). `bin/nff orders attempted
<id> <cause> [--detail "..."] [--waive "why"]` records the attempt as
`attempted: { at, date, cause, fee, waived, note, detail }` (`date`,
the day missed). The causes
(C6a): `no-cooler`, `no-access` and `no-address` are the customer's
miss; `weather` and `farm` waive the fee. `no-address` counts as the
customer's because the truck can't tell a wrong address from our own
wrong turn; waive it when in doubt (C6b). `fee` is the cents kept, 0
when waived; `note` is the private reason a customer's miss was
waived anyway (C2); `detail` is what the missed-delivery email adds
about where we couldn't get to. The email's reason line states what
we saw, one per cause. Refunds, cancels and emails all read `fee`
through `keptFee(order)`. From then on a refund or a cancel hands
back everything but the kept fee. A refund made in
the Square dashboard or PayPal is not held to it. The dashboard's
delivery routes (nff-dashboard#24) must mark a miss through the
site's `markAttempted`, never by writing the record: the question,
the email and the move below all happen there, and a record written
directly would start none of them.

The jobs close a delivery the morning after its day, so a miss can
be marked until `MARK_LATE_DAYS` (2) days after it: an order the jobs
closed in that time is reopened (`reopened` in its history) and
marked. Later than that, or after the farm closed it itself, the
mark is refused.

What follows the mark depends on whose miss it was (#193). The
customer's, waived or not, opens a `missed` question on the order
and emails missedDelivery, which links to the order. The hold runs
`holdDays` from the day that email goes (`question.until`), never
from a day the customer didn't know about: if the send fails,
`orders attempted` run again resends it, the jobs try each run
(`jobs history` counts `told`), and the hold can't run out until it
has gone. An email sent after the missed day names that day rather
than "today". While the question
is open the jobs neither close the order nor remind, and the account
page keeps Change, Change items and Cancel open past the cutoff.
Another delivery day or a switch on the order page answers it, as
does cancelling; the order page counts what is paid less the kept
fee (`creditOn` in lib/edit.mjs), so another delivery after a kept
fee charges the fee again (C1) and a switch to pickup refunds none of
it. The account page's Change panel moves the day only when the fee
was waived. A reminder sent before the miss was for that trip, so the
new day gets its own, with the date in its mail key. If the customer
hasn't chosen by the end of `until` (C8), the next jobs run cancels
the order (`source: "hold"`): stock back, everything refunded but
the kept fee, and orderCancelled with its held-seven-days line. The
question is answered `expired` only once the cancel has gone through,
so a refund that fails is tried again next run, and `jobs history`
counts each as `held`.

The farm's or the weather's miss asks nothing (C7): the order moves
to the next delivery day (a holiday pushes it a week further), Square's
fulfilment follows, and movedDelivery tells the customer, who can
still change it or cancel for a full refund. `bin/nff orders move
<id> <date>` moves any paid delivery to a later delivery day, past
the cutoff, answers the question and emails orderChanged; it refuses
after the customer's miss kept the fee, since only the customer can
pay the next trip's fee, on the order page.

`bin/nff orders change <id>` makes, for the customer and past the
cutoff, any change they could make themselves, and one they cannot:
the way they receive the order, with its address. Its flags are
`--method onfarm|dropsite|delivery`, `--date`, `--window` (a pickup
time), `--address1`, `--address2`, `--town`, `--zip`, `--cooler`,
`--gate`, `--delivery-notes`, `--phone`, `--contact`, `--notes` and
`--key` (to retry one change safely). A new method or address goes
through `planEdit` and `applyEdit` in `lib/edit.mjs` (`farmEdit`
there), with the customer's validation, schedule and fee rules and
the Square fulfilment move; a date, pickup time, drop-off detail or
note goes through `planChange` and `applyChange` in `lib/account.mjs`,
which the customer's own quick change shares. Both send the customer
`orderChanged` and flag `squareOutOfSync` if Square fails. History
records `farm.changed`, and the farm is not emailed about its own
change. The order keeps its own prices (`planEdit`'s `hold`), so a
catalog price that moved since it was placed, or the prices of a later
day, show no difference; only a fee of the new way can. The CLI moves
no money: a change that adds a fee (the customer must pay it on the
order page) or credits one is refused, and says to make the change on
the order page or refund by hand and run it again. `--notes` goes
alone or with a date, time or drop-off detail, never with `--method`
or an address. `--phone` and `--contact` go alone or with any other
flag. A method or address change prints its idempotency key before it
applies; after a crash, run it again with `--key <key>`. A key whose
change is already done returns success and applies nothing of the new
body. The CLI says so when the change set `squareOutOfSync`. Square's
inventory is read only when a change adds items, so a farm change and
`--dry-run` need no Square. `--dry-run` saves and sends nothing and
prints the email.

A customer who cancels from the account page is refunded and
cancelled at once (T1d), and the farm is emailed "Cancelled: <id>".
Only if that refund fails is the order flagged `cancelRequested`,
its stock released, and the farm emailed "Refund needed" with the
command; it stays `paid` until the CLI refunds and closes it. A
refund made in the Square dashboard
(`refund.updated`, `POST /api/square/webhook`, signed with
`SQUARE_WEBHOOK_SIGNATURE_KEY`) or in PayPal
(`PAYMENT.CAPTURE.REFUNDED`) reaches the record through the webhooks,
by the `by-payment` index, which holds every payment of an order,
so `refunds` is right however the money went back.

## Changing a paid order

Until the cutoff, the account page's Change items opens
`/order/?edit=<id>`, which loads the order into its own draft
(`nff-edit-<id>`, never the cart) and prices the change with the same
code as a new order, at today's prices. Under the total it shows what
is paid and the difference. `POST /api/account/orders/<id>/edit`
(`lib/edit.mjs`) takes the order as it should now be; what the page
does not carry (notes, the pickup phone, drop-off details) comes from
the record. More to pay is charged by card, wallet or Venmo (the same
two steps) on a Square order of its own under the same `reference_id`,
listing what was added with one discount for what was taken off, and
recorded as a second payment, with the Square order in
`square.changes`. Less is refunded as above, newest payment first,
with `source: "customer"`. Stock moves by the change alone, and a line
the order already holds may stay after it sells out. A switch between
delivery and pickup puts the fulfilment on a new Square order ($0 and
paid when nothing is owed, named in `square.fulfilmentOrderId`) and
cancels the old one, since Square cannot change a fulfilment's type;
once changed, the fulfilment's note lists the whole order. Each edit
has its own idempotency key and a line in `edits`; the customer gets
"Your order is updated" with the money, the farm "Order changed".

## Schedule

`netlify/functions/jobs.mjs` runs every 15 minutes (Netlify scheduled
function) and calls `lib/jobs.mjs`, which decides in
`America/New_York` from the records alone:

| When                                   | What                        |
| -------------------------------------- | --------------------------- |
| every run, a Venmo order without its Square copy | `squareSync`      |
| 18:00 the day before a delivery        | cooler reminder             |
| the day after fulfilment               | `fulfilled`                 |
| every run                              | checkouts older than a day swept |
| 8:00 daily, always                     | "Morning report"            |
| 18:00 daily, always                    | "Tomorrow", the manifest    |
| once a day from 5:00                   | farm-news audience sync     |
| every run                              | invariants, ledger, heartbeat |

Sends are noted on the order under `emails`, so a repeat run sends
nothing twice. An order with an open question is not closed. The
daily reports are recorded in the `jobs` store (`report/morning/<date>`,
`report/tomorrow/<date>`, `news/sync/<date>`). Every order's work in a
run is isolated, so one failure does not stop the rest; errors and
invariant violations (`paid.not_closed`, `legacy.unpaid`,
`square.missing`, `order.unreadable`) go on the run's report, into
the ledger (`run/<time>`, two days), to the log, to an alert and to
the heartbeat. `docs/monitoring.md` has the whole picture: the health
endpoint, the alerts and what to do about each, the invariants, the
log, and how to set up the two free accounts.

## Sign-in

Magic links, no passwords. `POST /api/auth/request` mails a
single-use link (15 minutes, three per address per 15 minutes, always
answers 200); `GET /api/auth/verify?token=` consumes it, creates the
customer record if needed, sets the `nff_session` cookie (HttpOnly,
Secure, SameSite=Lax, 30 days) and redirects to a same-site `next`;
`POST /api/auth/signout`; `GET /api/me`. Tokens are stored hashed in
the `auth` store. State-changing posts must come from this site
(`Sec-Fetch-Site` or `Origin`). `lib/auth.mjs` is shared with the
CLI, which mints links and sessions to sign in as a customer. The
page is `/login/`.

The CLI's `login` and `masquerade` mint a link without mailing it
(`send: false`). The page's second form, **Find
my order** (an order number and its email, sent as `{ email, orderId }`),
was removed on 2026-09-25 (#150): a customer signs in with the email
instead. An `orderId` in a request is ignored.

## Account

`/account/` is one page with tabs (Orders, Receipts, Address,
Settings, Help) rendered from `GET /api/me` and
`GET /api/account/orders`. `lib/account.mjs` holds the rules:

- Cancel: refunded and closed at once, as under "Refunds" below;
  only a failed refund leaves it `cancelRequested` for the CLI.
  Allowed until the cutoff (delivery cutoff, or midnight before a
  pickup), or while a question from the farm is open on an older
  record.
- Change: the date (from the offered list), pickup window,
  drop-off cooler, gate and notes, order notes. Square's fulfilment is
  updated; if that fails the order is flagged `squareOutOfSync` and
  the farm is emailed. Items cannot change: cancel and reorder.
- Address: approved at once when the ZIP is on the list; otherwise
  `pending` and the farm gets an address-review email; `denied` is set
  by the CLI. Changing only the drop-off details keeps the decision.
- Returns: a request on a paid or fulfilled order, recorded under
  `order.returns` and emailed to the farm.
- Support: stored under `support/<email>/<id>` in the customers store
  and emailed to the farm, who replies by email.
- Settings: first and last name (kept in parts, as the order form
  takes them; `name` is rebuilt from them), phone, avatar, the farm
  news opt-in (`marketing`, off unless the customer ticks it, with
  `marketingAt` the date it last changed; the checkout has the same
  box as `customer.marketing` on the payload, and only a ticked box
  changes the record) and the delivery reminder as a checkbox, saved
  through `PATCH /api/account/profile` as `reminders: { delivery }`.
  The confirmation, the receipt and order changes cannot be turned
  off.
- Receipts: one row per payment, with its amount, what it was paid
  with, its status (paid, delivered, or what of it was refunded) and
  Square's receipt link; a Venmo payment's receipt is in the Venmo
  app. The order card shows "Paid with" under the totals (each
  payment, for an order changed after paying) and, after a refund,
  when and how much in all.
- Add again and Reorder: plain links to `/order/?add=SKU:qty,...`.
  The order page merges the quantities into the cart on load, names
  anything no longer sold, saves the draft, scrolls to the summary
  and clears the query. The live stock check then clamps if needed.

The order card shows a pickup note while a booked pickup time the farm
gave up waits on the customer. Avatars are the six SVG symbols in
`layouts/partials/avatars.html`, keyed by `data/avatars.json`, shown
on the account page only. The header (`session.js` in the site
bundle) asks `/api/me` once per five minutes, cached in
`sessionStorage`, and shows a Sign in link or an Account menu.

## CLI

`bin/nff` is the farm's admin surface; there are no admin pages. It
reads one env file from the repo root, each complete, with the keys
`.env.sample` names. `--production` reads `.env.production`:
`NETLIFY_SITE_ID`, with the Netlify token read from the Keychain,
to reach the site's Blobs stores, the production Square token and
location, the live PayPal pair, the mail variables
(`MAIL_DRIVER=resend`, `RESEND_API_KEY`, `MAIL_FROM`,
`MAIL_REPLY_TO`), `ACCOUNTS_ENABLED=true` and `SITE_URL`, so a
cancel or an address decision sent from here reads as one sent from
the site.
`--staging` and `--preview` read `.env.staging` or `.env.preview`
(the sandbox token and its location, `MAIL_DRIVER=outbox`, that
deploy's `SITE_URL`). With no flag it reads `.env`, linked locally
to `.env.development`, and acts on the `dev-` stores: only
`--production` reaches production's records, whatever a file holds.
The commands below act on production when given `--production`.
Without the Netlify pair it runs against memory and says so; without
a mail driver it logs every email to the terminal instead of sending
it, and says that too. `bin/nff` with no arguments prints the commands:
customers (list, show, set, delete), address (approve, deny), orders
(list with `--open`, `--status`, `--email`; show; cancel `--reason
<why> | --reason-text | --no-reason [--no-refund] [--amount]`, which
says what it refunds; attempted; change `[--method] [--date] ...
[--dry-run]`; refund
`[--amount] [--reason]`; fulfil; delete), returns resolve, stock
(list, set), schedule (check, set), login and masquerade (a
single-use sign-in link, opened for you), audience (invite, sync),
jobs (run, history), health.
`--staging` and `--preview` act on that deploy context's stores.
Flags that take a value accept both `--reason "..."` and
`--reason=...`. `lib/admin.mjs` holds the rules with tests.

## Decisions

- **Pay on the page.** Square's Web Payments SDK for cards and the
  wallets, PayPal's button for Venmo, the whole experience on the
  checkout page and nothing recorded until the money is in (James,
  2026-09-23, issue #122). Square stays the system of record: a Venmo
  payment is an external tender on the Square order.
- **Venmo through PayPal**, despite the second processor's fees:
  nearly half of the farm's non-cash payments in 2026 came that way,
  and this keeps the checkout small and conventional. PayPal itself
  is not offered as a way to pay.
- **Card, Apple Pay, Google Pay and Cash App Pay**; no bank transfer.
- **Refunds from the CLI**, Square and PayPal both. A pickup time the
  farm can't keep is cancelled and refunded.
- **No Google Sheet.** Square is the system of record; the function log
  is the fallback record.
- **Catalog version 2026-v8, keyed by SKU.** The spec's 2026-v5 list of
  31 keyed by `group.item` is superseded. Its 20 in-stock items are the
  same 20; v6 adds Medium and Pullet eggs, Cornish Hens, Ground Chicken
  and splits the sausage flavors. 2026-v7 (#275, 2026-10-20) changes
  labels only: Large and Medium eggs become Farm dozen and Petites, and
  the cuts' tiers get new weight labels. 2026-v8 (#267, 2026-10-20)
  restores the sizes Large, Medium and Small, each noted "Grade A":
  Rhode Island (250-RICR-40-20-7 §7.5) requires eggs offered for sale
  to state grade and size in full. The eggs are self-graded by
  candling, so the site never claims AA, a USDA grade or the shield.
  2026-v9 (#267, 2026-10-21) sets a one-pound minimum pack: each cut's
  smallest tier becomes a range from 1.0 lbs, Livers, Necks and Backs
  carry their ranges in their names, shown where a cut shows its tier
  (6305330408), Feet reads "Feet, 1 lb avg." until real
  weights set its tier, and Ground Chicken, never sold, and Cornish
  Hens, discontinued, are archived (6305037316).
- **Stock set as of 17 September 2026** is the 2026-v3 flyer's 20 line
  items. The August home-page update lists Cornish hens and sweet
  Italian sausage as on hand, and the processor receipts show 133 packs
  of sweet Italian received on 24 July, so those flags may be stale.
  `bin/stock` is the tool; the freezer count decides.
- **Fee waiver at `subtotal >= 150`**, copy says "$150 or more". The v4
  PDF's "over $150" would charge $5 on exactly $150.
- **$40 minimum is a hard block** with pickup and the drop site as the
  escape hatch, both without a minimum. The one exception is a pass
  (#182): `bin/nff passes issue [--email x] [--days 14]` prints a code
  that lets one delivery order under the minimum. It is single use,
  expires, and is tied to an email when given. `--standing` (with
  `--email`) makes one for every order from that email: never used
  up, no expiry unless `--days`, ended by `passes revoke`.
  `--waive-fee`, on either kind, takes the delivery fee and the
  outside-area fee to $0 (the fee cell says "$0"; Square gets a $0
  "Delivery fee" service charge and no discount): ride-along customers
  get a standing one. Otherwise a pass changes nothing charged. To the
  customer it is a discount code: the code box takes it; `GET
  /api/pass` tells the page, and `POST /api/orders` checks it again,
  holds a single-use one for 30 minutes while the order is paid, and
  the paid record uses it up (`lib/passes.mjs`). Every code refused,
  a discount code or a pass, used, expired or for another email, says
  "That code isn't valid."; `passes list` gives the farm the reason.
  A pass the server refuses at Pay comes off the order, and the words
  go by the code box. Applied, the note says the order can be
  delivered under the minimum, or only "Applied." for a code that
  waives the fee. An order that needs no waiver leaves the pass
  unused, and a change to the order keeps the waiver (`passWaivesFee`
  on the record keeps the fee's).
- **No South County option.** Dropped on 18 September 2026, along with
  the demand vote.
- **Out-of-stock items are hidden by default**, and a category with
  nothing in stock is left out along with its nav pill. Square is the
  database and the default view shows only what is in stock: an item
  out of stock has no row, never a sold-out one, and a rename never
  changes that (James, #267, 2026-10-20). A stock count of 0 is out
  of stock too: the page hides the row once `/api/stock` says so.
  Every SKU stays in Square, including empty tiers. Show "Full
  catalog" shows them with their restock labels, and search always does
  (see Restock types). `order-page.spec.mjs`, `search.spec.mjs` and
  `restock.spec.mjs` hold it.
- **The order page is the product list**, headed "All products" (the
  `heading` front-matter param; the title stays "Order" for the tab
  and the breadcrumb). A "Catalog" sidebar (Bootstrap ScrollSpy)
  becomes an offcanvas drawer below `lg`; the active category's
  heading slides right and a chevron slides in beside it. One section
  per category under its heading; each product a row card with its
  price and an Add button, rightmost, that morphs into
  a stepper. Buttons take their height from padding, never a fixed
  height.
- **The cart.** From `xl` it is a column to the right of the catalog,
  under the page heading, about 60/40, and sticks to the top for the
  length of the page like the sidebar. Below `xl` it floats above the
  list while it scrolls and a caret folds it down to the total and
  the Next button. On a screen 500px tall or less, at any width (a
  phone on its side, whatever Safari's bars are doing), nothing rides
  along: the cart sits where it settles and the top bar scrolls away
  with the page (#274 round 4; `$cart-short`, order-form.js `SHORT`).
  It itemises every line (name, quantity at the unit
  price, subtotal, or "0 items"), then subtotal, discount and fee
  ("Free" when waived), the discount code field, then the total under
  the line, and Next, which scrolls to Your details. Lines are grouped
  under their category with the tiers indented beneath, at 0.875rem.
  The "Next discount" nudge is hidden at the top tier. There is no
  Empty cart; a saved draft is restored silently. The badges are a
  dotted line of 0.7rem text on any way: "Delivery" (lit at the
  minimum) and "Free delivery" (lit at the waiver), two badges since
  #274 round 4, then the tiers, which take a second line where the
  list is under 22rem wide. They are muted until earned and then
  primary green and italic; a handful of chicks hop out of one the
  moment it lights (`celebrate.js`, on a small canvas around the
  badge). Below `lg` the page title rides in the
  sticky Jump to bar beside the button. Everything the panel says
  comes from `lib/summary.mjs`, whose tests pin every sentence and
  prove the nudge's promise against the totals at every cent to $250.
  The design spec behind the page lives in
  `.ignored/handoffs/online-orders-but-fable/design-critique.md`.
- **Forms are horizontal**: a label column and a field column. A
  signed-in customer's name, email and phone arrive as plain text
  under a "Click to edit" hint; a click makes one a field again.
- **"Pressing the button charges your card and places your order"**
  is the note above the button, set large; the success card's
  headline says the order is placed.
- **Browser support** is set by `:has()`, `inert` and `color-mix()`:
  Safari 16.2, Chrome 111, Firefox 121 and later. Media queries use
  classic min/max-width for Safari before 16.4.
- **Connecticut is eggs only for now.** Chicken cannot be sold there
  yet. A CT ZIP with any non-egg line is rejected, the ZIP field says
  why as it is typed, and `onlyGroups` on the state entry in
  `data/delivery.json` is the switch.
- **The delivery terms are linked, not ticked.** Above the delivery
  fields a live countdown says "Order in the next N days, N hours, and
  N minutes to get your order on our next delivery day". For every
  way to get an order, one line directly above the Pay button says
  that placing an order is agreeing to the policy at
  `/delivery-policy` (W8, #196). No drop-off contact name or phone: the
  customer's own name and phone go to Square as the recipient.
- **West Greenwich is ZIP 02817.** The v4 PDF prints 02818, which is
  East Greenwich. Corrected in `data/delivery.json`.
- **The `/venmo` redirect stays** for the PDF and the market signs.
- **`/order-form.pdf` is retired** with the launch (#150); the URL
  redirects to `/order/`.
- **HSTS raised to a year** in the same commit that touched the header
  block for `form-action`, as the audit asked.
- **Order ids** are `NFF-YYMM-XXXXXX` with the tail derived from the
  submission key, so a retry reuses the id. The id is reserved in the
  orders store (`id/<id>`, create-only, holding the submission key)
  before Square or PayPal is called; a draw another submission holds
  is passed over for the next, and a record that is not this
  submission's is never returned (`order.id_collision`, #253). A
  submission already paid is answered with its record before
  anything else, so a new attempt after a lost answer never charges
  again. Ids
  from before had four characters and stay valid: nothing parses the
  tail.

## History

From the launch on 2026-09-19 until this change, an order was
recorded at submission as `submitted` and paid later through a Square
invoice emailed to the customer, with payment reminders, abandonment
at the cutoff, an optional bank transfer, and Venmo taken by hand and
matched from Venmo's notification email. All of that is gone, and
issue #112 (the Venmo matching problem) closes with it.

## Local development

`npm run start:functions` runs `netlify dev`, which starts the Hugo
server and proxies the functions at <http://localhost:8888>.

Several can run at once, one per worktree, each on its own `--port`:

```bash
npm run start:functions -- --offline --port 8891
```

The wrapper (`bin/dev-functions.mjs`) gives Hugo a free port from the
system, never 1313, and points `netlify dev` at it; `HUGO_PORT` picks
one instead. It works from a worktree nested in
another checkout (`.claude/worktrees/`). Stopping it, by Ctrl-C or a
signal to `npm`, stops Netlify and Hugo with it and frees both ports.

**Fake payments, the default.** The development env file sets
`SITE_CONTEXT=dev`, `SQUARE_ENV=fake` and `PAYPAL_ENV=fake` (#265).
Then no call leaves the machine: `lib/fake-square.mjs` and
`lib/fake-paypal.mjs` answer every call `lib/square.mjs` and
`lib/paypal.mjs` would send, with the same arguments and the same
answers, and `/api/checkout/config` points the page at stub SDKs that
the local Hugo server publishes at `/scripts/fake-square.js` and
`/scripts/fake-paypal.js` (`assets/scripts/fake/`). The card form is
plain fields filled with a test card; 4000 0000 0000 0002 is declined
with Square's `CARD_DECLINED`. The Venmo button approves at once and
the capture follows. Orders, records and emails are otherwise real,
so the whole flow, the account pages and `bin/nff` refunds run with
no vendor account. `e2e/fake-payments.spec.mjs` places a card order
and a Venmo order against `netlify dev`.

A fake works only where the deploy context is `dev` (`lib/fake.mjs`).
Anywhere else, production, staging, a preview or no context at all,
`fake` is refused: every call throws (`FAKE_REFUSED`), the page is
offered no payment, and the failure alerts like any other. No Netlify
build is a Hugo server, so no deploy carries the stub SDKs either.

**A real sandbox, by choice.** To try Square's or PayPal's own forms,
put `SQUARE_ENV=sandbox` with a sandbox token, location and
application id, or `PAYPAL_ENV=sandbox` with a sandbox client id and
secret, in your own `.env`, never in the sample. The webhooks still
cannot reach this machine. The staging deploy (`docs/staging.md`) is
where a real payment is exercised end to end.

## Shipping scope

Sign-in and the account pages were out of the first launch and came
on 2026-09-22, so a customer can find, change and cancel an order:
`params.features.accounts` in `config/_default/hugo.toml` is `true`
(the Sign in link in the header, `/login/` and `/account/` in the
build), and `ACCOUNTS_ENABLED=true` on Netlify lets the emails link to
them. Set `accounts = false` and unset the variable to take them off
again; nothing else changes. The checks to run after that step shipped
are in `docs/qa-fulfilment-a.md`.

What the order flow needs to run in production is Square, and PayPal
for Venmo. Netlify Blobs is part of Netlify and needs no account. Mail
is optional: without it the confirmations and the farm's notices go
to the function log; Square's receipt still reaches the customer.

## Before it ships

1. **Netlify variables**, one value per context (production, and the
   sandbox values for `deploy-preview`, `branch-deploy` and `dev`):
   `SQUARE_APPLICATION_ID`; a `SQUARE_ACCESS_TOKEN` whose scopes
   include payments and refunds; `PAYPAL_CLIENT_ID`,
   `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV` (`live` in production,
   `sandbox` elsewhere) and `PAYPAL_WEBHOOK_ID`;
   `SQUARE_WEBHOOK_SIGNATURE_KEY` for the refund webhook.
2. **Webhooks.** Square: `refund.updated` at
   `https://www.northfosterfarm.com/api/square/webhook`, the sandbox
   app's at the staging address. PayPal: `PAYMENT.CAPTURE.COMPLETED`
   and `PAYMENT.CAPTURE.REFUNDED` at
   `https://www.northfosterfarm.com/api/paypal/webhook`, and the
   sandbox's at the staging address; each subscription's id is its
   `PAYPAL_WEBHOOK_ID`.
3. **Apple Pay.** Square's domain-association file under
   `static/.well-known/` and the domain registered in the Square
   developer dashboard, sandbox and production.
4. **Nothing left unpaid.** `bin/nff --production orders list
   --status=submitted`
   must print "No orders." before the deploy: the code that would
   have chased those is gone, and the `legacy.unpaid` invariant will
   alert on any that remain. Settle them by hand first.
5. **Venmo payments open across the deploy (#253).** One started
   before it records under its old four-character id. If its page
   then retries a capture that had already finished, the retry looks
   for the new six-character id and answers 409 "Start again". The
   order and the money are safe; the window is minutes.
6. **Prove it on staging.** One card payment, one decline, one Venmo
   payment, a refund from the CLI, both webhooks; the QA guide has
   the steps.
7. **Merge and deploy** per the branch rules, then place one real $7
   egg order on the live site, confirm the receipt and the Square
   order with its fulfilment, and refund it from the CLI.
