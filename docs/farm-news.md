# Farm news by email

Opt-in only, ever. Consent is `marketing` and `marketingAt` on the
customer record (`marketingSource` says how it came: `signup`,
`order`, `account`, `import`, `resend`, `unsubscribe`, and `confirm`
for a re-invite link mailed before #303), set by the sign-up field's
confirmation link, the checkout box, the settings box, or the import
of the old list's paper sheets below. Anyone with an email address
may opt in; a record is made for an address that has never ordered.

## The consent log

Those three fields are the current state. Behind them, `consent` on
the record is the history (#267, #273): one event per opt-in or
opt-out, appended by `saveCustomer` whenever the state changes, never
rewritten. A second opt-in keeps the first.

| Field | Holds |
| --- | --- |
| `action` | `in` or `out` |
| `type` | `website-form`, `checkout`, `account-settings`, `reinvite-confirmation`, `market-sheet`, `in-person`, `resend`, `unsubscribe-link`, or `membership` (reserved) |
| `detail` | the page, the order, the market: `the sign-up form on /news/`, `order NFF-2610-K3WM` |
| `at` | when consent was given; for a market sheet, the sheet's date |
| `recordedAt` | when it was written here, equal to `marketingAt` |
| `capturedBy` | for a sheet or an in-person opt-in, who took it (James or Jim) |
| `evidence` | a pointer to private proof, such as a scan's file name; never the scan |

A record from before the log gets one event from its dated state on
its next write, with the detail `recorded before the log`. That is all
such a record kept: one that had opted out has lost its opt-in.

## Fields kept for later

Every customer write fills these, and nothing reads them yet (#267):

- `language`: a BCP-47 tag, `en` by default; `es` is the only other
  planned value.
- `memberId` and `memberIdStatus`: an opaque random code, unique, and
  `active` or `retired`, so a code can be retired and a new one
  issued. Both null until the membership program exists.
- `memberSince`: when they joined, or null. Joining is also a
  `membership` event in the consent log.
- `memberGroup`: `{ id, joinedAt }`, or null. It links to a group
  record (id, name, founder contact, created) that has no store yet;
  the program's own issue makes one. `discountGroup` is a different
  thing, the price group.

James's spec puts these, and the log, on the household record in
Supabase. Customers live in Blobs until households move there (see
the workspace `CLAUDE.md`); the move carries the log as an events
table keyed by household and these as columns.

Who confirms, by path (James, #303, 2026-10-25, replacing W1): the
public sign-up field, which anyone can type any address into, mails
a confirmation link and joins only on its click. The checkout box and
the account settings switch join at once, with no confirmation email.
The old Fastmail list is not asked to opt in again: it signed up on
the farm's paper sheets, which are the record of consent, and is
imported as subscribed.

The list itself lives in Resend as an audience, so broadcasts go out
with Resend's unsubscribe link, and the sync keeps the audience and
the records in step. James decided this on 2026-09-23 (issue #115):
Resend is the home, marketing will be light, and segments, when
wanted, come from our own records.

## Signing up

A field in the footer and on the news page (`farm-list.html`,
`scripts/news/farm-list.js`). `POST /api/news/subscribe` mails the
confirmation email (`newsConfirm` in `templates.mjs`): one button, a
link that works for seven days, single use, ending on "If you didn't
sign up, you can ignore this email." (James, 2026-10-25, #400).
Nothing is written to the record until the click. An address
already on the list is sent nothing. It is rate-limited per address
like sign-in. The answer is
`{ ok: true }` for any address that looks like one, rate limit
included, so nobody can learn who is on the list from here, and the
note under the field says to check for the link.

`GET /api/news/confirm?token=` is the click: it opts the record in,
dated, source `signup`, detail `the sign-up form on /news/, confirmed
by the link sent <day>`, creating the record if there is none, sends
the welcome, and lands on `/news/?news=confirmed` (or `expired`,
`invalid`), where the note under the field says so. A link the old
list's re-invite mailed before #303 has no `via` and still confirms,
as source `confirm`.

The checkout box joins when the order is placed (`touchCustomer`,
source `order`). The account page's box writes the same consent,
source `account`. Neither sends a confirmation. Everything else is in
`lib/news.mjs`.

## The welcome

A real join from any of the four sends the welcome (`newsWelcome` in
`templates.mjs`, T6), the whole welcome sequence (#267); a repeat
sends nothing. From the order box it goes once the order is paid,
after the order's own emails. A failed send is logged as
`news.welcome.failed` and leaves them on the list.

It names how they opted in, from the last event in the log ("you
signed up on our sheet at the Foster Farmers Market in July"), and
the footer says it again. The market sheets (the old list's import)
also hear that the list moved to a new provider, so a welcome
reaching a long-standing customer makes sense.

Its unsubscribe takes one click and no sign-in (T6c). A random token,
kept hashed in the auth store with no expiry, names the address. The
body's link opens `/news/?unsubscribe=<token>`, whose script posts
it, so a mail scanner that only fetches links takes no one off. The
`List-Unsubscribe` and `List-Unsubscribe-Post` headers give mail apps
the RFC 8058 one-click POST to `/api/news/unsubscribe`, which takes
it from any site. Opting out dates the record, source `unsubscribe`,
and the sync then unsubscribes the contact in Resend.

## Importing the old list

```
bin/nff --production audience import contacts.csv --date=2024-07-12 \
  [--market="the Foster Farmers Market"] [--captured-by=James] \
  [--evidence=foster-2024-07-12.pdf] [--dry-run] [--skip]
```

The old list signed up on paper sheets at the markets, and the
sheets are the record of consent, so it is imported as subscribed
with no confirmation round (James, #303). The CSV has a header naming
email, first and last, and optionally date and market (any order,
any case), or no header and the email first. A row's date and market
win over `--date` and `--market`; a date is required, as YYYY-MM-DD,
and must be a real day not in the future.

Each address joins at once, dated: `marketingAt` is when it was
written, source `import`, and the consent log's event is a
`market-sheet` whose `at` is the sheet's day, `detail` the market,
and `capturedBy` and `evidence` from the flags. Then it gets the
welcome, which names the sheet and the move to a new provider, with
its one-click unsubscribe. The report lists:

- `imported`, `skipped` (already consenting), `invalid` (a bad
  address or date), `withheld` (welcome held by `--no-email`, which the
  command refuses today) and `held` (welcome held by `--skip`, below);
- `declined`: a record that said no here, through Resend or by an
  unsubscribe link, or whose owner had their details deleted while
  the deletion's marker for the sync is still there. A sheet older
  than that choice never overrules it. An address whose owner was
  deleted and whose marker the sync has already cleared looks new,
  so take such addresses out of the CSV.

Nothing reaches Resend from the import: the next sync (or
`audience sync`) adds each as a contact. Replies of "unsubscribe" to
the launch email are not known here either; leave those addresses out
of the CSV. `audience invite` is gone and says so.

### Holding the welcomes: `--skip` and `audience welcome`

`--skip` (or `--skip-welcome`) imports and records consent exactly as
above but sends no welcome. Each record is marked as owing one:
`welcome: { state: "owed", for: <marketingAt>, at }`, where `for` is
the consent the welcome is owed for. This is not `mail.suppressed`,
which means never. The report lists these as `held`, and a `--dry-run`
lists them too.

```
bin/nff --production audience welcome [--dry-run] [--email <addr>]
```

sends the owed welcomes: to every record still owing one, or to the one
address. It asks for the typed confirmation on production, as the
other sends do (`--dry-run` does not ask and sends nothing, only
listing who is `due`).

- **Once each.** Each record is claimed (`sending`), sent under the
  welcome's own idempotency key, then marked `sent`, one record at a
  time, so a rerun sends to no one twice. A record already `sent`,
  even by another run at the same time, is never written over.
- **A send that fails** is listed as `failed`, and what happens next
  depends on whether the email could have gone:
  - Known to have sent nothing: refused before any request (the send
    breaker, or Resend's own guard) or rejected by Resend with a 4xx
    other than 409 and 429. The record goes back to `owed`, and the
    next run tries it again.
  - Possibly accepted: a timeout or network error (Resend can take
    the request and answer after we stop waiting at 4 seconds), a 5xx,
    a 409 (the same key still in progress), a 429, or anything else.
    The record stays `sending`, and the next run for everyone lists it
    as `unsure` and does not send it. Running again is not the fix:
    after the key's day, a second send would be a second email.
- **Unsure records, and a crash.** A record left `sending` is one whose
  send began and whose outcome is not known, whether the run crashed
  or the send failed as above. Look in Resend (or `bin/nff mail list`)
  for a welcome to that address. If one went, nothing more is owed;
  the record stays `unsure` in every bulk run, which is harmless
  because a run for everyone never sends it. If none went, name the
  address with `--email` to send it: Resend
  answers a repeat of the same key within a day with the first send,
  so inside that day it cannot double. After a day, a missing welcome
  in Resend is what makes the second send safe.
- **Opt-outs.** Anyone who has since opted out is skipped (`optedOut`)
  and loses the mark. So does anyone who opted out and joined again by
  another way on (`superseded`): that way welcomed them, so no second
  welcome is owed.
- **`none`** lists an `--email` address that owes nothing: it was
  never held, or its welcome is sent. `--no-email` is refused, as for
  the import.

The record gains the `welcome` field only when imported with `--skip`;
a record imported without it, or joined any other way, never has it.

### Taking out a stale address: `audience remove`

```
bin/nff --production audience remove <email> [--dry-run]
```

takes a dead or duplicate address the import brought in out of our
records, before a sync adds it to Resend (#496). It is a removal, not
an unsubscribe: nothing is recorded as a decline (no `forgotten/`
marker), so a real person can still sign up later, and Resend is never
called. `removeImported` reports one of:

- `deleted`: the record is the import's alone, with nothing on it but
  what the import wrote, and no orders, credit or cart. It goes, held
  welcome and all, with any unsubscribe link a sent welcome left.
- `cleared`: the record has anything else on it (orders, a sign-in, a
  group, credit, details). It stays, and only what the import added
  goes, listed in `cleared`: `marketing` (with `marketingAt` and
  `marketingSource`, while the import's consent is still the one in
  force) and a held `welcome`. The record's state is back as it was
  before the import. The consent log is append-only: the import's
  `market-sheet` event stays, and a `removed` event follows it. The
  record keeps no `marketingAt`, so a later import or sign-up is not
  taken for a decline.
- `none`: no record, or nothing on it from the import.

Afterward the sync has nothing to add and `audience welcome` nothing to
send. Each removal logs one line, `news.removed`, with the time, who
ran it (the Mac's user name), which outcome and the address masked
(`lib/mask.mjs`: `abcdefgh@example.com` is `abc**fgh@exa*****com`),
never in full. `customers delete` logs `customer.deleted` the same way
(2026-10-27, James on #496; these lines hashed the address before). On
production it asks for the address typed out; `--dry-run` asks nothing
and writes nothing. `bin/nff` ships these lines to Axiom at the end of
the run (`docs/monitoring.md`); a dry run ships none.

### Names, and a batch cleanup: `customers set` and `audience apply`

```
bin/nff --production customers set <email> first=.. last=.. [--dry-run]
bin/nff --production audience apply <csv> [--dry-run]
```

The welcome and Resend use `firstName` and `lastName`, and the sync
never changes the name on a contact that exists, so `customers set`
with `first=` or `last=` (`setNames`, #496, 2026-10-27) sets both on
the record, with `name` made from them, and the Resend contact's
`first_name` and `last_name`. A name left out stays as it was. If
Resend can't be reached, the record keeps its change and the report
says `not reached`: run it again. It logs `customer.renamed` with who
ran it, which fields changed and the address masked, never the names.
`name=`, `phone=` and the rest are set without the two, as before.

`audience apply` (`applyAudience`) takes a CSV whose header names
`action,email,first,last`, one row per address:

- `keep` sets the names in the row as `customers set` does. An empty
  cell leaves that name as it is.
- `remove` goes the way of `customers forget --apply`: the record and
  everything else that names the address go, its orders stay but are
  re-pointed to the deleted household, and the Resend contact is
  deleted. A remove waits, and says why, while an order, a return or a
  Venmo payment is open.

It prints one line per row with the address masked, then the counts,
and goes on past a row that fails. Keep the CSV off the repository. On
production it asks for `audience apply` typed out; `--dry-run` asks
nothing, writes nothing and only reads Resend.

Which removal to use, against Resend: `audience remove` and
`customers delete` never call Resend. Before the first sync that is
enough, since the import makes no contacts, unless the address was
already a contact in Resend (`audience sync --dry-run` lists any it
would take in under `imported`). Once a sync has made the
contact, `customers delete` leaves it there, and the next sync takes it
back in as consent given in Resend, with a new record. `customers
forget --apply` (and a `remove` row) deletes the contact too, or, if
Resend can't be reached, leaves a `forgotten/` marker so the next sync
deletes it.

## The list template

`listMail` in `templates.mjs` is the layout for mail to the list:
the welcome, the confirmation and, later, newsletters. It has the order
emails' wordmark, card, font and green, plus a hero image, preview
text, and blocks in `listBlocks`: `p`, `heading`, `image` (with an
optional caption), `button`, `linked`, and the blocks a post is sent
in: `title`, `rich` (a paragraph with links, bold and italics),
`dinkus` and `signature`. Its footer says why the
mail came (the confirmation leaves that to its body), gives the
one-click unsubscribe and the farm's postal
address (CAN-SPAM), and the text version says the same. It follows
the reader's dark mode in Apple Mail, iOS Mail and Outlook; Gmail
shows the light one. The order emails stay light.

Images in list mail need a fixed public address, and Hugo's are
fingerprinted, so the post's own photos are copied at build time to
`/mail/<post>/<name>.jpg` (the `figure` shortcode's Markdown form,
for posts only). The library's `news-letter-sample` shows every block
(its photos are placeholders with no address).

### A post as an email

`lib/post-mail.mjs` turns a post's Markdown, the file Hugo writes at
`public/news/<post>/index.md` (`layouts/news/single.markdown.md`),
into a `listMail`. The website footer is not in that Markdown, so it
is not in the email. It reads headings, paragraphs with links, bold
and italics, photos with a caption, the dinkus, the signature (a
paragraph that begins with an em dash) and a link on a line of its
own, which is the quiet shop link. A list, a quote, a table or a
photo outside `/mail/` throws, so a post never goes out flattened. The
title is the subject and the first thing in the body; the date is left
out, since the post's date is James's to confirm. A post's shortcodes
need a Markdown form (`*.markdown.md`) to reach it.

The library entry `news-post-three-quarters` shows it for review.
On staging it reads the deploy's `public/` (`included_files` in
`netlify.toml`); locally, point `NEWS_BUILD_DIR` at the Hugo output.

```
hugo --gc --quiet -d .ignored/build
NEWS_BUILD_DIR=.ignored/build bin/nff news mail <post> \
  --site https://www.northfosterfarm.com [--preview "<inbox line>"]
```

writes `<post>.html` and `<post>.txt` to `.ignored/outbox` for Resend's
editor. The unsubscribe link is Resend's variable,
`{{{RESEND_UNSUBSCRIBE_URL}}}`; check in the editor that it fills.

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
`RESEND_AUDIENCE_ID` are ignored.

The last sync's time and counts are under `news/sync` in the jobs
store; the daily run marks `news/sync/<day>`.

## Sending

Broadcasts from Resend's editor, to the audience, with the
unsubscribe link Resend inserts. An unsubscribe reaches the record at
once through the webhook above, or at the next sync if it missed.
Template-driven broadcasts from the CLI, and sends to a query of the
records from the jobs run, can come later; nothing here stands in
their way.
