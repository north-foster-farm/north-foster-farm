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

`data/catalog.json` is price list 2026-v6: 37 SKUs in 11 render groups,
every item in one array with an `inStock` flag. The identifier is the
SKU (`NFF-CHK-WHL-0200-0250`), which encodes both weight-tier bounds
and so survives a catalog restructure. `squareVariationId` is null
until the catalog is seeded into Square; while it is null the order
handler sends an ad hoc line item with the same name and price, so the
form works before the seed and switches to catalog lines after it.

Each group carries a `unit` ("per dozen", "per each", "per pack") that
sits by its heading on the page; where a group mixes units (Other
Items) each item carries its own and it sits in the row.

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
closes sold-out rows, shows "N left" at five or fewer, clamps the cart
and says so. The order handler checks the same counts and answers
`422` with `lines.<sku>` errors plus the fresh `stock`.

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

- On-farm: every non-holiday weekday from tomorrow through the Friday
  of next week.
- Scituate: the next two Saturdays on or after 17 October 2026. The
  current Saturday stays offered until its 10:00 window opens.
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
4. A `503` leaves a pending record in the browser, which retries on
   backoff, on `online`, on `visibilitychange` and on the next load.
   A panel under the submit button shows the attempt count, a live
   countdown to the next try, a Try now and a Stop trying button; the
   submit button is disabled while a retry is scheduled. A card token
   stays valid across those retries.
5. After six attempts the customer sees the order as selectable text, a
   prefilled `mailto:` and the phone number. Every terminal failure is
   one structured `console.error` in the function log, with the whole
   order, so nothing is lost.
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
`verifyBuyer`). The submit button reads "Pay $X and place your order".
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
  and `PAYMENTS_WRITE`, which covers refunds too.
- `SQUARE_LOCATION_ID`: the location orders and payments belong to.
- `SQUARE_APPLICATION_ID`: the app id the page hands the SDK. Public;
  sandbox and production ids differ, so one value per context.
- `SQUARE_ENV`: `sandbox` (the default) or `production`. Picks the
  API host, the SDK host and the dashboard links.
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
- `PAYPAL_ENV`: `sandbox` (the default) or `live`.
- `PAYPAL_WEBHOOK_ID`: the id of the webhook subscription, which the
  signature check needs.

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

Every order carries `payment`: `{ via, method, at, squarePaymentId,
receiptUrl, brand, last4, wallet }`, and for Venmo `paypalOrderId`,
`paypalCaptureId` and `payer`. `via` is `square` or `venmo` (a record
made by hand may say `cash` or `check`); `method` is `card`,
`applepay`, `googlepay`, `cashapp` or `venmo`. `paymentPhrase(order)`
in `lib/templates.mjs` turns it into "$55 by Visa ending 4242". A
refund adds `refund`: `{ at, source, amount, total, squareRefundId,
paypalRefundId, status }`, once per order. `meta` keeps the submission
key and the attempt, which the jobs need to retry a missing Square
copy.

Beside `status`, an order carries the farm's side of its pickup in
`fulfilment.state`: `requested` or `agreed`. Only an on-farm window
needs the farm's agreement, so only an on-farm order is born
`requested`; delivery, the Scituate drop, and every record from
before the state existed, are `agreed` (`needsAgreement(order)` in
`lib/records.mjs`). `bin/nff orders confirm <id>` sets `agreed` and
records the hours the farm will be there, `fulfilment.onfarm.confirmed
= { from, to }`: whole hours inside the requested window's bounds
(`onFarm.windows` in `data/delivery.json`), at least two hours, the
first two of the window unless `--at` and `--until` say otherwise. The
farm never moves a time outside the requested window; a customer who
reschedules clears the confirmed hours. `bin/nff orders deny <id>
--reason "..."` opens a **question** on the order (`order.question =
{ kind: "window", reason, openedAt, answeredAt, answer, by }`) and
emails the customer to pick again, or cancel for a full refund. While
a question is open the jobs run leaves the order alone (not closed),
and the customer can change or cancel it even past the cutoff. Moving
the date or window from the account page answers the question
(`reschedule`), makes the order `requested` again and tells the farm;
cancelling answers it (`cancel`); confirming after all answers it
(`confirmed`, by the farm). The "Pick a new time" button is a sign-in
link to the order page that lives a week (`LONG_LINK_TTL`, minted
with `limit: false`); while accounts are off the email asks for a
reply.

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
an index page. `MAIL_REPLY_TO` and `ADMIN_EMAILS` (comma-separated)
are optional. `lib/templates.mjs` holds every message as a pure
function with tests: order confirmed, payment received (an on-farm
order paid before its window is agreed), pick a new time (a denied
window), delivery reminder, order changed, order cancelled, address
decision, sign-in link, farm-news confirmation, and to the farm:
address review, order placed (with the confirm and deny commands for
an on-farm window), pickup time changed, the morning report, the
Tomorrow manifest and the alerts. Square sends the card receipt;
Venmo shows its own. For an on-farm order "Your order is confirmed"
goes out when the farm agrees (`confirmOrder` in `lib/payments.mjs`),
"Payment received" at the moment of paying; the Order details block
reads "Requested:" instead of "When:" until then. Every other order
is confirmed by paying (`announcePaid`). The delivery reminder carries
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

