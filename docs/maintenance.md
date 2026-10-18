# Maintenance mode

The switch that closes ordering and accounts while the farm fixes the
site (#267). A release is fixed forward; this holds the door shut
meanwhile. Each deploy context has its own, since the setting lives in
that context's `jobs` store (`setting/maintenance`) and is read on
each request. There is no rebuild and no Netlify variable to change.

## What customers see

> Our site is currently under maintenance. Online ordering and account
> access are temporarily unavailable, but we'll be up and running
> again soon. We apologize for the inconvenience.

Those words are `MESSAGE` in `lib/maintenance.mjs`. The API answers
503 `{ maintenance: true, message }`, and the pages put the message
where the customer is: a bar across the top (`utils/maintenance.js`),
in place of the account page, or in the sign-in and sign-up forms.

## What it blocks, and what keeps running

Blocked, on the server, by the handler itself:

| Closed | Where |
| --- | --- |
| A new order, and starting a Venmo one | `POST /api/orders` |
| The whole account area, reads included | `/api/account/*` |
| Sign-in requests, and the emailed sign-in link | `/api/auth/request`, `/api/auth/verify` |
| Farm-news sign-ups, and the emailed confirm link | `/api/news/subscribe`, `/api/news/confirm` |

An emailed link is not spent while it is refused; it works once
maintenance ends. Sessions are not ended: `/api/me` still says who is
signed in, with `maintenance: true`, and an open tab that submits gets
the message and changes nothing.

Keeps running: the Square, PayPal and Resend webhooks; a Venmo capture
the customer already approved (money has moved); the answer to a
submission that was paid before the flip; the scheduled jobs;
unsubscribe links; sign-out; the read-only `/api/stock`, `/api/dates`
and `/api/checkout/config`; `/api/health`; the contact form; and
`bin/nff`.

A payment already under way when the switch flips finishes and is
recorded: the check is made once, at the start of the request.

## Flipping it

From a terminal, with the context's flag (`--staging` or
`--production`):

```
bin/nff maintenance status
bin/nff maintenance on
bin/nff maintenance off
```

From a phone: `bin/nff maintenance links` prints two links, ON and
OFF. Open one and tap the button; opening a link alone changes
nothing, so a link preview cannot flip it. The links are signed with
`MAINTENANCE_SECRET` (set per context on Netlify, and in that
context's env file for the CLI), and whoever holds a link can flip.
`bin/nff maintenance rotate` kills every link handed out so far. Ten
wrong signatures lock an address out for ten minutes.

Every flip that changes the state emails `ADMIN_EMAILS` (James and
Jim) and writes a `maintenance.flipped` log line. Flipping to the
state it is already in does nothing and says nothing.

The admin dashboard's switch is a follow-up (the dashboard is on
hold). It needs only to read and write the same document, or to open
the same signed links.

## The rehearsal

`e2e/maintenance.spec.mjs` runs the open tab, the payment just before
the flip, a Square webhook during maintenance, the farm's emails and
the phone links against staging. It flips staging's switch, so it runs
only on request, and it turns the switch off again whatever happens:

```
E2E_MAINTENANCE=1 npx playwright test e2e/maintenance.spec.mjs \
  --project=desktop
```

It needs `.env.staging`, `STAGING_TOKEN`, and for the last two tests
`SQUARE_WEBHOOK_SIGNATURE_KEY` and `MAINTENANCE_SECRET` in that file
and on the staging deploy. Venmo cannot be scripted: to see a capture
finish during maintenance, start a sandbox Venmo payment, leave
PayPal's window open, turn maintenance on, then approve.
