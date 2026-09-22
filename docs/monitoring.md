# Monitoring

What watches the order path, what each signal means, and what to do
when one fires. Everything here degrades to nothing when its variable
is unset, so a preview or a local run monitors nothing and alerts
nobody.

## The pieces

- **Health endpoint.** `GET /api/health`
  (`netlify/functions/health.mjs`): the last hour from the records,
  200 or 503. Needs nothing.
- **Outside pinger.** healthchecks.io HTTP checks every five minutes
  on `/api/health`, `/order/` and `/api/dates`. Needs the account.
- **Jobs heartbeat.** The 15-minute run pings a healthchecks check
  when it ends well, and its `/fail` URL with the report when it does
  not. `HEALTHCHECKS_JOBS_URL`.
- **Alerts.** `alert()` in `lib/health.mjs`: a farm email per failure
  kind per hour, and a `/fail` ping to a second check.
  `ADMIN_EMAILS`, `HEALTHCHECKS_ALERT_URL`.
- **Log.** Every JSON line the functions write, shipped per invocation
  to Axiom (`lib/log.mjs`). `AXIOM_TOKEN`, `AXIOM_DATASET`.
- **Run ledger.** Each jobs run's report in the jobs store, two days
  kept; `bin/nff jobs history`. Needs nothing.
- **Morning report.** 8:00 daily, always: the last day in numbers,
  then pickups to confirm. `ADMIN_EMAILS`.
- **Tomorrow.** 18:00 daily, always: every order due tomorrow by
  method, with what to pack and where to leave it. `ADMIN_EMAILS`.
- **Checkout beacon.** The order page posts to `/api/health` when a
  checkout cannot complete; it becomes the `client.checkout_failed`
  alert. Needs nothing.
- **Deploy failures.** Netlify → Site configuration → Notifications:
  "Deploy failed" by email. Set in the Netlify UI.

## Setting it up

1. **healthchecks.io**, free plan. Create two checks:
   - *Jobs*: period 15 minutes, grace 30 minutes. Its ping URL goes
     to Netlify as `HEALTHCHECKS_JOBS_URL`.
   - *Alerts*: period 1 day, grace 2 hours. Its ping URL goes to
     Netlify as `HEALTHCHECKS_ALERT_URL`. The morning report pings it
     well once a day; every alert posts to its `/fail`. So it pages
     on any alert, and also if the morning report itself stops.
   Add three HTTP checks for `https://www.northfosterfarm.com/api/health`
   (expects 200), `/order/` and `/api/dates`. Set the notification
   channels: email plus a phone (the healthchecks app, Pushover, or
   SMS).
2. **Axiom**, free plan. Create a dataset `nff-site` and an API token
   with ingest rights on it. On Netlify: `AXIOM_DATASET=nff-site`,
   `AXIOM_TOKEN=xaat-...`. Retention on the free plan is 30 days.
3. **Netlify**: turn on the deploy-failed email notification.
4. Redeploy. `bin/nff health`, or a GET to `/api/health`, shows which
   pieces are configured under `log` and `heartbeat`.

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
since. Everything else is information.

## The alerts, and what to do

Each alert is one email per kind per hour (later ones of the same
kind are counted, not sent) and one `/fail` ping. The subject is
`Site alert: <kind>`.

**`order.create_failed`.** `POST /api/orders` could not create the
Square order or invoice after retries, or Square rejected it
outright. The customer saw the failure card with your email and
phone. Check Square status and the log (`event: order.failed`; the
`detail` is Square's answer). A `retryable` failure is Square or the
network; a permanent one is usually an item not available at the web
location, or a bad token.

**`client.checkout_failed`.** The order page itself gave up: retries
exhausted or a permanent error. It carries the message the customer
saw and the method. Expect it beside `order.create_failed`; alone, it
means the page could not reach the site at all. If the site is up,
look at the log for the same minute. If many arrive, check Netlify
status.

**`mail.failed`.** A customer or farm email could not be sent. The
order and its record are fine; the email is not. Check Resend status
and the daily quota (100 on the free plan). The failing send is
logged with the template name and order id; resend with `bin/nff` or
from the order page once mail works.

**`poll.failed`.** Asking Square about an unpaid invoice threw. The
next run retries. Act only if it repeats for an hour: check
`SQUARE_ACCESS_TOKEN` and Square status.

**`venmo.fetch_failed`.** Resend's inbound webhook arrived but the
message could not be read. Resend retries the webhook. Check that
`RESEND_READ_KEY` is set and can read received mail.

**`jobs.errors`.** An order's work in the 15-minute run threw. The
rest of the run finished. The report lists the order and the step.
`bin/nff orders show <id>`; fix the record or the code.

**`jobs.invariants`.** The run finished but the records are not in
the state a healthy run leaves them (below). Each violation names its
rule and its order.

**`jobs.crashed`.** The run itself threw before it could do its work.
The log has the stack. This is the one that also stops the heartbeat.

## The invariants

Checked at the end of every run against every open order. Each is a
statement that must be true after a healthy run; a violation means
the job is not doing its job even though it ran.

- `unpaid.past_cutoff`: no unpaid order is more than 30 minutes past
  its cutoff without a payment hold or an open question.
- `paid.not_closed`: no paid order is two or more days past its date
  without an open question.
- `order.no_pay_link`: no order more than 20 minutes old lacks its
  pay-link email.
- `reminder.overdue`: no reminder that was due more than 30 minutes
  ago is unsent, unless the customer turned reminders off.
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
variables in `.env`.

## The daily emails

**Morning report**, 8:00: orders placed, paid (by webhook, by poll,
by hand), abandoned, cancelled, still unpaid, mail failures, jobs
runs, errors and violations, over the last 24 hours; then the on-farm
pickups within two days still waiting. A day when every payment
arrived by the poll gets a bold line: the Square webhook is probably
broken. This email also pings the *Alerts* check well.

**Tomorrow**, 18:00: every order due the next day, grouped delivery,
Scituate drop, on-farm, each with customer, phone, paid or UNPAID,
and for a delivery the address, cooler, gate code and notes, and for
every order what to pack. Sent even when empty ("Nothing due"). If it
has not arrived by 18:15, something is wrong; the heartbeat will
already have said so.

## The log

Every function writes one JSON line per event to the console (as
before) and ships the invocation's lines to Axiom when it returns,
with a 1.5-second cap; a failure to ship is swallowed. Query by
`event` (`order.created`, `order.failed`, `mail.failed`,
`square.webhook`, `venmo.received`, `jobs.run`, `alert`,
`health.checked`, ...), by `id` for one order, or by `level: error`.
The jobs run's full report is one `jobs.run` line every 15 minutes,
so "when did it start" is a query for the first run whose `errors`
is not empty. Deploy id and context ride on every line.

## What is deliberately not here

- A synthetic daily checkout. It would put a real invoice in Square
  every day. The QA guide's occasional $1 order does the job.
- Stack-trace tracking (Sentry). The log has the events and the
  errors' messages; add Sentry if that proves too thin.
- Anything on the dashboard's side. When the delivery route batch
  exists there, it should report to the same healthchecks account with
  the same shape: a heartbeat, a count of stops, and a fallback that
  publishes the manifest unsorted rather than nothing.
