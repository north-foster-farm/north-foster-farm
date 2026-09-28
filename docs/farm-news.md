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

The list itself lives in Resend as a segment, so broadcasts go out
with Resend's unsubscribe link, and the sync keeps the segment and
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

## The segment

Set up in Resend: a segment, and an API key with full access (the
sending keys cannot touch contacts). On Netlify: `RESEND_SEGMENT_ID`
(read from the old `RESEND_AUDIENCE_ID` when unset; Resend kept each
audience's id for the segment made from it) and `RESEND_AUDIENCE_KEY`
(falls back to `RESEND_API_KEY`).

Resend's contacts belong to the account, not to a segment (#148), and
one account serves every environment. So a contact the sync adds may
already exist, in another deploy's segment or none: it joins this
segment as it is, and an unsubscribe on it counts like any other. The
`unsubscribed` flag is the account's, so it stops every broadcast to
that address from every environment. A rename (`bin/nff customers
rename`) moves the contact out of this segment without deleting it.

```
bin/nff --production audience sync [--dry-run]
```

runs the sync, and the jobs run does it once a day from 05:00. The
rules, in `syncAudience`:

- Our record decides who is in: a consenting record not in the
  segment is added to it; a record that withdrew here is unsubscribed there.
- Resend decides who has left: a contact unsubscribed there whose
  record still says yes is opted out here, dated, source `resend`,
  and the time kept as `resendLeftAt`. Only consent given here after
  that time resubscribes them there; without one, the unsubscribe
  wins, however recent the consent.
- A contact in Resend with no record, or with a record that never
  expressed a preference, is taken as consent given there (James adds
  people by hand) and gets a consenting record.
- An unsubscribed stranger in Resend is left alone.

The webhook, `/api/resend/webhook`, takes Resend's `contact.updated`
and `contact.deleted` events, signed with `RESEND_WEBHOOK_SECRET`
(the endpoint's `whsec_` secret; each environment has its own
endpoint and secret). A contact that becomes unsubscribed, or is
deleted, is opted out at once, as the sync would. Every environment
gets every event from the one account; events outside the deploy's
segment are ignored.

The last sync's time and counts are under `news/sync` in the jobs
store; the daily run marks `news/sync/<day>`.

## Sending

Broadcasts from Resend's editor, to the segment, with the
unsubscribe link Resend inserts. An unsubscribe reaches the record at
once through the webhook below, or at the next sync if it missed. Template-driven broadcasts from the CLI, and sends to
a query of the records from the jobs run, can come later; nothing
here stands in their way.
