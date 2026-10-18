# Staging

A deploy that is not production keeps its own data, writes its email
to an outbox instead of sending it and talks to the Square sandbox.
It is behind an access gate (below), and the staging branch deploy
also carries a toolbar for reading that outbox and running the jobs by
hand, for James alone. Production carries none of it.

## What decides

Two variables, one value each: `production`, `deploy-preview`,
`branch-deploy` or `dev`. Netlify sets `CONTEXT` at build time, and
the toolbar partial reads it then. A function sees nothing of it, so
the functions read `SITE_CONTEXT`, a variable on Netlify with one
value per context (set 2026-09-23). `lib/store.mjs` exports
`deployContext`, which reads the first and falls back to the second.
Unset means production: bare store names, no staging endpoints.

- **Stores.** `lib/store.mjs` prefixes the Blobs store names with the
  deploy context unless it is production: a preview's orders live in
  `deploy-preview-orders`, the staging branch's in
  `branch-deploy-orders`, production's in `orders`. A test order on a
  preview never lands beside a real one. `bin/nff --staging` and
  `bin/nff --preview` reach those stores, and read `.env.staging` or
  `.env.preview` (never `.env`) for the sandbox token and location,
  `MAIL_DRIVER=outbox` and the deploy's `SITE_URL`, so a cancel or
  a refund from the terminal meets the same sandbox and its email
  lands in the toolbar's inbox.
- **Mail.** `MAIL_DRIVER=outbox` on the non-production contexts:
  every message is written to the `jobs` store under `outbox/` and
  nothing is sent. The last 200 are kept.
- **Square and PayPal.** `SQUARE_ENV=sandbox` with the sandbox token,
  location and application id, and `PAYPAL_ENV=sandbox` with the
  sandbox client id and secret, on the non-production contexts.
- **The toolbar.** `layouts/partials/staging-toolbar.html` renders
  only when the build-time `CONTEXT` is `branch-deploy`: on staging,
  never on a deploy preview, a local build or production. Its
  stylesheet and script are built by Hugo only then, so every other
  build's HTML, CSS and JS have no trace of it. (The build
  environment cannot decide this: previews build with Hugo's
  production environment too. `getenv "CONTEXT"` is allowed in
  `hugo.toml`'s security settings for this.)
