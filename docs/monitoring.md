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
- **Alerts.** `alert()` in `lib/health.mjs`: a farm email per failure
  kind per hour, and a `/fail` ping to a second check followed at once
  by a success ping, so every alert pushes "down" then "up" and the
  next one pushes again. `ADMIN_EMAILS`, `HEALTHCHECKS_ALERT_URL`.
  `bin/nff alert test` proves both channels.
- **Log.** Every JSON line the functions write, shipped per invocation
  to Axiom (`lib/log.mjs`). `AXIOM_TOKEN`, `AXIOM_DATASET`.
- **Run ledger.** Each jobs run's report in the jobs store, two days
  kept; `bin/nff jobs history`. Needs nothing.
- **Morning report.** 8:00 daily, always: the last day in numbers,
  a warning if the pickup schedule runs short, then pickups waiting on
  the customer. `ADMIN_EMAILS`.
- **Tomorrow.** 18:00 daily, always: every order due tomorrow by
  method, with what to pack and where to leave it. `ADMIN_EMAILS`.
- **Checkout beacon.** The order page posts to `/api/health` when a
  checkout cannot complete; it becomes the `client.checkout_failed`
  alert. Needs nothing.
- **Deploy failures.** Netlify's "Deploy failed" email notification.
  Email only, not the phone, for now (step 4). Set in the Netlify UI,
  no code.

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
   per site, production's and staging's kept apart:
   - *Jobs*: period 15 minutes, grace 30 minutes. Its ping URL goes
     to Netlify as `HEALTHCHECKS_JOBS_URL`.
   - *Alerts*: period 1 day, grace 2 hours. Its ping URL goes to
     Netlify as `HEALTHCHECKS_ALERT_URL`. The morning report pings it
     well once a day; every alert posts to its `/fail` and then pings
     it well. So it pages on every alert, and also if the morning
     report itself stops.
   Attach a push integration (Pushover, ntfy, Telegram or Signal) to
   production's two checks only, besides email. Staging's checks get
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

## Proving an alert reaches the phone

`bin/nff alert test [--production|--staging]` raises one real alert,
kind `alert.test`, through `alert()` itself: the farm email by
`MAIL_DRIVER`, then `/fail` and the success ping to
`HEALTHCHECKS_ALERT_URL`. It skips the hourly limit, so it can be run
again at once, and leaves no mute behind. It refuses when
`HEALTHCHECKS_ALERT_URL` or `ADMIN_EMAILS` is unset, since an alert
there would reach nobody, and prints what it reached:

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

**`order.create_failed`.** `POST /api/orders` could not create the
Square order or take the payment after retries, or a processor
rejected it outright. A declined card is not this: the customer just
sees the decline. The customer saw the failure card with your email
and phone. Check Square or PayPal status and the log (`event:
order.failed`; the `detail` is the processor's answer). A `retryable`
failure is the processor or the network; a permanent one is usually a
bad token or application id.

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

**`mail.failed`.** An email could not be sent: to a customer or the
farm about an order, or a contact-form message to the farm. Any order
and its record are fine; the email is not. A contact message is kept
(`messages/<id>` in the customers store), and its writer was told it
did not send. Check Resend status and the daily quota (100 on the
free plan). The failing send is logged with the template name and the
order or message id. Resend an order's email with `bin/nff` or from
the order page once mail works; for a contact message, write back to
its sender.

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
through and is recorded, but Square's fulfilment could not follow it,
so what Square shows to pack or where is out of date. The order is
flagged `squareOutOfSync`. Pack from `bin/nff orders show <id>`, not
from Square. Check Square status and the log (`event:
square.update_failed`), then fix the fulfilment in the Square
dashboard by hand.

**`square.refund_failed`.** A refund made in PayPal could not be
repeated on the Square copy of the Venmo payment. The customer has
the money back and the order records the refund; only Square's books
disagree. In the Square dashboard, refund the same amount on that
Venmo payment so Square agrees with PayPal. Its tender is external,
so no money moves. The alert names the order and the PayPal refund.

**`venmo.amount_mismatch`.** PayPal captured a different amount than
was asked: the order's total, or for a change to an order, the
difference. The order is recorded as paid all the same. `bin/nff
orders show <id>`, compare with the capture in PayPal, and refund or
charge the difference by hand.

**`refund.failed`.** Square reports a refund FAILED or REJECTED: the
customer did not get that money back. A refund from `bin/nff` is
marked so on the order and no longer counts as refunded; one made in
the Square dashboard was never recorded. Look up the refund in Square
for the reason (often a card that has closed). Refund again with
`bin/nff orders refund <id>`, or pay the customer another way and
tell them.

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

**Morning report**, 8:00: the site's vital signs for the last 24
hours, each with the range a healthy day falls in (orders placed,
paid by card or a wallet, paid by Venmo, payments declined,
cancellations, refunds, open orders paid and not yet fulfilled, mail
failures, jobs runs, errors and violations); a warning, with the
command, when `PICKUP_SCHEDULE` doesn't reach the week after next
(the next deploy would fail on it); then the on-farm pickups within
two days whose time the farm gave up and the customer hasn't
re-picked (W11d). This email also pings the *Alerts* check well.

**Tomorrow**, 18:00: every order due the next day, grouped delivery,
drop site, on-farm, each with customer and phone, and for a
delivery the address, cooler, gate code and notes, and for every
order what to pack. Sent even when empty ("Nothing due"). If it has
not arrived by 18:15, something is wrong; the heartbeat will already
have said so.

## The log

Every function writes one JSON line per event to the console (as
before) and ships the invocation's lines to Axiom when it returns,
with a 1.5-second cap; a failure to ship is swallowed. Query by
`event` (`order.paid`, `payment.declined`, `order.failed`,
`mail.failed`, `square.webhook`, `paypal.webhook`, `resend.webhook`,
`jobs.run`, `alert`, `health.checked`, ...), by `id` for one order, or by
`level: error`. The jobs run's full report is one `jobs.run` line
every 15 minutes, so "when did it start" is a query for the first run
whose `errors` is not empty. Deploy id and context ride on every
line. Every function is wrapped in `withLog(name, handler)`, so an
exception no handler caught is one `function.crashed` line with the
function's name and the top of its stack, and an alert, before
Netlify answers 500 as it always did.

## What is deliberately not here

- A synthetic daily checkout. It would charge a real card every day.
  The QA guide's occasional $1 order does the job.
- Stack-trace tracking (Sentry). The log has the events, the errors'
  messages and, for an exception no handler caught, the top of its
  stack; add Sentry if that proves too thin.
- Monitors scripted from `bin/nff`. The five are made by hand in
  UptimeRobot for now; scripting them through its API comes after
  launch.
- Anything on the dashboard's side. When the delivery route batch
  exists there, it should report to the same healthchecks account with
  the same shape: a heartbeat, a count of stops, and a fallback that
  publishes the manifest unsorted rather than nothing.
