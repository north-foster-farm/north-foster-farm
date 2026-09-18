# The order form at `/order`

The form takes an order, recomputes every figure on the server, creates
a Square order with a fulfilment, and publishes a Square invoice. Square
emails the pay link, the reminders and the receipt. Nothing is charged
at submission. The customer's browser holds the only draft.

```
/order  (Hugo page, catalog and terms inlined as JSON)
   │  GET  /api/dates    dates and the server clock, on load
   │  POST /api/orders   validate, recompute, revalidate the date, Square
   ▼
netlify/functions/{dates,orders}.mjs
   └── lib/square.mjs   customer → order → invoice → publish
```

## Sources of truth

- `data/catalog.json`: prices, SKUs and stock. Read by the page, the
  functions and `bin/stock`.
- `data/delivery.json`: terms, date rules, holidays and the delivery
  area. Read by the page, the functions and the policy page.

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

The Square import CSV is generated from the same table and reads this
file for availability, so the two cannot drift.

### Stock

`bin/stock` walks the catalog one keypress per item, shows a diff,
writes the file, and offers to commit and push. Pushing `main` deploys.

## Rules

Money is integer cents, in this order. Client figures are display only.

```
subtotal    = Σ qty × unitPrice
discount    = highest tier where subtotal >= threshold   (never stacked)
deliveryFee = delivery && subtotal < 150.00 ? 5.00 : 0    (pre-discount)
total       = subtotal - discount + deliveryFee
minimum     = delivery only: subtotal - discount >= 40.00
```

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

Server responses the client acts on: `200` created, `422` field errors,
`409` stale date with a fresh list, `503` transient and retried, `204`
dropped silently (honeypot or rate limit).

## Recovery without a datastore

1. The whole form autosaves to `localStorage` on every change and is
   restored on return with a discard control.
2. One idempotency key is minted per submission and kept across
   retries. Every Square mutation derives its key from it, so no retry
   can double-create.
3. The function retries 429, 5xx and network errors three times.
4. A `503` leaves a pending record in the browser, which retries on
   backoff, on `online`, on `visibilitychange` and on the next load.
   A panel under the submit button shows the attempt count, a live
   countdown to the next try, a Try now and a Stop trying button; the
   submit button is disabled while a retry is scheduled.
5. After six attempts the customer sees the order as selectable text, a
   prefilled `mailto:` and the phone number. Every terminal failure is
   one structured `console.error` in the function log, with the whole
   order, so nothing is lost.

## Square

Environment variables, set in Netlify, never in the repo:

- `SQUARE_ACCESS_TOKEN`: an app token with `CUSTOMERS_READ`,
  `CUSTOMERS_WRITE`, `ORDERS_WRITE` and `INVOICES_WRITE`.
- `SQUARE_LOCATION_ID`: the location invoices are issued from.
- `SQUARE_ENV`: `sandbox` (the default) or `production`.
- `SQUARE_VERSION`: optional, defaults to `2026-09-16`.

Per order: search the customer by email or create one; create the
order with a `PICKUP` or `DELIVERY` fulfilment scheduled for the chosen
day, an order-scope discount and a delivery-fee service charge; create
the invoice with the customer as recipient, card payment, due the day
before fulfilment; publish it. The paid order then appears in the
Square dashboard with its fulfilment, which answers the open question in
the spec about what happens after payment.

Not yet exercised against a real account: the sandbox has not been
credentialed from this environment. The unit tests mock `fetch` and
check every request body and idempotency key.

## Records

Orders are persisted in Netlify Blobs (`netlify/functions/lib/store.mjs`
is the seam; memory off Netlify) after Square has invoiced them, with
the Square ids, and a customer record is created or touched by email.
`lib/records.mjs` owns the documents and the indexes: `order/<id>`,
`by-email/<email>/<id>` and `open/<id>` for orders the jobs still
watch (submitted, paid). Statuses: submitted, paid, fulfilled,
cancelled, abandoned. Square stays the system of record for money.

## Mail

`lib/mail.mjs` sends through Resend when `MAIL_DRIVER=resend`,
`RESEND_API_KEY` and `MAIL_FROM` are set, otherwise to the function
log. `MAIL_REPLY_TO` and `ADMIN_EMAILS` (comma-separated) are
optional. `lib/templates.mjs` holds every message as a pure function
with tests: complete your order, order confirmed, payment reminders
(soon, nextDay, final), delivery reminder, address review, sign-in
link. With the farm's mail configured, the Square invoice is created
`SHARE_MANUALLY` and our email carries the pay link; without it Square
emails the invoice. Links point at `SITE_URL`, else Netlify's
`DEPLOY_PRIME_URL`, else `URL`.

## Payment