The farm's own notice goes to every address in `ADMIN_EMAILS`:
`farmOrderPlaced`, the moment the order is paid, since that is the
moment it exists. It carries the fulfilment sentence, how to reach
the customer, the drop-off details for a delivery, the lines, the
totals, the line `Paid: $55 by Visa ending 4242` and a link to the
order in the Square dashboard. It is recorded under the order's
`emails`, like every other send, so a retried request never sends it
twice; with `ADMIN_EMAILS` unset it is skipped.

## Refunds

Money goes back from the CLI. `bin/nff orders refund <id> [--amount
12.34] [--reason "..."]` refunds the whole payment unless told the
amount: a card or wallet through Square (`POST /v2/refunds`, Square
sends its refund receipt), Venmo through PayPal (`POST
/v2/payments/captures/<id>/refund`, Venmo tells the customer), and
for Venmo the Square copy is noted as refunded too, best effort, so
the books agree. Once per order; a second call is refused. `bin/nff
orders cancel <id> --refund` does the same first, then cancels: stock
back, the fulfilment closed in Square, the customer emailed "Your
refund is on its way". Without `--refund` the cancellation email says
nothing more will be charged.

A customer who cancels from the account page is flagged
`cancelRequested`, their stock is released, and the farm is emailed
"Refund needed" with the command; the order stays `paid` until the
CLI refunds and closes it. A refund made in the Square dashboard
(`refund.updated`, `POST /api/square/webhook`, signed with
`SQUARE_WEBHOOK_SIGNATURE_KEY`) or in PayPal
(`PAYMENT.CAPTURE.REFUNDED`) reaches the record through the webhooks,
by the `by-payment` index, so `order.refund` is right however the
money went back.

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