- **The endpoints.** `netlify/functions/staging.mjs` answers only off
  production, and only where `GATE_TOOLBAR_EMAIL` or `STAGING_TOKEN`
  is set: anywhere else every `/api/staging/*` path is a 404 (#255).
  There it serves the outbox and runs the jobs, to the toolbar
  owner's gate session (see "Who may use the toolbar") or, for the
  jobs run and info only, to `STAGING_TOKEN` as a bearer.
- **Links in mail.** A function cannot see its own deploy address
  either (`DEPLOY_PRIME_URL` is build-only), so off production the
  links in emails fall back to `URL`, which is production. `SITE_URL`
  on the branch-deploy context is therefore the staging address, and
  a sign-in link from the staging deploy comes back to it. A pull
  request preview has no fixed address, so its sign-in links point at
  production: sign in on staging, review pages on previews.
- **Health.** `GET /api/health` reports `context`, so a deploy can be
  asked which it is. `null` on a non-production deploy means
  `SITE_CONTEXT` is missing there, and the toolbar says so.

## The toolbar

A yellow "Staging" tab in the bottom right corner of every page. It
opens to a panel with:

- **Emails.** The email library: every email the site sends, and the
  Farm news drafts, each built from sample data by
  `netlify/functions/lib/library.mjs` and listed in a sidebar by who
  receives it. Search matches names, tags, subjects and body text; a
  tag narrows the list to itself; the filter shows what waits on
  James's approval. The open email shows as HTML or text, with what
  he has not yet seen of it. Nothing is sent. `#email=<id>` on any
  page opens the library at that email (Copy link gives it), and
  `#emails` opens it at the top. A new template gets an entry in
  `library.mjs`, "to approve" until James says otherwise.
- **Approving and rewriting.** An open email that waits on James has
  Approve and Rewrite. Approve takes effect at once. Rewrite opens
  the subject and the text for editing, with the sample values (name,
  order number, dates, amounts, links) as shaded tokens that can be
  moved or deleted but not changed, so the placeholders survive; the
  email then shows "rewritten, to apply" and the new text, and Revert
  drops the rewrite. Both are saved in this deploy's `jobs` store
  under `library/` (`lib/review.mjs`), never in production's, and
  each counts only for the wording it was given against: once the
  code's text changes, the email is "to approve" again. An agent
  ports them: `bin/nff library --staging` lists each approval to add
  to `APPROVED` in `library.mjs` and each rewrite as a diff against
  the code's text, and `bin/nff library clear <id> --staging` drops
  an email's records once they are in. Both need
  `NETLIFY_SITE_ID` in `.env.staging` and the Netlify token in the
  Keychain (`docs/secrets.md`, Netlify); without them they read an empty store in memory and say so. The
  Netlify CLI reads the same records from a linked checkout:
  `bin/nff netlify blobs:list branch-deploy-jobs --prefix library/`, then
  `bin/nff netlify blobs:get` or `blobs:delete` on each key. Farm news
  rewrites go to the email lane, whose drafts they are.
- **Inbox.** The outbox, newest first, refreshed every five seconds
  while open. A message opens in a new window as the HTML the
  customer would have received, with a bar above it saying who it was
  for, and a link to the plain text. The panel flashes when a new
  message arrives, so a sign-in request on `/login/` is followed by
  its magic link appearing here. Clear empties it.
- **Jobs.** Run now runs the 15-minute jobs as of the current time.
  As 8:00 today and As 18:00 today run them as of that time, which
  is how the morning report and the Tomorrow manifest are made to
  send. Each daily report sends once per day; tick "Send today's
  reports again" to have them go again. The run's report shows
  under the buttons.
- **This browser.** Reset to a first visit leaves the browser as a
  stranger's first load finds it (#267). It signs out on the server,
  clears all of localStorage and sessionStorage (the cart draft and
  any undelivered submission, paid-order edit drafts, the dismissed
  delivery-policy note, the Venmo and farm news flags, the video
  preference and the sign-in cache) and every cookie a script can
  reach, then reloads. Only the toolbar's open state stays. `assets/scripts/staging/reset.js` clears whole storages, so a
  key added later is covered; `test/staging-reset.test.mjs` and the
  staging e2e check it.

Collapse folds the panel back to the tab and is remembered per
browser. Hide removes the toolbar until the next page load, for
looking at the page itself; the tab is back on reload.

## The staging branch

Work lands on `next`, which does not build. Every push to `next`
runs the `lint-and-test` check (`.github/workflows/ci.yml`), and
`staging` is fast-forwarded to a `next` commit that passed it, one
batch at a time. `main` is fast-forwarded the same way to a `staging`
commit once it has been reviewed here. Neither ever takes a merge
commit or a rebase-merge: promotion moves a branch to a SHA already
checked, so the commit that ships is the commit that was tested.

Branch protection on `staging` and `main` requires `lint-and-test`
and applies to admins, so a push to a commit with no passing check is
refused. It does not require the branch to be up to date, which a
fast-forward already is. `next` is left open for the lanes to push
to.

With branch deploys allowed for it on Netlify, `staging` has the
stable address `staging--north-foster-farm.netlify.app` (the
`branch-deploy` context), which the Square and PayPal sandbox webhooks
can be pointed at. Pull request previews share the `deploy-preview`
stores.

## Payments on staging

The Square sandbox takes the card and wallet payments with Square's
test cards, and its webhook at the staging address reports refunds
made in the sandbox dashboard (`refund.updated`). Venmo needs a PayPal
sandbox business account with Venmo enabled, its client id and secret
on the non-production contexts, and a sandbox webhook for
`PAYMENT.CAPTURE.COMPLETED` and `PAYMENT.CAPTURE.REFUNDED` at the
staging address, whose id is `PAYPAL_WEBHOOK_ID` there. The page adds
`buyer-country=US` to the PayPal SDK in the sandbox, which is what
makes the Venmo button show. `docs/qa-fulfilment-a.md` has the steps.

## The jobs, on a schedule

Netlify runs scheduled functions on the production deploy only. The
`Staging jobs` workflow (`.github/workflows/staging-jobs.yml`) calls
`/api/staging/jobs/run` instead, so staging's jobs run on Netlify,
with its own environment. It asks for every fifteen minutes, off the
quarter hour, but GitHub schedules it only from `main` and throttles
it: runs have come two to six hours apart (#164). The jobs are safe
to run late or twice, but a day with no run between 18:00 and midnight
gets no delivery reminder and no manifest; start one from the
workflow's Run workflow button when that matters. It needs the repository
secret `STAGING_TOKEN`, the same value as on Netlify. The repository
and its Actions logs are public, so the step writes the response to a
file and prints only the HTTP status and counts
(`bin/staging-jobs-summary.mjs`), never the report, which can name
orders and customers. The toolbar's Jobs buttons still run them on
demand.

## The order limit

`/api/orders` allows 12 posts per 10 minutes from one address. Off
production, a request with the header `X-Staging-Token: <STAGING_TOKEN>`
skips it, so the QA suite sends the header and leaves the limit to a
person testing by hand on the same machine. A request without it meets
the limit as production does, which is how the limit itself is tested.
The end-to-end suite sends `E2E_STAGING_TOKEN` instead, which skips it
the same way.

## The end-to-end suite's access (#266)

`e2e/` reaches staging's records, outbox and maintenance switch only
through `POST /api/staging/e2e` (`lib/e2e.mjs`), with
`E2E_STAGING_TOKEN`. The deploy runs each step against its own
stores, so the suite holds no Netlify personal access token and no
Blobs credentials, and a CI run needs none. The token opens that path
and the order-limit exemption and nothing else; `STAGING_TOKEN` (the
toolbar and the jobs workflow) does not open the path, and this one
does not open the toolbar's. Both are 404 on production and wherever
they are unset.

Set `E2E_STAGING_TOKEN` on Netlify's `branch:staging` context and
give the same value to the suite: in the environment, or in
`.env.e2e-staging` (ignored) at the checkout root. The two specs that
sign as the deploy would read `SQUARE_WEBHOOK_SIGNATURE_KEY` and
`SQUARE_WEBHOOK_URL` from the same place and skip without them.

## Setting it up

On Netlify, `SITE_CONTEXT` with one value per context, named after
the context (set 2026-09-23). Then, for the `deploy-preview`,
`branch-deploy` and `dev`
contexts only: `MAIL_DRIVER=outbox`. `GATE_TOOLBAR_EMAIL` and
`STAGING_TOKEN` go on the branch-deploy context alone: without them
the staging API is a 404, so a preview, which has neither, shows no
outbox (magic links are in it). The gate's `GATE_RESEND_KEY` and
`GATE_MAIL_FROM` go on the branch-deploy context alone: a preview
builds pull-request code, so it holds no secret (docs/secrets.md,
"Previews"). A preview is still gated, and with no sending key it
mails no link, so it is closed to everyone, which fails safe. The
allowlist is seeded with `bin/nff --staging gate allow add`
before the first deploy that carries the gate. Leave production's `MAIL_DRIVER=resend`
alone. Allow branch deploys for `staging` under Site configuration →
Build & deploy → Branch deploys. Subscribe the Square sandbox
webhook (`refund.updated`) to
`https://staging--north-foster-farm.netlify.app/api/square/webhook`
and the PayPal sandbox webhook (`PAYMENT.CAPTURE.COMPLETED`,
`PAYMENT.CAPTURE.REFUNDED`) to
`https://staging--north-foster-farm.netlify.app/api/paypal/webhook`,
with that subscription's id as `PAYPAL_WEBHOOK_ID` on the same
contexts.

## The access gate

Staging, branch deploys and deploy previews are not public. An edge
function (`netlify/gate-edge/gate.mjs`, installed at build time by
`bin/install-gate.mjs` for those two build commands and never for
production's) stops every request that has no gate session, and sends
`X-Robots-Tag: noindex` on every response. A browser lands on a
sign-in page; a script gets a bare 401.

Signing in is by magic link. A visitor types an address at
`/api/gate/signin`; if it is on the allowlist, a link comes to that
mailbox and following it sets a session cookie for a year. An address
off the list gets the same page and no email, so the list cannot be
read off the answer. Requests are limited to 3 per address from one
IP and 10 per IP in 15 minutes, so a stranger cannot use up a listed
person's allowance. Sessions and links are stored hashed.

The allowlist is exact addresses and whole domains, in the `gate`
store of each context:

```
bin/nff --staging gate allow list
bin/nff --staging gate allow add pat@example.com
bin/nff --staging gate allow add @example.com
bin/nff --staging gate allow remove pat@example.com
bin/nff --staging gate sessions end pat@example.com
bin/nff --staging gate sessions end-all --yes
```

Removing an entry ends the sessions it let in. `--preview` reaches the
previews' list, which is separate.

The link is the one email staging really sends: a plain-text message
through `GATE_RESEND_KEY`, a Resend key made for staging alone, from
`GATE_MAIL_FROM`. The code refuses any recipient not on the allowlist,
and asks the send breaker first with a ceiling of its own (6 an hour,
20 a day, `data/gate.json`). A trip stops the gate's mail and alerts;
`bin/nff breaker reset --staging` clears it after the key is replaced.
Everything else stays on the outbox.

Machines pass by credential, never by being public. Each way past the
gate is a row of `EXEMPTIONS` in `netlify/functions/lib/gate-edge.mjs`
and `docs/secrets.md`, and `test/gate.test.mjs` proves each stays
closed without its credential:

- the Square and PayPal sandbox webhooks, by their own signature
  checks in the functions;
- `/api/staging/jobs/run` and `/api/health`, by `STAGING_TOKEN`;
- the end-to-end suite, by `E2E_STAGING_TOKEN`, as a header or the
  `nff_gate_machine` cookie that `playwright.config.mjs` sets for the
  deploy's host;
- `/api/gate/*`, which is the sign-in itself.

In production there is no gate: its build never installs the edge
function, and the function and its logic return untouched for any
context but `branch-deploy` and `deploy-preview`. Whether staging was
indexed while it was public is checked in the issue, not here.

## Who may use the toolbar

Only James. The toolbar opens for a gate session whose address is
`GATE_TOOLBAR_EMAIL` (a variable on the staging context, so the address
is config and not code); the browser's cookie is the credential and
nothing is typed. Anyone else who signs in gets the site and no
toolbar: the endpoints answer 403 to their session and the toolbar
stays hidden. Reviewers (Jim, design and marketing helpers) are added
to the allowlist and see the site only.

`STAGING_TOKEN` is for machines (Actions, health checks) and is never
typed into a browser. It opens the jobs run, the info and the crash
proof, and nothing that reads mail. `STAGING_REVIEWER_TOKEN` is
retired. Each request is logged by key name (`staging.key_used`), never
by value. Which way in opens what is `KEYS` in
`netlify/functions/staging.mjs`, and `docs/secrets.md` lists it: a new
toolbar feature updates both.
