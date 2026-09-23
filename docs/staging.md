# Staging

A deploy that is not production keeps its own data, writes its email
to an outbox instead of sending it, talks to the Square sandbox, and
carries a toolbar for reading that outbox and running the jobs by
hand. Production carries none of it.

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
  `bin/nff --preview` reach those stores.
- **Mail.** `MAIL_DRIVER=outbox` on the non-production contexts:
  every message is written to the `jobs` store under `outbox/` and
  nothing is sent. The last 200 are kept.
- **Square.** `SQUARE_ENV=sandbox` and the sandbox token and location
  on the non-production contexts, as already set.
- **The toolbar.** `layouts/partials/staging-toolbar.html` renders
  only when the build-time `CONTEXT` is set and is not production.
  Its stylesheet and script are built by Hugo only then, so the
  production HTML, CSS and JS have no trace of it. (The build
  environment cannot decide this: previews build with Hugo's
  production environment too. `getenv "CONTEXT"` is allowed in
  `hugo.toml`'s security settings for this.)
- **The endpoints.** `netlify/functions/staging.mjs` answers 404 in
  production, whatever the path. Off production it serves the outbox
  and runs the jobs. `STAGING_TOKEN`, when set on those contexts, is
  required as a bearer token or `?token=`; the toolbar asks for it
  once and remembers it in the browser.
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

Collapse folds the panel back to the tab and is remembered per
browser. Hide removes the toolbar until the next page load, for
looking at the page itself; the tab is back on reload.

## The staging branch

`staging` is the branch that carries every open pull request in
landing order, cherry-picked onto `main` and force-pushed whenever
one changes, so the whole set can be exercised in one deployment.
Its pull request is never merged. With branch deploys allowed for it
on Netlify, it has the stable address
`staging--north-foster-farm.netlify.app` (the `branch-deploy`
context), which the Square sandbox webhook can be pointed at. Pull
request previews stay for review; they share the `deploy-preview`
stores.

## What staging cannot do

- **Receive mail.** Venmo's notifications reach production's inbound
  address only. On staging, `bin/nff venmo simulate` (to come) posts
  a signed `email.received` payload to the staging endpoint.
- **Run on a schedule.** Netlify runs scheduled functions on the
  production deploy only; the toolbar's Jobs buttons stand in.

## Setting it up

On Netlify, `SITE_CONTEXT` with one value per context, named after
the context (set 2026-09-23). Then, for the `deploy-preview`,
`branch-deploy` and `dev`
contexts only: `MAIL_DRIVER=outbox`, and `STAGING_TOKEN` if the
outbox should not be open to anyone with the preview's address
(magic links are in it). Leave production's `MAIL_DRIVER=resend`
alone. Allow branch deploys for `staging` under Site configuration →
Build & deploy → Branch deploys. Subscribe the Square sandbox
webhook to `https://staging--north-foster-farm.netlify.app/api/square/webhook`.
