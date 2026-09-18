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
- **South County vote sits inside the disabled card**, always visible.
- **Out-of-stock items are shown greyed and unselectable**, matching
  the v4 PDF, which lists everything.
- **No Connecticut meat-only rule.** Lifted; the six CT towns stay.
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
