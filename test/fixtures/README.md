# Recorded fixtures

Each file under `square/` and `resend/` is a real answer from the
vendor, recorded once and replayed by the tests. A fake that stands in
for a vendor returns these, never an object written by hand (James,
2026-10-26, #471).

## Refreshing them

```
bin/fixtures/record ~/Code/nff/north-foster-farm/.env.staging
```

The env file must say `SQUARE_ENV=sandbox`; the script refuses any
other. It sends the requests our own code builds (`bin/fixtures/request.mjs`
runs `lib/square.mjs` and `lib/mail.mjs` against a stub and prints what
they would send) to Square's sandbox with HTTPie, chains the ids from
one answer into the next, and keeps each raw answer in
`.ignored/fixtures-raw/` (git ignores it). It then runs
`bin/fixtures/scrub`, which writes the files here. The token is never
printed or written. It adds a Resend send to `delivered@resend.dev`
only if the env file holds `RESEND_API_KEY` and `MAIL_FROM`; staging
holds no Resend key by design, so by default it skips that.

`bin/fixtures/scrub` alone redoes the scrubbing from the raw files. It
lists the paths of any strings that no rule covers and that do not look
harmless; add a rule for each, never edit a fixture by hand.

## What a file holds

```json
{
  "_source": { "service": "square", "environment": "sandbox",
    "recorded": "2026-10-26", "squareVersion": "2026-09-16", "by": "..." },
  "status": 200,
  "request": { "method": "POST", "path": "/v2/payments",
    "headers": {}, "body": {} },
  "response": {}
}
```

`response` is the body the vendor sent and `status` its HTTP status.
`request` is what our code sent, so a test can hold the code to it.
Ids, idempotency keys, fingerprints, emails, phone numbers, names and
addresses are placeholders (`ORDER_ID_1`, `customer@example.com`). The
same value has the same placeholder in every file, so the payment in
`payment-card-ok` is the one `order-get-paid` lists as a tender.
`test/recorded.mjs` loads them.

## Who uses them

- `lib/fake-square.mjs` (SQUARE_ENV=fake) answers every Square call with
  a recording, with the request's ids, amounts and status put in, and
  read by the same code that reads Square's answers. It remembers what
  it was told in this process (`forgetFake()` clears it) and refuses
  what Square refused: a payment off the order's total (over or under;
  there are no part payments), on a paid order, or for nothing; a refund
  over what is left; a payment key reused with another body; a payment
  on a cancelled order. It takes what Square took: an order key reused.
  The refusal it throws is the recorded one. (2026-10-29: the cancelled
  order moved to the refusals with `payment-order-canceled`.) Its
  `getOrder` lists the order's own discounts and service charges in
  the shapes of `order-get-line-discount` and
  `order-get-discount-fee-zero`, and leaves the key out when there are
  none, as Square does.
- `test/square-replay.test.mjs` serves the recordings to the real
  functions of `lib/square.mjs` and holds what they send to what each
  was recorded with. Change a request and it fails until the recorder
  runs again.
- `test/fake-square.test.mjs` holds the fake to Square's rules.
- `test/fake.test.mjs` and `test/square.test.mjs` take their Square
  bodies from here. `test/recorded.mjs` loads and serves them.
- `test/mail-replay.test.mjs` does the same for Resend, if recorded.

## Square