`POST /api/square/webhook` takes Square's invoice events, verified
with `SQUARE_WEBHOOK_SIGNATURE_KEY` against the registered URL
(`SQUARE_WEBHOOK_URL`, else the site's `/api/square/webhook`). In the
Square developer dashboard, subscribe the app to `invoice.payment_made`
and `invoice.updated` at that URL and copy the signature key. A paid
invoice moves the order to `paid` and sends the confirmation once;
a cancelled invoice cancels the order. `lib/payments.mjs` owns this
and the poll that asks Square about unpaid orders when a webhook was
missed.

## Schedule

`netlify/functions/jobs.mjs` runs every 15 minutes (Netlify scheduled
function) and calls `lib/jobs.mjs`, which decides in
`America/New_York` from the records alone:

| When                                   | What                      |
| -------------------------------------- | ------------------------- |
| every run                              | poll Square for unpaid    |
| 30 min after placing, unpaid           | reminder `soon`           |
| 24 h after placing, unpaid             | reminder `nextDay`        |
| 8:00 the day before fulfilment, unpaid | reminder `final`          |
| delivery cutoff (Wed noon) or midnight before a pickup, unpaid | `abandoned`, invoice cancelled |
| 18:00 the day before a paid delivery   | cooler reminder           |
| the day after fulfilment, paid         | `fulfilled`               |

Sends are noted on the order under `emails`, so a repeat run sends
nothing twice and a late run sends only the most urgent reminder.

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

## Account

`/account/` is one page with tabs (Orders, Invoices, Address,
Settings, Help) rendered from `GET /api/me` and
`GET /api/account/orders`. `lib/account.mjs` holds the rules:

- Cancel: unpaid orders close at once (Square invoice and fulfilment
  cancelled); paid orders are flagged `cancelRequested` and the farm
  refunds in Square, then closes the order in the CLI. Allowed until
  the abandon time (delivery cutoff, or midnight before a pickup).
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

Avatars are the six SVG symbols in `layouts/partials/avatars.html`,
keyed by `data/avatars.json`. The header (`session.js` in the site
bundle) asks `/api/me` once per five minutes, cached in
`sessionStorage`, and shows a Sign in link or the avatar menu.

## Decisions

- **Square Orders plus Invoices**, not Payment Links. Publishing an
  invoice is what makes Square send the link and the receipt.
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
- **The order page is the product list.** No intro prose; a category
  sidebar (Bootstrap ScrollSpy) that becomes an offcanvas drawer below
  `lg`; one section per category; each product a row card with the
  unit price, an Add button that morphs into a stepper, and the line
  total once a quantity is set. Row cards and the summary use the
  theme's small shadow instead of rules. The summary panel floats
  above the list while it scrolls and settles into the flow after the
  last row. It carries text-only badges (Local delivery, each bulk
  tier, Free delivery) that turn green when earned, the one-line nudge,
  and a Checkout button that scrolls to the fulfilment cards. A dozen
  feathers drift from the pointer once when the $40 line is crossed.
  Everything the panel says comes from `lib/summary.mjs`, whose tests
  pin every sentence and prove the nudge's promise against the totals
  at every cent to $250. The design spec behind the page lives in
  `.ignored/handoffs/online-orders-but-fable/design-critique.md`.
- **"Your order isn't final until it's paid"** is said twice: in a
  note above the Place your order button and as the headline of the
  success state.
- **Browser support** is set by `:has()`, `inert` and `color-mix()`:
  Safari 16.2, Chrome 111, Firefox 121 and later. Media queries use
  classic min/max-width for Safari before 16.4.
- **Connecticut is eggs only for now.** Chicken cannot be sold there
  yet. A CT ZIP with any non-egg line is rejected, the ZIP field says
  why as it is typed, and `onlyGroups` on the state entry in
  `data/delivery.json` is the switch.
- **The delivery terms are shown and linked, not ticked.** Four lines
  and a link to the policy sit above the delivery fields; placing the
  order is the agreement. No drop-off contact name or phone: the
  customer's own name and phone go to Square as the recipient.
- **West Greenwich is ZIP 02817.** The v4 PDF prints 02818, which is
  East Greenwich. Corrected in `data/delivery.json`.
- **No Venmo on `/order`.** The `/venmo` redirect stays for the PDF.
- **`/order-form.pdf` stays** until launch day.
- **HSTS raised to a year** in the same commit that touched the header
  block for `form-action`, as the audit asked.
- **Order ids** are `NFF-YYMM-XXXX` with the tail derived from the
  submission key, so a retry reuses the id. Square's invoice number is
  the sequential one the customer sees.

## Local development

`npm run start:functions` runs `netlify dev`, which starts the Hugo
server and proxies the functions at <http://localhost:8888>. Put Square
sandbox credentials in `.env` (ignored). Without them `/api/orders`
answers `502` after validation, which is enough to exercise the form.

## Before launch

- Export the Square item library as a backup, seed the catalog, and
  fill `squareVariationId` in `data/catalog.json`.
- Set the four environment variables on Netlify.
- Run the manual checks in the build plan on a deploy preview: a
  twelve-SKU order on a phone, a $35 delivery, the three ZIP cases, a
  Wednesday-noon rollover, keyboard and screen-reader passes, a killed
  network mid-submit, and one real sandbox invoice.
- Point the Google Form and the PDF at `/order`, then retire them.
