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
down on placing, back up on cancel or abandon. `GET /api/stock` gives
every item's `{ inStock, available }`; the page asks on load, on
return to the tab, every two minutes and before submitting, closes
sold-out rows, shows "N left" at five or fewer, clamps the cart and
says so. The order handler checks the same counts and answers `422`
with `lines.<sku>` errors plus the fresh `stock`.

## Rules

Money is integer cents, in this order. Client figures are display only.

```
subtotal    = Σ qty × unitPrice
bulk        = highest tier where subtotal >= threshold   (never stacked)
group       = customer's discountGroup percent × subtotal (signed in)
discount    = max(bulk, group)                            (never both)
deliveryFee = delivery && subtotal < 150.00 ? 5.00 : 0    (pre-discount)
total       = subtotal - discount + deliveryFee
minimum     = delivery only: subtotal - discount >= 40.00
```

`money.discountGroups` in `data/delivery.json` names the groups
(`friends` 10%, `wholesale` 20%). A customer's group lives on their
record and is set by the CLI; the order handler reads it from the
session, never from the payload. `totals.discountLabel` names whichever
discount applied and is what every surface shows.

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
note. On-farm pickup asks only
for the day and the window; delivery asks for the address, the town,
the ZIP, where the cooler will be and optional notes.

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
the invoice with the customer as recipient, due the day before
fulfilment, payable by card and, when the date is at least five
business days out, by bank transfer; publish it. The paid order then
appears in the Square dashboard with its fulfilment, which answers the
open question in the spec about what happens after payment.

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

A customer record (`customer/<email>`) keeps the name, phone, avatar,
pricing group, delivery address and `reminders`, the two reminder
emails as `{ payment, delivery }` booleans; a key that is missing
means on, so records from before the setting existed behave as they
did. `reminderPrefs(customer)` in `lib/records.mjs` is the one reading.

## Mail

`lib/mail.mjs` sends through Resend when `MAIL_DRIVER=resend`,
`RESEND_API_KEY` and `MAIL_FROM` are set, otherwise to the function
log. `MAIL_REPLY_TO` and `ADMIN_EMAILS` (comma-separated) are
optional. `lib/templates.mjs` holds every message as a pure function
with tests: complete your order, order confirmed, payment reminders
(soon, nextDay, final), delivery reminder, order changed, order
cancelled, address decision, sign-in link, and to the farm: address
review, order placed, order paid. The reminders carry a "Turn off
... reminders" link to the account page's settings tab; the jobs run
reads the customer's `reminders` before each one and skips, and
reports as `muted`, any the customer turned off. Abandonment and
fulfilment run on their clocks regardless. The wording is James's (review of
2026-09-22). Every customer message ends on a "Your orders | Contact
us" row and the farm's on "Admin"; `mailLinks(env)` in `lib/site.mjs`
supplies those from `ACCOUNTS_ENABLED`, `CONTACT_URL` (else the farm's
mailbox) and `ADMIN_URL` (default admin.northfosterfarm.com; the order
and customer pages it links to arrive with the dashboard's order
views). A resolved return sends nothing: James answers those himself.
With the farm's mail configured, the Square invoice is created
`SHARE_MANUALLY` and our email carries the pay link; without it Square
emails the invoice. Links point at `SITE_URL`, else Netlify's
`DEPLOY_PRIME_URL`, else `URL`.

Two of the messages go to the farm rather than the customer, to every
address in `ADMIN_EMAILS`: `farmOrderPlaced` when the invoice is
published and `farmOrderPaid` when it clears. Square notifies nobody
about an invoice the farm's own account issued, so without these the
farm learns of an order only by looking. Each carries the fulfilment
sentence, how to reach the customer, the drop-off details for a
delivery, the lines, the totals and a link into the Square Dashboard.
Both are recorded under the order's `emails`, like every other send,
so a retried submission or a second payment event never sends twice;
with `ADMIN_EMAILS` unset they are skipped.

## Payment