| Fixture | What our code does |
| --- | --- |
| `locations-list` | `customerOrders` lists the account's locations |
| `customers-search-none`, `-found` | `findOrCreateCustomer` searches by email |
| `customer-create`, `customer-create-replay` | creates the profile; the same key again |
| `customer-update`, `customer-delete`, `customer-delete-gone` | `renameCustomerEmail`, `deleteCustomer` (404 once gone) |
| `order-create-pickup`, `-delivery`, `-external`, `-cash` | `createOrder` (`buildOrder`) |
| `order-create-catalog` | a line by `catalog_object_id`; only if the sandbox has a catalog |
| `order-create-replay`, `order-create-key-reused` | the same key and body; the same key, another body |
| `order-create-zero`, `order-pay-zero`, `order-get-zero-paid` | a $0 change order paid with `PayOrder` and no payment ids (the credit path) |
| `payment-card-ok` | `createPayment` with `cnon:card-nonce-ok` |
| `payment-card-declined`, `-rejected-cvv`, `-rejected-postalcode`, `-rejected-expiration` | the sandbox's decline nonces |
| `payment-external`, `payment-cash` | a Venmo tender recorded on Square; cash taken by the farm |
| `payment-replay`, `payment-key-reused` | the same key; the same key with another amount |
| `payment-already-paid`, `payment-order-canceled` | a payment on an order already paid, and on one cancelled |
| `payment-zero-amount`, `payment-zero-order` | a $0 card payment, alone and against a $0 order |
| `payment-over-total`, `payment-under-total`, `order-get-part-paid` | more than the order total (refused), and part of it |
| `order-create-short` | the order those two pay |
| `payment-get`, `payment-get-refunded` | `getPayment`, before and after a refund |
| `refund-create`, `refund-replay`, `refund-get`, `refund-too-large` | `refundPayment`, `getRefund`, and a refund over what is left |
| `order-get-paid`, `-paid-external`, `-paid-cash` | `getOrder` with its tenders |
| `order-get-open`, `-before-cancel`, `-canceled`, `-after-refund`, `-completed`, `-catalog` | `getOrder` in each state the code reads |
| `order-update-fulfillment` | `updateFulfillment` (a customer's change) |
| `fulfillment-cancel`, `order-update-stale-version` | `cancelFulfillment`; the same version again (VERSION_MISMATCH) |
| `order-complete` | `completeOrder` |
| `order-cancel-refused` | the order alone, cancelled while its fulfillment is open: 400 INVALID_VALUE |
| `order-cancel-fulfillment`, `order-cancel`, and the same with `-catalog` | `cancelOrder` after a decline: the fulfillment, then the order |
| `orders-search-recent`, `-open`, `-customer` | `findPaid`, `searchOpenOrders`, `customerOrders` |
| `catalog-search` | the recorder's own lookup of a sandbox variation id; no function of ours searches the catalog since staging's stock moved to production's `/api/stock` |
| `inventory-counts` | `inventoryCounts` |
| `order-create-line-discount`, `order-get-line-discount`, `order-cancel-line-discount` | `createOrder` with a LINE_ITEM discount per member-priced item (#514) |
| `order-create-discount-fee-zero`, `order-get-discount-fee-zero`, `order-cancel-discount-fee-zero` | `createOrder` with one ORDER discount and a $0 delivery service charge (#514) |

## Resend

| Fixture | What our code does |
| --- | --- |
| `resend-send` | `sendMail` with html, Reply-To, a header and an attachment |
| `resend-send-refused` | the same send from a sender the key may not use |
| `resend-send-invalid` | a send Resend rejects with 422 |

## Still to record by hand

These need a person; none is scripted.

1. **PayPal and Venmo (PY-14, #151).** With a sandbox buyer and
   `PAYPAL_ENV=sandbox`: create an order through the staging order page
   (or `POST /v2/checkout/orders`), approve it as the buyer in a
   browser, capture it, `GET` the order, refund the capture, `GET` the
   refund. Save each raw body to `.ignored/fixtures-raw/` in the same
   envelope shape (`name`, `service: "paypal"`, `seq`, `status`,
   `request`, `response`) and run `bin/fixtures/scrub`. Do it once with
   a card and once with Venmo (`enable-funding=venmo`), and once with
   a capture left `PENDING` if the sandbox can produce one.
2. **PayPal webhooks.** One real `PAYMENT.CAPTURE.COMPLETED` and one
   `PAYMENT.CAPTURE.REFUNDED` delivery, with the headers PayPal signed.
3. **Square webhooks (R4).** One real `refund.updated`, one
   `order.updated` and one `payment.updated` delivery, with the
   `x-square-hmacsha256-signature` header and the notification URL it
   was signed for. Point a sandbox subscription at a request catcher,
   run a payment and a refund, copy the three bodies.
4. **Resend 429.** A real rate-limit answer cannot be asked for; copy
   one from a log if it ever happens.
