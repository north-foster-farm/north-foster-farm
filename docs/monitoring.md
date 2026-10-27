# Monitoring

What watches the order path, what each signal means, and what to do
when one fires. Everything here degrades to nothing when its variable
is unset, so a preview or a local run monitors nothing and alerts
nobody.

Two services page the phone, and they watch from opposite sides.
UptimeRobot looks at the site from outside: it fetches pages and
functions and pushes when one stops answering as it should.
Healthchecks only receives: the site pings it, and it pushes when a
ping is a failure or stops coming. Neither can see what the other
sees, so a dead page and a silent failure both reach the phone.

## The pieces

- **Health endpoint.** `GET /api/health`
  (`netlify/functions/health.mjs`): the last hour from the records,
  200 or 503. Needs nothing.
- **Outside monitors.** UptimeRobot, free plan, on production `www`:
  the home page, the order page and three functions, each fetched
  every five or fifteen minutes and checked for a keyword (the table
  below). Its app pushes "down" and "up". Needs the account; no
  variable.
- **Jobs heartbeat.** The 15-minute run pings a healthchecks check
  when it ends well, and its `/fail` URL with the report when it does
  not. `HEALTHCHECKS_JOBS_URL`.
- **Alerts.** `alert()` in `lib/health.mjs`: a developer email per
  failure kind per hour, and a `/fail` ping to a second check followed
  at once by a success ping, so every alert pushes "down" then "up" and
  the next one pushes again. `DEV_NOTIFICATIONS_EMAIL`,
  `HEALTHCHECKS_ALERT_URL`.
  `bin/nff alert test` proves both channels.
- **Backup heartbeat.** The nightly backup export (`docs/backup.md`)
  pings a third check when its copy lands in R2, and `/fail` with
  `backup.failed` when it does not. `HEALTHCHECKS_BACKUP_URL`.
- **Packing slips heartbeat.** The 6:00 packing slips (#292,
  `lib/packing.mjs`) ping a fourth check once the email has gone, a
  quiet day's included, and its `/fail` with the error when the PDF
  could not be built or sent. Production only, and required there:
  `check:env` fails a production build without
  `HEALTHCHECKS_PACKING_URL`, and a run that sends through Resend
  without it is a jobs error. A staging run never pings it.
- **Production audit heartbeat.** A daily workflow (`prod-audit.yml`)
  audits the deployed lockfile for known vulnerabilities and pings a
  check per repository: a plain ping when clean, `/fail` with the
  findings in the body when not. Set the check to a period of one day
  and a grace of three hours. `PROD_AUDIT_PING_URL`, an Actions secret.
  The log is public and holds counts (`docs/security.md`).
- **Log.** Every JSON line the functions write, shipped per invocation
  to Axiom (`lib/log.mjs`). `AXIOM_TOKEN`, `AXIOM_DATASET`. Every
  line is scrubbed first: fields that hold contact details (the
  customer, addresses, phone, notes, mail text) are removed, an email
  address in any string becomes `[email:<hash>]` (one address, one
  hash), and a phone number becomes `[phone]`. Lines name an order by
  id. The alert pings to Healthchecks are scrubbed the same way.
  `test/log-privacy.test.mjs` fails when a failed order logs any of
  it. A name typed into free text cannot be found by pattern.
- **Run ledger.** Each jobs run's report in the jobs store, two days
  kept; `bin/nff jobs history`. Needs nothing.
- **Morning report.** 8:00 daily, always: the last day in numbers,
  a warning if the pickup schedule runs short, then pickups waiting on
  the customer. `FARM_NOTIFICATIONS_EMAIL`.
- **Tomorrow.** 18:00 daily, always: every order due tomorrow by
  method, with what to pack and where to leave it.
  `FARM_NOTIFICATIONS_EMAIL`.
- **Dated rebuild.** On the day a money change takes effect (`money.
  changes` in `data/delivery.json`, 1 January 2027 for the first), the
  first run posts the build hook once so the pages Hugo rendered catch
  up; `rebuilt` in that run's report, `rebuild/<day>` in the jobs
  store. It needs `PICKUP_SCHEDULE_HOOK` set on Netlify too (`netlify
  env:set`); unset, nothing is posted. A hook that fails is tried
  again each run and shows as a `rebuild` error, for a week.
