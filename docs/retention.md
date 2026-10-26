# Retention and deletion

The rules are D-189: James on #244 (comment 6218895250, 2026-10-16),
settled on #267 (2026-10-17). The spec that maps each rule to code is
on #189 (comment 6333138859).

## What is kept, and for how long

- **Orders** (Blobs `orders`): kept for good. Seven years after the
  order, or when the customer deletes their details, the person is
  scrubbed from it (`scrubOrder` in `lib/forget.mjs`).
- **The customer record** (Blobs `customers`): until the customer
  deletes it (`forgetCustomer`). Never deleted for being quiet.
- **Help and contact messages**: seven years, or until the sender
  deletes their details (`deleteOldMessages`).
- **Minimum passes** (Blobs `orders`, `pass/`): the code and its
  dates stay; the email it is tied to goes once the pass is used up,
  revoked or expired (`scrubPasses`), or when the customer deletes
  their details, which also revokes their open passes (#301).
- **Sign-in links, sessions and unconfirmed farm-news sign-ups**
  (Blobs `auth`): until each expires (`sweepAuth` in
  `lib/records.mjs`).
- **Unfinished Venmo checkouts**: a day (`sweepCheckouts`).
- **Backups**: 30 days (`docs/backup.md`).

The scheduled jobs run the scrub, the message and pass expiry, both
sweeps and the quiet-account step once a day (`lib/jobs.mjs`).
`bin/nff jobs run` runs them by hand.

## Deleting details

A customer uses Delete my account on the account page and confirms by
typing the account's email address, which the server checks
(`POST /api/account/delete`); the farm uses `bin/nff customers forget
<email> --apply`, which is a dry run without `--apply`. The Square
customer profiles named on the customer's own orders go first; if
Square cannot be reached, nothing is deleted. Then the orders are
scrubbed and re-pointed to the deleted household, and the messages,
the `auth` records, the Resend contact and the customer record are
deleted. A deletion waits while an order is open, a return is
requested or a Venmo payment is under way. It is final: the same
email later starts a new, empty record.

## Quiet accounts

A year without interaction takes the customer off farm news (a
consent event of type `inactivity`) and sends one notice,
`quietNotice`, saying the account stays open and how to delete it.
`quietNoticeAt` on the record keeps it to one notice per quiet year.
A run sends at most 50 (`QUIET_PER_RUN`), the longest quiet first;
the rest go the next day, and the jobs key `quiet/<day>` keeps it to
one run a day. `lib/retention.mjs` does this; `bin/nff customers
quiet` lists who is due without acting.

The clock is `lastInteraction()` in `lib/retention.mjs`, the only
reader: the latest of `interaction` (`{ at, kind }`), `lastOrderAt`
and `createdAt`. These count:

- following a sign-in link (`sign-in`);
- an action on the account while signed in (`account`);
- an order (`lastOrderAt`);
- the old list's confirmation link (`sign-up`), which proves the
  address is theirs. The public sign-up form does not count: anyone
  can type any address into it;
- a market sale linked by the household's badge (`badge`), for the
  dashboard to record when it scans badges.

Leaving does not count. The one-click unsubscribe records nothing.
Turning farm news or a reminder off in the account records nothing,
and if that session's sign-in is the latest interaction, the clock
goes back to what it was before it. The account page's Save sends
every field, so `leavingChange()` compares the save with the stored
record: it is leaving only when everything that changed went from on
to off.

Email clicks are not recorded. Resend's click tracking would send
every link, sign-in links included, through Resend's redirect, so
the site counts only what it sees itself. The kind `email-click` and
`leavingLink()` are ready for a redirect of our own if James wants
clicks counted. Open tracking is never used.