A link the farm mints (the deny email's "Pick a new time") uses
`limit: false` and a week-long `ttl`. The page's second form, **Find
my order** (an order number and its email, sent as `{ email, orderId }`),
was removed on 2026-09-25 (#150): a customer signs in with the email
instead. An `orderId` in a request is ignored.

## Account

`/account/` is one page with tabs (Orders, Receipts, Address,
Settings, Help) rendered from `GET /api/me` and
`GET /api/account/orders`. `lib/account.mjs` holds the rules:

- Cancel: the order is flagged `cancelRequested`, its stock released,
  the customer told the refund is coming and the farm told to refund
  and close it from the CLI. Allowed until the cutoff (delivery
  cutoff, or midnight before a pickup), or while a question from the
  farm is open.
- Change: the date (from the offered list), pickup window and phone,
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
- Receipts: every payment with what it was paid with, its status
  (paid, delivered, refunded) and Square's receipt link; a Venmo
  payment's receipt is in the Venmo app. The order card shows "Paid
  with" under the totals and, after a refund, when and how much.
- Add again and Reorder: plain links to `/order/?add=SKU:qty,...`.
  The order page merges the quantities into the cart on load, names
  anything no longer sold, saves the draft, scrolls to the summary
  and clears the query. The live stock check then clamps if needed.

The order card shows a pickup note while an on-farm window is
requested or denied. Avatars are the six SVG symbols in
`layouts/partials/avatars.html`, keyed by `data/avatars.json`, shown
on the account page only. The header (`session.js` in the site
bundle) asks `/api/me` once per five minutes, cached in
`sessionStorage`, and shows a Sign in link or an Account menu.

## CLI

`bin/nff` is the farm's admin surface; there are no admin pages. It
reads `.env` from the repo root: `NETLIFY_SITE_ID` and
`NETLIFY_AUTH_TOKEN` (a personal access token) to reach the site's
Blobs stores, the production Square token and location, the mail
variables (`MAIL_DRIVER=resend`, `RESEND_API_KEY`, `MAIL_FROM`,
`MAIL_REPLY_TO`), `ACCOUNTS_ENABLED=true` and `SITE_URL`, so a
confirm or a deny sent from here reads as one sent from the site.
Without the Netlify pair it runs against memory and says so; without
a mail driver it logs every email to the terminal instead of sending
it, and says that too. `--staging` and `--preview` read
`.env.staging` or `.env.preview` first (the sandbox token and its
location, `MAIL_DRIVER=outbox`, that deploy's `SITE_URL`), then
`.env` for the rest. `bin/nff` with no arguments prints the commands:
customers (list, show, set, delete), address (approve, deny), orders
(list with `--open`, `--status`, `--email`; show; confirm `[<id>]
[--at H] [--until H]`, where no id prints how many pickups wait and
the oldest one; deny; cancel `[--refund] [--amount] [--reason]`;
refund `[--amount] [--reason]`; fulfil; delete), returns resolve,
stock (list, set), login and masquerade (a single-use sign-in link,
opened for you), audience (invite, sync), jobs (run, history), health.
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
- **Refunds from the CLI**, Square and PayPal both. A denied pickup
  window means the customer picks a new time or takes a refund, their
  choice.
- **No Google Sheet.** Square is the system of record; the function log
  is the fallback record.
- **Catalog version 2026-v6, keyed by SKU.** The spec's 2026-v5 list of
  31 keyed by `group.item` is superseded. Its 20 in-stock items are the
  same 20; v6 adds Medium and Pullet eggs, Cornish Hens, Ground Chicken
  and splits the sausage flavors.
- **Stock set as of 17 September 2026** is the 2026-v3 flyer's 20 line
  items. The August home-page update lists Cornish hens and sweet
  Italian sausage as on hand, and the processor receipts show 133 packs
  of sweet Italian received on 24 July, so those flags may be stale.
  `bin/stock` is the tool; the freezer count decides.
- **Fee waiver at `subtotal >= 150`**, copy says "$150 or more". The v4
  PDF's "over $150" would charge $5 on exactly $150.
- **$40 minimum is a hard block** with pickup and the drop site as the
  escape hatch, both without a minimum.
- **No South County option.** Dropped on 18 September 2026, along with
  the demand vote.
- **Sold-out items are not rendered**, and a category with nothing in
  stock is left out along with its nav pill. The data keeps them.
- **The order page is the product list**, headed "All products" (the
  `heading` front-matter param; the title stays "Order" for the tab
  and the breadcrumb). A "Catalog" sidebar (Bootstrap ScrollSpy)
  becomes an offcanvas drawer below `lg`; the active category's
  heading slides right and a chevron slides in beside it. One section
  per category with its unit by the heading; each product a row card
  with the unit price and an Add button, rightmost, that morphs into
  a stepper. Buttons take their height from padding, never a fixed
  height.
- **The cart.** From `xl` it is a column to the right of the catalog,
  under the page heading, about 60/40, and sticks to the top for the
  length of the page like the sidebar. Below `xl` it floats above the
  list while it scrolls and a caret folds it down to the total and
  the Next button. It itemises every line (name, quantity at the unit
  price, subtotal, or "0 items"), then subtotal, discount and fee
  ("Free" when waived), the discount code field, then the total under
  the line, and Next, which scrolls to Your details. Lines are grouped
  under their category with the tiers indented beneath, at 0.875rem.
  The "Next discount" nudge is hidden at the top tier. There is no
  Empty cart; a saved draft is restored silently. The badges are one
  dotted line of 0.7rem text, the delivery pair then the tiers, muted
  until earned and then primary green and italic; a handful of chicks
  hop out of one the moment it lights (`celebrate.js`, on a small
  canvas around the badge). Below `lg` the page title rides in the
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
  N minutes to get your order on our next delivery day", and a yellow
  note in the same style says that placing a delivery order is agreeing
  to the policy at `/delivery-policy`. The note has a dismiss that is
  remembered in `localStorage`. No drop-off contact name or phone: the
  customer's own name and phone go to Square as the recipient.
- **West Greenwich is ZIP 02817.** The v4 PDF prints 02818, which is
  East Greenwich. Corrected in `data/delivery.json`.
- **The `/venmo` redirect stays** for the PDF and the market signs.
- **`/order-form.pdf` stays** until launch day.
- **HSTS raised to a year** in the same commit that touched the header
  block for `form-action`, as the audit asked.
- **Order ids** are `NFF-YYMM-XXXX` with the tail derived from the
  submission key, so a retry reuses the id.

## History

From the launch on 2026-09-19 until this change, an order was
recorded at submission as `submitted` and paid later through a Square
invoice emailed to the customer, with payment reminders, abandonment
at the cutoff, an optional bank transfer, and Venmo taken by hand and
matched from Venmo's notification email. All of that is gone, and
issue #112 (the Venmo matching problem) closes with it.

## Local development

`npm run start:functions` runs `netlify dev`, which starts the Hugo
server and proxies the functions at <http://localhost:8888>. Put the
Square sandbox credentials, `SQUARE_APPLICATION_ID` and, for Venmo,
the PayPal sandbox pair in `.env` (ignored). Without them
`/api/checkout/config` answers with nulls, the page says online
payment is unavailable, and `/api/orders` answers `502` after
validation, which is enough to exercise the form. The staging deploy
(`docs/staging.md`) is where a payment is exercised end to end.

## Shipping scope

Sign-in and the account pages were out of the first launch and came
on 2026-09-22, for the self-service a denied pickup window needs:
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
4. **Nothing left unpaid.** `bin/nff orders list --status=submitted`
   must print "No orders." before the deploy: the code that would
   have chased those is gone, and the `legacy.unpaid` invariant will
   alert on any that remain. Settle them by hand first.
5. **Prove it on staging.** One card payment, one decline, one Venmo
   payment, a refund from the CLI, both webhooks; the QA guide has
   the steps.
6. **Merge and deploy** per the branch rules, then place one real $7
   egg order on the live site, confirm the receipt and the Square
   order with its fulfilment, and refund it from the CLI.
