# Farm news by email

Opt-in only, ever. Consent is `marketing` and `marketingAt` on the
customer record (`marketingSource` says how it came: `signup`,
`order`, `account`, `confirm`, `resend`), set by the sign-up field,
the checkout box, the settings box, or the old list's confirmation
link below. Anyone with an email address may opt in; a record is made
for an address that has never ordered.

A sign-up on the site joins at once, with no confirmation email. Only
the old Fastmail list is asked to confirm (James, W1, 2026-09-26:
"we should only be asking Fastmail contacts to confirm, no double opt
in on the website including news sign up").

The list itself lives in Resend as an audience, so broadcasts go out
with Resend's unsubscribe link, and the sync keeps the audience and
the records in step. James decided this on 2026-09-23 (issue #115):
Resend is the home, marketing will be light, and segments, when
wanted, come from our own records.

## Signing up

A field in the footer and on the news page (`news-signup.html`,
`scripts/news/signup.js`). `POST /api/news/subscribe` opts the record
in, dated, source `signup`, creating the record if there is none, and
sends nothing. It is rate-limited per address like sign-in. The answer
is `{ ok: true }` for any address that looks like one, rate limit
included, so nobody can learn who is on the list from here.

The checkout box joins when the order is placed (`touchCustomer`,
source `order`); ticking it sends nothing. The account page's box
writes the same consent, source `account`. Everything else is in
`lib/news.mjs`.

## Asking an old list to opt in again

```
bin/nff --production audience invite contacts.csv [--dry-run]
```

The CSV has a header naming email, first and last (any order, any
case), or no header and the email first. Each address not already
consenting gets the confirmation email (`newsConfirm` in
`templates.mjs`), once, with no rate limit: one button, a link that
works for seven days, single use, ending on "You're receiving this
message because you previously joined our mailing list." Those
already in are skipped and bad addresses reported. Nothing else
happens until they click. `GET /api/news/confirm?token=` is the
click: it opts the record in, dated, source `confirm`, and lands on
`/news/?news=confirmed` (or `expired`, `invalid`), where the note
under the field says so. This is the Fastmail list's way in.

## The audience

Set up in Resend: an audience, and an API key with full access (the
sending keys cannot touch audiences). On Netlify: `RESEND_AUDIENCE_ID`
and `RESEND_AUDIENCE_KEY` (falls back to `RESEND_API_KEY`).

```
bin/nff --production audience sync [--dry-run]
```

runs the sync, and the jobs run does it once a day from 05:00. The
rules, in `syncAudience`:

- Our record decides who is in: a consenting record with no contact
  is added; a record that withdrew here is unsubscribed there.
- Resend decides who has left: a contact unsubscribed there whose
  record still says yes is opted out here, dated, source `resend`.
  Unless the record's consent is newer than the last sync, in which
  case they signed up again here and are resubscribed there.
- A contact in Resend with no record, or with a record that never
  expressed a preference, is taken as consent given there (James adds
  people by hand) and gets a consenting record.
- An unsubscribed stranger in Resend is left alone.

The last sync's time and counts are under `news/sync` in the jobs
store; the daily run marks `news/sync/<day>`.

## Sending

Broadcasts from Resend's editor, to the audience, with the
unsubscribe link Resend inserts. An unsubscribe reaches the record at
the next sync. Template-driven broadcasts from the CLI, and sends to
a query of the records from the jobs run, can come later; nothing
here stands in their way.
