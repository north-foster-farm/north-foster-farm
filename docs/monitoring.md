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
- **Backup heartbeat.** The nightly backup export (`docs/backup.md`)
  pings a third check when its copy lands in R2, and `/fail` with
  `backup.failed` when it does not. `HEALTHCHECKS_BACKUP_URL`.
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
   Attach a push integration (Pushover, ntfy, Telegram or Signal) to
   production's three checks only, besides email. Staging's checks get
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
provider. The log (`event: webhook.rejected`) has every refusal, with
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
`NETLIFY_AUTH_TOKEN`, and prints each frame as the original file,
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