`POST /api/square/webhook` takes Square's invoice events, verified
with `SQUARE_WEBHOOK_SIGNATURE_KEY` against the registered URL
(`SQUARE_WEBHOOK_URL`, else the site's `/api/square/webhook`). In the
Square developer dashboard, subscribe the app to `invoice.payment_made`
and `invoice.updated` at that URL and copy the signature key. A paid
invoice moves the order to `paid`, sends the customer's confirmation
and tells the farm, each once however many times the news arrives;
a cancelled invoice cancels the order. A bank transfer leaves the
invoice `PAYMENT_PENDING` for days; the order is held meanwhile (no
reminders, not abandoned at the cutoff, not confirmed) until Square
reports `PAID`, or `UNPAID` again when the transfer failed. The jobs
also take the bank option off an unpaid invoice once its date comes
within five business days (`bankTransferClosedAt` on the order's
`square` record), so a slow payer cannot pick it at the last minute.
`lib/payments.mjs` owns this and the poll that asks Square about
unpaid orders when a webhook was missed.

## Schedule

`netlify/functions/jobs.mjs` runs every 15 minutes (Netlify scheduled
function) and calls `lib/jobs.mjs`, which decides in
`America/New_York` from the records alone:

| When                                   | What                      |
| -------------------------------------- | ------------------------- |
| every run                              | poll Square for unpaid    |
| 1 h after placing, unpaid              | reminder `soon`           |
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
- Settings: name, phone, avatar, and the two reminder emails (payment,
  delivery) as checkboxes, saved through `PATCH /api/account/profile`
  as `reminders: { payment, delivery }`. The invoice, confirmations
  and order changes cannot be turned off.
- Add again and Reorder: plain links to `/order/?add=SKU:qty,...`.
  The order page merges the quantities into the cart on load, names
  anything no longer sold, saves the draft, scrolls to the summary
  and clears the query. The live stock check then clamps if needed.

Avatars are the six SVG symbols in `layouts/partials/avatars.html`,
keyed by `data/avatars.json`, shown on the account page only. The
header (`session.js` in the site bundle) asks `/api/me` once per five
minutes, cached in `sessionStorage`, and shows a Sign in link or an
Account menu (orders, invoices, settings, sign out).

## CLI

`bin/nff` is the farm's admin surface; there are no admin pages. It
reads `.env` from the repo root and needs `NETLIFY_SITE_ID` and
`NETLIFY_AUTH_TOKEN` (a personal access token) to reach the site's
Blobs stores, plus the Square and mail variables for anything that
talks to them; without the Netlify pair it runs against memory and
says so. `bin/nff` with no arguments prints the commands: customers
(list, show, set, delete), address (approve, deny), orders (list,
show, paid, cancel, fulfil, delete), returns resolve, stock (list,
set), login and masquerade (a single-use sign-in link, opened for
you), jobs run. `lib/admin.mjs` holds the rules with tests.

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
  ("Free" when waived), then the total under the line, and Next,
  which scrolls to Your details. Lines are grouped under their
  category with the tiers indented beneath, at 0.875rem. The "Next
  discount" nudge is hidden at the top tier. There is no Empty cart; a
  saved draft is restored silently. The badges are one dotted line of
  0.7rem text, the delivery pair then the tiers, muted until earned
  and then primary green and italic; a handful of chicks hop out of
  one the moment it lights (`celebrate.js`, on a small canvas around
  the badge). Below `lg` the page title rides in the sticky Jump to
  bar beside the button.
  Everything the panel says comes from `lib/summary.mjs`, whose tests
  pin every sentence and prove the nudge's promise against the totals
  at every cent to $250. The design spec behind the page lives in
  `.ignored/handoffs/online-orders-but-fable/design-critique.md`.
- **Forms are horizontal**: a label column and a field column. A
  signed-in customer's name, email and phone arrive as plain text
  under a "Click to edit" hint; a click makes one a field again.
- **"You must pay the invoice to complete your order"** is the note
  above the Place your order button, set large; the success state's
  headline says it again.
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

## Shipping scope

Sign-in and the account pages are out of scope for the first launch:
`params.features.accounts` in `config/_default/hugo.toml` is `false`,
which drops the Sign in link from the header, and the cascade beside
it stops `/login/` and `/account/` from being built. The functions
behind them stay deployed and idle, and emails carry no account link
until `ACCOUNTS_ENABLED=true` is set on Netlify. Flip the flag, remove
the cascade and set that variable to bring them back; nothing else
changes.

What the order flow needs to run in production is Square and nothing
else. Netlify Blobs is part of Netlify and needs no account. Mail is
optional: without it Square emails the invoice and the receipt itself,
the reminders and the address-review notes go to the function log,
and the scheduled job still cancels unpaid invoices at the cutoff.

## Before launch

In order. The first two are today's work; the market is tomorrow.

1. **Seed the Square catalog.** The import CSV is at
   `.ignored/handoffs/online-orders-v1/square-catalog-2026-v6/`
   (`Items-Table 1.csv`). Export the current item library first as a
   backup, then Items → Actions → Import in the Square dashboard.
   Rename the two sausage variations to "Maple breakfast links" and
   "Sweet Italian links" to match the site, and check that the twenty
   in-stock items are enabled at the market location so the Square
   app on the phone sells them tomorrow.
2. **Copy the variation ids.** Export the library after the import and
   paste each variation's token into `squareVariationId` in
   `data/catalog.json`. Until then the order handler sends ad hoc
   line items with the same names and prices, which is enough to sell.
3. **Production credentials.** In the Square developer dashboard make
   a production access token with `CUSTOMERS_READ`, `CUSTOMERS_WRITE`,
   `ORDERS_WRITE` and `INVOICES_WRITE`. On Netlify set
   `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID` and
   `SQUARE_ENV=production` for the production context, and the sandbox
   pair with `SQUARE_ENV=sandbox` for deploy previews, so a preview can
   never invoice a real customer. Set `SITE_URL` to the primary URL.
4. **Payment detection.** Register a webhook for `invoice.payment_made`
   and `invoice.updated` at `https://www.northfosterfarm.com/api/square/webhook`
   and set `SQUARE_WEBHOOK_SIGNATURE_KEY`. If this waits, the
   15-minute poll marks orders paid on its own; the webhook only makes
   it immediate.
5. **The CLI.** Put `NETLIFY_SITE_ID` and a Netlify personal access
   token as `NETLIFY_AUTH_TOKEN` in `.env` so `bin/nff orders list`
   reads the live records.
6. **Prove it on the deploy preview.** A twelve-SKU order on a phone, a
   $35 delivery, the three ZIP cases, keyboard and screen-reader
   passes, a killed network mid-submit, and one sandbox invoice paid
   with a sandbox card: the order should turn `paid` within fifteen
   minutes and appear in `bin/nff orders list`.
7. **Merge and deploy** per the branch rules, then place one real $7
   egg order on the live site, pay it, confirm the receipt and the
   Square order with its fulfilment, and refund it.
8. **Retire the Google Form and the PDF**: point both at `/order`.
9. **Later, not blocking:** a Resend account and verified domain
   (`MAIL_DRIVER=resend`, `RESEND_API_KEY`, `MAIL_FROM`,
   `MAIL_REPLY_TO`, `ADMIN_EMAILS`) for the farm's own reminders and
   notices, then sign-in and accounts, which depend on mail.
