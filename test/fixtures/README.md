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
| `customers-search-email-refused` | the search for an address Square refuses: 400 INVALID_VALUE on `email` (#678). The recorder keeps the first of its candidates the sandbox refuses; on 2026-11-19 that was two periods in a row before the `@`. Recorded in the sandbox 2026-11-19. |
| `customer-create`, `customer-create-replay` | creates the profile; the same key again |
| `customer-update`, `customer-delete`, `customer-delete-gone` | `renameCustomerEmail`, `deleteCustomer` (404 once gone) |
| `customer-update-reference` | `setCustomerReference`: a member's code as the profile's `reference_id` (#131). Recorded in the sandbox 2026-11-12. |
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

## GitHub

Recorded with `gh api` and scrubbed of author names, emails and the
actor's login. Each JSON file's `_source` names its requests and date.

| Fixture | What it stands in for |
| --- | --- |
| `github/e2e-staging-runs.json` | the full staging runs `bin/promote.mjs` reads |
| `github/e2e-dispatch.json`, `-failed.txt`, `-gate.txt` | a dispatch of `e2e.yml`, a queued, a passed and a failed run, their jobs and the failed jobs' logs, for `bin/nff e2e` (#610) |
| `github/e2e-exempt.json`, `e2e-exempt-*.txt` | the two full staging runs of 2026-11-18 and three `e2e.yml` runs, their jobs and shard logs, and staging's pushes, for the staging exemption (#654); the failed `e2e.yml` run's log is `e2e-verdict-escapes.txt` |
| `github/e2e-flaky-issues.json` | the open milestones, open issues of Next release, an issue and a comment, for filing flaky tests (#693) |
| `github/e2e-retry.json`, `e2e-retry-*.txt` | two staging-workflow and two `e2e.yml` runs with Playwright's retries on, from a scratch branch, one holding only a flaky test and one also a test failing every try, their jobs and logs (#693; how they were made is in `test/promote-retry.criteria.mjs`'s header) |

## Still to record by hand

These need a person; none is scripted.

1. **PayPal, Venmo and their webhooks (#708; replaces the by-hand
   steps here, 2026-11-21).** The recorder saves them as they happen:
   `bin/nff record open --production` (or `--staging` for the
   sandbox), pay with Venmo on the order page, refund with
   `bin/nff orders refund <id> --record --production`, check it with
   `bin/nff refunds check --record --production`, wait for both
   webhooks, then `bin/nff record pull --production` and
   `bin/fixtures/scrub --strict`, which fails while any string in a
   request or a response is still to review (2026-11-21: was bare
   `scrub`, which let a webhook's payer through unlisted). Pull writes
   `.ignored/fixtures-raw/` in the
   envelope shape above, `service: "paypal"`; records never pulled are
   deleted after 7 days.
2. **Square webhooks (R4).** One real `refund.updated`, one
   `order.updated` and one `payment.updated` delivery, with the
   `x-square-hmacsha256-signature` header and the notification URL it
   was signed for. Point a sandbox subscription at a request catcher,
   run a payment and a refund, copy the three bodies.
3. **Resend 429.** A real rate-limit answer cannot be asked for; copy
   one from a log if it ever happens.