- **Refund check.** 07:00 daily: every refund not yet settled is asked
  of Square, or of PayPal for Venmo; one that failed or stalled raises
  an alert (#215). `bin/nff refunds check` runs it on demand. Needs
  nothing.
- **Checkout beacon.** The order page posts to `/api/health` when a
  checkout cannot complete; it becomes the `client.checkout_failed`
  alert. Needs nothing.
- **Deploy failures.** Netlify's "Deploy failed" email notification.
  Email only, not the phone, for now (step 4). Set in the Netlify UI,
  no code.
- **Error reporter.** The order page reports its own errors to
  `/api/health` (`assets/scripts/report.js`): `client.error` to the
  log, `client.payment_unavailable` as an alert. Needs nothing; see
  "Browser error reports" below.
- **Deploy failures.** Netlify → Site configuration → Notifications:
  "Deploy failed" by email. Set in the Netlify UI.

## Setting it up

1. **UptimeRobot**, free plan, and its phone app. Monitors on
   `https://www.northfosterfarm.com` (the apex answers 301, so it is
   never the URL):

   | URL | Type | Keyword (must exist) | Every |
   |---|---|---|---|
   | `/` | HTTP(s), status 200 | none | 5 min |
   | `/order/` | Keyword | `id="order-form"` | 5 min |
   | `/api/dates` | Keyword | `"onfarm":[` | 5 min |
   | `/api/health` | Keyword | `"ok":true` | 15 min |
   | `/api/checkout/config` | Keyword | `"applicationId":"sq0idp-` | 5 min |

   - `id="order-form"` is the form in
     `layouts/partials/order/form.html`; a comment there says a
     monitor keys on it.
   - `"onfarm":[` is in every `/api/dates` answer, in season or out
     (`allDates` in `assets/scripts/order/lib/dates.mjs`), so it fails
     only when the function or the schedule does.
   - `/api/health` answers 503 with `"ok":false` when jobs are stale
     or mail keeps failing; the keyword catches both.
   - `"applicationId":"sq0idp-` is Square's production application id
     prefix, so the config monitor also catches a sandbox id in
     production (`sandbox-sq0idb-`). It goes on at the release, when
     the in-page checkout reaches production.

   Only the last three run a function, about 20,000 invocations a
   month; the CDN serves `/` and `/order/`. Alert contact: the app's
   push. Staging gets no monitors, so it never reaches the phone.
2. **healthchecks.io**, free plan. It makes no HTTP checks of its own
   and its free plan sends no SMS; it only receives pings. Two checks
   per site, production's and staging's kept apart, and production's
   *Backup*:
   - *Jobs*: period 15 minutes, grace 30 minutes. Its ping URL goes
     to Netlify as `HEALTHCHECKS_JOBS_URL`.
   - *Alerts*: period 1 day, grace 2 hours. Its ping URL goes to
     Netlify as `HEALTHCHECKS_ALERT_URL`. The morning report pings it
     well once a day; every alert posts to its `/fail` and then pings
     it well. So it pages on every alert, and also if the morning
     report itself stops.
   - *Backup*: period 1 day, grace 2 hours. Its ping URL goes to
     Netlify as `HEALTHCHECKS_BACKUP_URL`, production only, since
     the nightly run is production's alone.
   - *Packing slips*: schedule type Cron, `0 6 * * *`, time zone
     America/New_York, grace 30 minutes. The jobs run sends the slips
     between 6:00 and 6:15 and tries again every 15 minutes after a
     failure, so 30 minutes covers one retry. Its ping URL goes in
     `.env.production` as `HEALTHCHECKS_PACKING_URL`, then
     `bin/nff env push --production`. Production only: staging has no
     packing check. After the release, the next 6:00 run's ping turns
     it green; until then it waits as "new".
   Attach a push integration (Pushover, ntfy, Telegram or Signal) to
   production's four checks only, besides email. Staging's checks get
   email at most, never a phone.
3. **Axiom**, free plan. Create a dataset `nff-site` and an API token
   with ingest rights on it. On Netlify: `AXIOM_DATASET=nff-site`,
   `AXIOM_TOKEN=xaat-...`. Retention on the free plan is 30 days.
4. **Netlify**: Site configuration → Notifications → Deploy
   notifications → *Email notification*, event "Deploy failed", to the
   farm's address. Check one arrives on the Starter plan.

   Netlify's deploy notifications have no branch or context filter:
   each fires for every deploy of the site, staging's and previews'
   included. So for launch the failed deploy goes by email only, and
   nothing posts to Healthchecks. An HTTP POST to the *Alerts* check's
   `/fail` would push James's phone for a failed staging deploy, and a
   success ping on every deploy would satisfy the check's one-day
   period and hide a morning report that stopped.

   What that gives up: a failed production deploy does not buzz the
   phone. It is not an outage, since a failed build publishes nothing
   and the live site stays as it was, but the fix waits until the
   email is read. After launch, if that is too slow: a small function
   that receives Netlify's deploy webhook (JWS-signed), drops any
   deploy whose `context` is not `production`, and posts `/fail` and
   then the success ping to `HEALTHCHECKS_ALERT_URL`, as `alert()`
   does. That gets a phone push for a failed production deploy only,
   with staging kept off the phone and the morning report's watch
   intact.
5. Redeploy. `bin/nff health`, or a GET to `/api/health`, shows which
   pieces are configured under `log` and `heartbeat`.
6. Prove the phone: `bin/nff --production alert test` (below), and
   break the `/order/` keyword for a minute (edit the monitor to
   look for a word that is not there): the app pushes "down", then
   "up" once it is put back.

## Proving the developer address works

`bin/nff mail test-dev [--production|--staging]` sends one real
message to `DEV_NOTIFICATIONS_EMAIL` (dev@), through the same sender
the deploy-failed, alert and rotation notices use, and says whether it
went. Run it once when the address is created, and again after any
change to it or to the mail setup. Nothing falls back to the farm's
address: a dev@ that does not work must not hide behind the farm's
inbox.

```
Developer mail test on production (MAIL_DRIVER resend).
  Sent to DEV_NOTIFICATIONS_EMAIL (1 address). Check the inbox.
```

It prints variable names and a count, never an address. It exits 1,
with the reason, when the variable is unset, when the mail service
refuses the send (the line gives its HTTP status), or when
`MAIL_DRIVER` is not `resend` or `outbox`, which only write the
message where nobody reads it. "Sent" means the mail service accepted
it. Open dev@ in Fastmail and confirm it arrived. With `--staging` the
message goes to the staging outbox (`/api/staging/outbox`), not to a
mailbox.

## Proving an alert reaches the phone

`bin/nff alert test [--production|--staging]` raises one real alert,
kind `alert.test`, through `alert()` itself: the developer email by
`MAIL_DRIVER`, then `/fail` and the success ping to
`HEALTHCHECKS_ALERT_URL`. It skips the hourly limit, so it can be run
again at once, and leaves no mute behind. It refuses when
`HEALTHCHECKS_ALERT_URL` or `DEV_NOTIFICATIONS_EMAIL` is unset, since
an alert there would reach nobody, and prints what it reached:

```
Alert test (alert.test) on production.
  Email: sent to farm@... (MAIL_DRIVER resend).
  Phone: /fail accepted by hc-ping.com; re-arm accepted.
  A down push, then an up push, should reach the phone within a minute.
```

It exits 1 when either channel was not accepted. A driver other than
`resend` or `outbox` (`log`, `file`, or none) only writes the email
where nobody reads it, so the line says "logged only, not sent" and
the exit is 1. With `--production`
the phone gets a "down" and an "up" push within a minute, and a
second run in the same hour pushes again. With `--staging` the email
goes to the staging outbox and staging's checks have no phone
attached, so nothing buzzes.

## Reading the health endpoint

`GET /api/health` answers 200 or 503 with:

```
ok, problems[]
jobs:    lastRunAt, minutesAgo, runsLastDay, errorsLastRun,
         invariantsLastRun
mail:    driver, lastOkAt, lastFailAt, failuresLastHour
webhook: lastAt
orders:  open, lastCreatedAt, lastPaidAt
log, heartbeat  (configured or not)
```

It is 503 when the last jobs run is more than 45 minutes old (or
none is recorded in a day), when the last run had errors, or when
mail has failed three or more times in the last hour with no success
since. Everything else is information. `webhook.lastAt` is the last
signed delivery from Square, PayPal or Resend, whatever it carried.

## The alerts, and what to do

Each alert is one email per kind per hour (later ones of the same
kind are counted, not sent) and one `/fail` ping, then a success ping.
Healthchecks pushes only when a check changes state, so without the
second ping the *Alerts* check would stay down after the first alert
of the day, and every later one would reach email only. The subject is
`Site alert: <kind>`, and the body carries this section's entry for
the kind, from `lib/alerts-guide.mjs`, with a button to this page.

**Who hears what.** Three addresses, one job each:

- `FARM_NOTIFICATIONS_EMAIL` (`sales@northfosterfarm.com`): the farm's
  notice of each new order, the contact-form messages (reply-to the
  writer), the morning report and the tomorrow email. No alert goes
  here.
- `DEV_NOTIFICATIONS_EMAIL` (`dev@northfosterfarm.com`): every alert,
  the maintenance flips and the maintenance bypass admin, the yearly
  rotation reminder (below) and the session-end notice. There is no
  fallback: unset, nobody is told, and the production build and
  `bin/nff env check` fail.
- `ESCALATED_NOTIFICATIONS_EMAIL` (`office@northfosterfarm.com`): one
  emergency, below, and nothing else.

`alertRecipients` in `lib/health.mjs` returns the developer's address
for every kind, so a new alert needs no entry. The farm used to hear
`pickup.lapsed` and the order and money alerts; they now read as
alerts in the developer's inbox, and the farm learns of a problem
from James.

**The escalation.** "Orders not recorded" is the one alert that can
call for a rollback (`docs/rollback.md`). The detector raises the kind
`orders.not_recorded` (the detector itself is not built yet; the
escalation waits for it). The developer gets it like any alert. Left
unacknowledged for an hour, the scheduled jobs email
`ESCALATED_NOTIFICATIONS_EMAIL` a plain message: James hasn't
responded, switch on maintenance mode, here is the signed ON link. It
repeats every hour while the alert is open, and `acknowledge` in
`lib/health.mjs` stops it. `escalate` is the only code that reads
that address, and `test/rotation.test.mjs` raises every kind to prove
nothing else reaches it.

**`order.create_failed`.** `POST /api/orders` could not create the
Square order or take the payment after retries, or a processor
rejected it outright. A declined card is not this: the customer just
sees the decline. The customer saw the failure card with your email
and phone. Check Square or PayPal status and the log (`event:
order.failed`; the `detail` is the processor's answer). A `retryable`
failure is the processor or the network; a permanent one is usually a
bad token or application id.

**`order.after_paid_failed`.** The payment went through and the order
was recorded, but a step after that failed: the customer record or the
stock counts. The customer saw their confirmation; the store was the
problem. The emails are not part of this: they go after the answer,
and the jobs send any that did not. Open the order (`bin/nff orders
show <id>`) and check what is missing: its lines against the stock
counts (`stock set` puts one right), and the customer's record.

**`order.id_collision`.** A customer's order turned up under another
customer's order id. Nothing of the other order went back to them;
they saw the failure card. Each id is reserved before the charge, so
this should never happen. The `stage` says when it was caught:
`recording` (the payment went through and the order could not be
written), `venmo` (finishing a Venmo payment) or `answer` (just
before the reply to the page). A `squarePaymentId` or
`paypalCaptureId` in the alert is this customer's money, taken with
no order recorded for it. With a payment id: find it in Square (or
the capture in PayPal), then refund it, or ask the customer what they
ordered and record it by hand. Without one, nothing was charged.
Either way tell the developers: a reservation failed (#253).

**`payment.unreconciled`.** Money was taken for an order that could
not be settled on its own, and the customer was not charged again.
Either a payment turned up in Square for an order id whose record was
never written, but for another amount than the order now totals (the
customer changed the cart between tries), or PayPal captured a Venmo
payment for an order that was already recorded as paid another way,
or a customer changed the cart after a Venmo payment that was recorded
as it was paid. The alert says which.

Order emails go once: each carries a stable key per order and
template, which Resend (its `Idempotency-Key` header, kept 24 h) and
the staging outbox answer without sending again. Two writers noting
`emails` on one order at the same moment can still drop one note
(`amendOrder` reads, then writes); the next run then resends, and the
key makes that harmless within a day.

A lost answer that is reconciled cleanly raises no alert, only the log
event `payment.reconciled`. The first one in production, check by
hand: the order is recorded, Square holds the one payment and no
second charge exists. Square's order search cannot be tested against
a payment seconds old, so the first real case is the test. Find the order id in Square (the order's
reference id) and the payment in Square or PayPal. If the payment is
good and the order should stand, record the order by hand; if the
customer paid twice, refund the extra payment (in Square or PayPal;
`bin/nff orders refund` works on a recorded order) and write to them.

**A payment taken with no order record.** The customer paid and saw
the failure card (a platform 502, a timeout) and nothing is recorded.
Square or PayPal shows the payment; `bin/nff orders show <id>` finds
no order. Usually nothing needs doing: the customer's next try asks
Square (or PayPal) first, records the order from the payment it finds
and answers with success (log `payment.reconciled`), and the jobs
rescue a Venmo capture the page never finished. If the customer does
not try again, record it by hand or refund it. In Square the order's
reference id is the order id (`NFF-YYMM-XXXXXX`). Find the payment
there, then either write to the customer and refund it in Square's or
PayPal's dashboard (`bin/nff orders refund` needs a recorded order),
or ask what they ordered and enter the order. `bin/nff
orders show <id>` should answer afterwards, and the payment must
appear on exactly one order.

**`order.reserve_failed`.** `POST /api/orders` could not reserve an
order id in the orders store, so it stopped before any payment.
Nothing was charged; the customer's page says to try again and
retries. Check Netlify status (Blobs). One alone is a blip. Several
mean nobody can pay: look at the log (`event: order.reserve_failed`)
for the store's error.

**`client.checkout_failed`.** The order page itself gave up: retries
exhausted or a permanent error. It carries the message the customer
saw and the method. Expect it beside `order.create_failed`; alone, it
means the page could not reach the site at all. If the site is up,
look at the log for the same minute. If many arrive, check Netlify
status.

**`order.edit_failed`.** A customer's change to a paid order failed
for a reason other than a decline: Square or PayPal would not take or
refund the difference, or the record could not be written. The
customer was told to try again in a minute. The edit's key was
written first, so a retry finishes the same edit and never charges or
refunds twice. Check Square or PayPal status and the log (`event:
order.edit_failed`; the `detail` is the processor's answer). `bin/nff
orders show <id>` shows whether the edit is still pending. If the
customer does not retry, finish or undo it with them.

**`order.pay_failed`.** A customer paying later for an order the farm
made (#181) failed for a reason other than a decline: Square would
not take the payment on the order's own Square order, or could not be
reached. The customer was told to try again in a minute. Nothing was
recorded, and a retry carries the same key, so Square never takes it
twice. Check Square status and the log (`event: order.pay_failed`;
the `detail` is Square's answer). `bin/nff orders show <id>` shows
what is still due. If the customer does not retry, take the money
another way and record it with `bin/nff orders pay`.

**`order.paid_twice`.** Money reached Square for an order the farm
made (#181) that would not take it: the order was already settled
(two payments crossed in the last moment, one from the customer's
page or the farm's tender), or it was cancelled while the money was
being taken. The record is left as it was, so the `squarePaymentId`
in the alert is money Square holds that no record answers for;
`status` says which case. Refund that payment in Square's dashboard
(the alert names its id and amount), and tell the customer if it was
their card. `bin/nff orders show <id>` shows what the record kept.

**`mail.failed`.** An email could not be sent: to a customer or the
farm about an order, or a contact-form message to the farm. Any order
and its record are fine; the email is not. A contact message is kept
(`messages/<id>` in the customers store), and its writer was told it
did not send. Check Resend status and the daily quota (100 on the
free plan). The failing send is logged with the template name and the
order or message id. Resend an order's email with `bin/nff` or from
the order page once mail works; for a contact message, write back to
its sender.
**`client.payment_unavailable`.** A customer's order page could not
offer any way to pay, so it told them to email the order instead. The
`where` field says why: `checkout.config` or `checkout.init`
(`/api/checkout/config` failed or named no processor), `square.load`
(Square's script would not load or start), or `sdks.gone` (neither
the card nor Venmo came up). The `square` and `paypal` fields give
each one's state and load time. Open `/order/` yourself. If it pays,
it was the customer's network or a blocker: one alone needs nothing.
If it does not, check Square status, then the log for the same minute
and `GET /api/checkout/config`. `bin/nff errors show` maps the stack.

**`client.error`.** Not an alert: logged at `warn` only, never
emailed. Something on the order page threw or failed where the
customer could carry on: the card field would not attach, PayPal
would not load or render, a wallet would not tokenize, or an uncaught
error. The `where` field names the place. Query the log (`event:
client.error`) for a pattern: the same `where` from many browsers is
ours to fix, one browser alone rarely is. `bin/nff errors show` maps
the stack to the source line.

**`square.record_failed`.** A Venmo payment was captured but its
Square order and external tender could not be made: for a new order,
or for the difference a customer paid by Venmo when changing one. The
order is recorded and the customer is fine; the Square dashboard does
not show that payment yet. For a new order the jobs try again every
run (`squareSynced` in the report); if `square.missing` shows up in
the invariants a day later, check `SQUARE_ACCESS_TOKEN` and Square
status. For a change, nothing retries: record the difference in
Square by hand.

**`square.edit_failed`.** A customer's change to a paid order went
through and is recorded, but Square's fulfillment could not follow it,
so what Square shows to pack or where is out of date. The order is
flagged `squareOutOfSync`. Pack from `bin/nff orders show <id>`, not
from Square. Check Square status and the log (`event:
square.update_failed`), then fix the fulfillment in the Square
dashboard by hand.

**`square.complete_failed`.** An order was fulfilled, from the CLI or
by the close job, and the site's record says so, but Square could not
be told, so the order stays open there (#328). The order is flagged
`squareOutOfSync` and the farm gets one "Square still open" email.
Complete the order in the Square dashboard by hand; the log
(`event: square.complete_failed`) has Square's answer.

**`square.refund_failed`.** A refund made in PayPal could not be
repeated on the Square copy of the Venmo payment. The customer has
the money back and the order records the refund; only Square's books
disagree. In the Square dashboard, refund the same amount on that
Venmo payment so Square agrees with PayPal. Its tender is external,
so no money moves. The alert names the order and the PayPal refund.

**Square orders left open (#241).** A card payment that fails for any
reason but a decline leaves its Square order OPEN. Once a day, the
first run from 7:00, the jobs list the site's orders (metadata
`site_version`, an `NFF-` reference) that are a day old with no
tender, no record and no Venmo checkout waiting: `squareOpen` in that
run's report, `open` in `bin/nff jobs history`, a "Square sweep"
section in the 8:00 morning report, and `bin/nff jobs square` on
demand. The jobs cancel them unless the Square deletion kill switch
is set; `bin/nff jobs square --apply` cancels them once. Orders made
before the tag was set are never listed.

**Square profiles a failed checkout made (#236).** Pressing Pay makes
a Square customer profile when the email is new to the farm, before
the charge, and notes it. Once a day, the first run from 7:00, the
jobs weigh each note a day old: they keep the profile when the order
was recorded, the customer has another order here, or Square shows a
paid order for it at any of the account's locations (the market
included); they wait when Square shows an order for it made in the
last day. The rest are `customersMade` in that run's report,
`profiles` in `bin/nff jobs history`, a "Square sweep" section in
the morning report, and `bin/nff jobs customers` on demand. The jobs
delete them unless the Square deletion kill switch (below) is set;
`bin/nff jobs customers --apply` deletes them once. While the switch
is set, a note (it holds the customer's email) is dropped after 30
days and the profile stays. A profile that already existed is never
touched.

**The Square deletion kill switch.** The automatic Square cleanups
run unless it is set: this sweep's cancelling, and the deletion of the
customer profiles a failed checkout made (#236). It is set by either
of two things. `bin/nff square deletions pause` (with `--staging` or
`--production`) sets a flag in the jobs store that the next run reads,
so it stops both at once, with no deploy; `resume` clears it and
`status` says where both stand. `SQUARE_DELETION_KILL_SWITCH`, any
non-blank value, also pauses them, on Netlify from the next deploy
and in `bin/nff` from the env file it reads; it is optional in every
env sample, so `bin/nff env push` carries it. While either is set,
the cleanups only report: the morning report, `bin/nff jobs square`
and `bin/nff jobs customers` say so, and `--apply` refuses. A flag
that cannot be read counts as set. Each cleanup changes at most 25
records a run; the rest wait for the next day's run. Any code that
deletes or cancels records in Square on its own must check it
(`deletionsPaused` in `netlify/functions/lib/square-pause.mjs`). A deletion
a customer asks for is not a cleanup and does not.

**`venmo.amount_mismatch`.** PayPal captured a different amount than
was asked: the order's total, or for a change to an order, the
difference. The order is recorded as paid all the same. `bin/nff
orders show <id>`, compare with the capture in PayPal, and refund or
charge the difference by hand.

**`pass.used_twice`.** A paid order came in with a single-use pass
that another order had already used up, so one code covered two orders
under the delivery minimum or with no fee. Both are recorded as paid.
`bin/nff orders show <id>` for both orders, then `bin/nff passes list`
for the code; charge the second order's fee or cancel it by hand if
the farm did not mean to allow it, and revoke the code.

**`credit.unspent`.** A buying group member's order (#471) was
recorded with a credit tender, but the member's ledger held less than
that by the time the money was in (an order the jobs finished, or an
earlier attempt found paid): the credit is on the order and not off
the ledger. The order is recorded as paid all the same. `bin/nff
groups credit <email>` and `bin/nff orders show <id>`; if the member
spent that credit on another order too, charge or refund the
difference by hand.

**`refund.failed`.** Square reports a refund FAILED or REJECTED, or
PayPal a Venmo refund FAILED or CANCELLED: the customer did not get
that money back. A refund from `bin/nff` is marked so on the order
and no longer counts as refunded; one made in the Square dashboard was
never recorded. The Square webhook raises it as it happens; the daily
refund check (07:00, `lib/settle.mjs`) raises what the webhooks
missed. Look up the refund in Square or PayPal for the reason (often a
card or account that has closed). Refund again with `bin/nff orders
refund <id>`, or pay the customer another way and tell them.

**`refund.unrecorded`.** Square or PayPal took a refund and the
order's record could not be written to say so: the store failed, or
the record was changing too fast to save. The customer has the money
back, but the order still shows it owed. Do not refund it again. Run
`bin/nff orders show <id>` in a few minutes: once the processor's
webhook has recorded the refund it shows it. If it never does, look
the refund up in Square or PayPal by the id in the alert and note it
on the order.

**`refund.stalled`.** The daily refund check found a refund made five
or more days ago that has still not settled, or one with no Square or
PayPal id to check it by. The customer was told it takes a few days.
Raised once per refund. Look it up in Square or PayPal: if it is still
pending there, ask their support why; if it is not there at all,
refund again with `bin/nff orders refund <id>`. `bin/nff refunds
check` lists every refund still waiting.

**`webhook.rejected`.** Square, PayPal or Resend sent a webhook this
site refused: its secret is not set here (`unconfigured`), its
timestamp is too old (`stale`, Resend only), or it was signed and the
signature did not verify (`mismatch`). Scanners send no signature, so
a signed delivery that fails means a wrong secret, and the refunds,
payment updates or unsubscribes it carried were dropped. An
`unsigned` POST is only logged. Check the provider's secret on
Netlify for this context: Square, `SQUARE_WEBHOOK_SIGNATURE_KEY` (and
`SQUARE_WEBHOOK_URL`, the URL Square signs with); PayPal,
`PAYPAL_WEBHOOK_ID` and the client id and secret; Resend,
`RESEND_WEBHOOK_SECRET`. Compare it with the provider's webhook
settings, set it, redeploy, then resend a test event from the
provider. The alert reaches the developer's address and the phone like
any other, and each provider mutes on its own for an hour, so a bad
Square key never hides a bad PayPal one. The log
(`event: webhook.rejected`) has every refusal, with
the provider, the reason, the body's size and the delivery id, never
the body.

**`pickup.lapsed`.** A Venmo payment approved on the order page was
finished by the jobs after its pickup time had left the schedule
(W11d). The order is paid and booked for that time. Keep the time if
you can be there. If not, cancel it with `bin/nff orders cancel <id>
--reason <why>` (or `--reason-text "..."`), which refunds it.

**`jobs.errors`.** An order's work in the 15-minute run threw. The
rest of the run finished. The report lists the order and the step.
`bin/nff orders show <id>`; fix the record or the code.

**`jobs.invariants`.** The run finished but the records are not in
the state a healthy run leaves them (below). Each violation names its
rule and its order.

**`jobs.crashed`.** The run itself threw before it could do its work.
The log has the stack. This is the one that also stops the heartbeat.

**`backup.failed`.** The nightly backup export did not reach the R2
bucket: a `BACKUP_` variable is unset or wrong, the store could not
be read, or R2 refused the upload. The *Backup* check pushes too.
Last night's copy is still in the bucket; tonight's is missing. The
error names the cause (and the log, `event: backup.failed`). Fix the
variable or the token, then take a copy now with
`bin/nff --production export`. A *Backup* check that goes down with
no alert means the run never started: check the function's schedule
in Netlify. `docs/backup.md` has the rest.

**`alert.test`.** Someone ran `bin/nff alert test`. Nothing is
wrong. It went through the same path as a real alert, past the hourly
limit, so this email and a down-then-up push on the phone prove both
channels work. Nothing to do, if the phone buzzed too. If it did not,
check the *Alerts* check's integrations in Healthchecks.

**`function.crashed`.** A site function threw an exception nothing in
it caught, so whoever called it got Netlify's bare 500. The alert
names the function, the path and the error, with the top of the
stack. One is sent an hour for each function. Read the stack
in the alert or the log (`event: function.crashed`, by `function`).
If it is the order or payment path, check `bin/nff orders list` for
an order that half happened. Fix and redeploy; a `POST` to
`/api/staging/throw` on staging raises one on purpose. The jobs run
catches its own and raises `jobs.crashed` instead, never both.

## The invariants

Checked at the end of every run against every open order. Each is a
statement that must be true after a healthy run; a violation means
the job is not doing its job even though it ran.

- `paid.not_closed`: no paid order is two or more days past its date
  without an open question.
- `legacy.unpaid`: no order is `submitted`. Nothing makes one any
  more; one still open is from before the checkout moved onto the
  page and needs a person.
- `square.missing`: no paid Venmo order has gone a day without its
  Square copy (`square: null`). The jobs retry it every run; this
  fires when the retries keep failing.
- `order.unreadable`: the rules could not even read the record.
- `stock.flagged` (#499): no variation `data/catalog.json` marks
  `hiatus` or `discontinued` has stock above 0 in Square at the farm's
  location. Checked once a day from 07:00, not against the orders; it
  names the SKU, its flag and the count, once per SKU and count, and
  its alert is never held by the hourly mute. Fix the count in Square
  or the flag in the catalog; `bin/nff stock flags` lists them all.

## The jobs heartbeat and partial failures

Each order's work in the run is isolated: one order throwing does not
stop the others. Errors and invariant violations go on the run's
report, into the ledger, to the log, and to the alert. The heartbeat
pings the *Jobs* check well only when both lists are empty; otherwise
it posts the report to `/fail`. So healthchecks pages you for a run
that stopped, a run that crashed, and a run that ran but failed part
of its work, through the same channel.

`bin/nff jobs history` prints the last runs, newest first, with the
counts and any errors or violations, from the ledger in the jobs
store (`run/<time>`, two days kept). It needs the Netlify Blobs
variables in `.env.production` and the `--production` flag.

## The daily emails

**Rotation reminder**, 8:00 on Dec 1 and on each following Dec 8, 15,
22 and 29, to `DEV_NOTIFICATIONS_EMAIL`: the secrets still due. It is
a step of the 15-minute jobs (`lib/rotation.mjs`, the `rotation` entry
of the run report), not a separate schedule. Every secret rotates
between Dec 1 and Jan 1 (`docs/secrets.md`, "Schedule"); the email
lists each name and environment in `docs/rotation-log.md` whose latest
rotation is dated before Dec 1, and the file is bundled into the
function by `included_files` in `netlify.toml`. It also lists the old
credentials still to revoke: each `schedule` rotation since Dec 1 with
no later `revoked` line, and the day to revoke it by. The Dec 1 email
always goes. Later ones, through January (Jan 1, 8, 15, 22 and 29),
go only while the log still shows something due or something to
revoke, and the Dec 29 one, in the last week of December, is titled
FINAL REMINDER. A run that missed a day sends it at the next. The log's line
format is name, date (YYYY-MM-DD), environment, reason, who, split by
`|` or `,`; a line without a date second is skipped. A missing log
makes the email say so. Each send is recorded in the jobs store under
`rotation/<date>`, so a repeat run sends nothing.

**Morning report**, 8:00: the site's vital signs for the last 24
hours, each with the range a healthy day falls in (orders placed,
paid by card or a wallet, paid by Venmo, payments declined,
cancellations, refunds, open orders paid and not yet fulfilled, mail
failures, jobs runs, errors and violations); a warning, with the
command, when `PICKUP_SCHEDULE` doesn't reach the week after next
(the next deploy would fail on it); then the on-farm pickups within
two days whose time the farm gave up and the customer hasn't
re-picked (W11d); then every message to the farm, from the contact
page or the account page's help form, not yet marked answered, oldest
first, with its age (#167). A message stays on the report every
morning until `bin/nff messages done <id>`; `bin/nff messages` lists
the same. This email also pings the *Alerts* check well.

**Tomorrow**, 18:00: every order due the next day, grouped delivery,
drop site, on-farm, each with customer and phone, and for a
delivery the address, cooler, gate code and notes, and for every
order what to pack. Sent even when empty ("Nothing due"). If it has
not arrived by 18:15, something is wrong; the heartbeat will already
have said so.

**Packing slips**, 6:00 (#292, `lib/packing.mjs`), to
`FARM_NOTIFICATIONS_EMAIL`: one PDF to print whole. Its cover is the
pick list, each product and tier with its total across the slips;
then the slips by fulfillment date, type and pickup time. Sunday's
packet holds every order for Sunday to Saturday. Other days hold the
orders not printed yet, a revision sheet and a new slip for each
order changed since it was printed, and a CANCELLED sheet for each
printed order since cancelled. A quiet day still sends "nothing to
print". What each order's slip showed is kept in the jobs store
(`packing/printed/<id>`, contact details and address only as a hash,
30 days past its date), and a reprint comes from comparing the order
with it; `packing/sent/<day>` stops a second packet. After the packet,
an order due that day that changes anyway (the CLI, a refund noted
from Square or PayPal) is mailed at once as "Changed after printing",
with its sheets. Its heartbeat is the *Packing slips* check. The
staging toolbar's email library previews the email and the PDF.
Staging's own jobs runs put its packet in the outbox, never in a
mailbox, and a run with `reset` lets the day's packet go again.

## The log

Every function writes one JSON line per event to the console (as
before) and ships the invocation's lines to Axiom when it returns,
with a 1.5-second cap; a failure to ship is swallowed. Query by
`event` (`order.paid`, `payment.declined`, `order.failed`,
`mail.failed`, `square.webhook`, `paypal.webhook`, `resend.webhook`,
`webhook.rejected`, `jobs.run`, `alert`, `health.checked`, ...), by
`id` for one order, or by `level: error`. The jobs run's full report
is one `jobs.run` line every 15 minutes, so "when did it start" is a
query for the first run whose `errors` is not empty. Deploy id and
context ride on every line. Every function is wrapped in
`withLog(name, handler)`, so an exception no handler caught is one
`function.crashed` line with the function's name and the top of its
stack, and an alert, before Netlify answers 500 as it always did.

## Browser error reports

`assets/scripts/report.js` is built on its own and loaded in the
order page's `<head>`, before the order bundle, so a crash in the
bundle is still caught. It hooks `window.onerror` and
`unhandledrejection`, and `pay.js` reports each failure in its catch
blocks under a fixed `where` name. A report goes by `sendBeacon` to
`POST /api/health` and carries the `where`, the message, the first
frames of the stack, the build's commit, the page's path, the last 20
steps by name (`pay.load`, `square.ready`, `card.attach_failed`,
`pay.press`, ...) and each SDK's state and load time. The server adds
the browser's family and major version from the user agent and keeps
nothing else of it. A page sends five reports at most, and each once.

**What a report may carry** is defined in one place,
`assets/scripts/report/fields.mjs` (#258): the fields the browser
sends, the fields the server keeps, the breadcrumb names and the
scrubber. The reporter builds its body from that list, and the
handler (`lib/client-report.mjs`) drops any key not on it, so a field
cannot leave the browser by accident or be stored by the server. A
thrown error can quote what the customer typed, so both sides replace
anything shaped like an email address or a phone number in the
message and the stack with `[email]` or `[phone]`. A report never
carries a name, contact details or an order;
`e2e/report-privacy.spec.mjs` forces every failure with a fake
customer filled in and fails if any of it reaches `/api/health`. A new
field goes in `fields.mjs` and nowhere else.

A stock check that fails shuts the order page (#333) and reports
`stock.unavailable` (the first load, after its 2, 5 and 15 second
retries) or `stock.final_check` (the look right before a submission),
both `client.error`, so the farm sees how often customers meet the
notice. `/api/stock` itself alerts through the crash handler
(`function.crashed`) whenever it throws; a Square that does not
answer is not a failure, the page then sells from the store's counts.
The farm's archived-stock email goes after the answer, never in it.

What fails decides the kind. Config, init, Square's script and both
ways gone are `client.payment_unavailable`, an alert; everything else
(the card field, PayPal, a wallet, an uncaught error) is
`client.error`, logged at `warn`.

**Source maps.** A production build minifies the scripts and writes
each bundle's map beside it. After the build and before the upload,
the local build plugin `plugins/source-maps` (`bin/maps/stash.mjs`)
moves every map out of `public/` into that deploy's own `maps` Blobs
store (`deploy:<id>:maps`, keyed `scripts/order/main.js.map`), so no
map is ever served. It is a plugin because only plugins get the Blobs
context, and a deploy store because a build may write to no other
(Netlify answers 401 for a site-wide store). The deploy log says what
it did: `[maps] N found, N removed from the site, N kept for <sha>`,
then, if any map was not kept, why. The same line is the plugin's
status (`GET /api/v1/sites/<site>/plugin_runs/latest?packages[]=
./plugins/source-maps`, its `summary`), and a JSON line before it
(`"event":"maps.env"`, also the status's `text`) says whether the
build had a Blobs context and a commit, never a value. Nothing in it
can fail a deploy: a store that will not take the maps, or a minute
gone by, costs the maps only, and every map is removed regardless.

To read a stack, save the report's log line (the JSON from Axiom) to
a file and run

```
bin/nff --production errors show report.json
bin/nff --staging errors show stack.txt --sha <commit>
bin/nff --production errors show report.json --deploy <deploy id>
```

It finds the newest ready deploy of the report's commit on the
context's branch (`main` for `--production`, `staging` for
`--staging`; any branch with neither flag) through the Netlify API,
reads that deploy's maps with the env file's `NETLIFY_SITE_ID` and
the Keychain's Netlify token, and prints each frame as the original file,
line and column, with the line of source. `--deploy` skips the
lookup; `-` reads the report from standard input.

The maps live as long as their deploy. The published deploy keeps
them; Netlify deletes an unpublished deploy, and its stores with it,
after its retention (30 days on the Starter plan). So a report from a
build more than 30 days old that is no longer live cannot be mapped:
`errors show` says no ready deploy built it.

## What is deliberately not here

- A synthetic daily checkout. It would charge a real card every day.
  The QA guide's occasional $1 order does the job.
- A hosted error tracker (Sentry). The log has the events, the
  errors' messages and, for an exception no handler caught, the top
  of its stack, and the order page reports its own errors to it with
  private source maps; add one if that proves too thin.
- Monitors scripted from `bin/nff`. The five are made by hand in
  UptimeRobot for now; scripting them through its API comes after
  launch.
- Anything on the dashboard's side. When the delivery route batch
  exists there, it should report to the same healthchecks account with
  the same shape: a heartbeat, a count of stops, and a fallback that
  publishes the manifest unsorted rather than nothing.
