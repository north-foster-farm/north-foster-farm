# Secrets

Every credential the site holds, where each copy lives, and how to
replace it. Names only: values belong in Netlify, the vendor's
dashboard and the ignored `.env.*` files, never here. `.env.sample`
is the list of names the code reads; this is what to do with them.

## The rules

- **Production keeps its keys through launch** (James, 2026-10-16).
  New, separate keys go to staging, and development gets fakes.
  The old checkout's Resend credentials go once the release's live
  checks pass (#237's P9, below). The launch is fixed forward, with
  no rollback to the old checkout (`docs/rollback.md`).
- **A change on Netlify needs a deploy.** Functions read their
  environment at deploy time. After `netlify env:set`, trigger a
  production deploy (Deploys → Trigger deploy, or
  `netlify api createSiteBuild`) and wait for it to publish before
  revoking the old value. The previous deploy still holds the old
  key, so after a rotation or a leak never publish a deploy built
  before it; that new deploy is the rollback floor, and a rollback
  past it reverts on `main` or fixes forward (`docs/rollback.md`).
- **New first, old last.** Create the replacement, set it, deploy,
  prove it, then revoke the old one. Only the Square access token
  cannot work this way.
- **One value per context.** Set each value on its own context, never
  on "all", and never copy one context's value to another.
- **Every copy.** A secret often lives in two or three places (the
  table says which). Update them all in one sitting.
- **Set secrets as secret.** `netlify env:set NAME value --context
  ctx --secret --json`. `--scope` silently fails; leave scopes at the
  default. Secret values cannot be read back from the UI or CLI.
- **Write it down.** Note each rotation, its date and its reason in
  the issue that asked for it, or in a new one.

## Incident response

**Rotate the secret at once** on a suspected leak, a lost laptop, or
someone with access leaving. Each section below says what counts as
access for that secret. Do this before anything else; the schedule
below is not a substitute for it.

## Schedule

- **Every secret rotates yearly, on January 1** (decided 2026-10-16;
  replaces the six-month rule). The Netlify personal access token
  already rotates every Jan 1.
- **Ping URLs, ids and the build hook** rotate only on a leak, never
  on the schedule.

"On the schedule" below means January 1 each year.

## Where they live

Netlify contexts: `production`, `branch-deploy` (staging),
`deploy-preview` and `dev`. Locally, bin/nff and the e2e suite read
`.env` (bare `bin/nff`), `.env.staging` (`--staging`),
`.env.preview` and `.env.production` (`--production`), all ignored by
`.gitignore`. GitHub holds one repository secret, `STAGING_TOKEN`.

*Today* is as measured on #244. *Own*: production has its own value,
and staging, previews and `dev` share one other. *Prod's*:
production's value is set on every context. *Local*: no Netlify copy.
*After #251* is the plan in the next section.

| Name | Kind | Today | After #251 | Issued by |
| --- | --- | --- | --- | --- |
| `SQUARE_ACCESS_TOKEN` | secret | own | per env | Square |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | secret | own | per env | Square |
| `PAYPAL_CLIENT_SECRET` | secret | own | per env | PayPal |
| `PAYPAL_WEBHOOK_ID` | id | own | per env | PayPal |
| `RESEND_API_KEY` | secret | own | per env, see Resend | Resend |
| `RESEND_AUDIENCE_KEY` | secret | prod's | per env, see Resend | Resend |
| `RESEND_WEBHOOK_SECRET` | secret | prod's | per env, see Resend | Resend |
| `RESEND_READ_KEY` | secret | prod's | deleted after P9 | Resend |
| `RESEND_LOOKUP_KEY` | secret | local | local | Resend |
| `AXIOM_TOKEN` | secret | own | per env | Axiom |
| `HEALTHCHECKS_JOBS_URL` | ping URL | own | per env | healthchecks.io |
| `HEALTHCHECKS_ALERT_URL` | ping URL | own | per env | healthchecks.io |
| `STAGING_TOKEN` | secret | off prod; GitHub | staging; GitHub | us |
| `E2E_STAGING_TOKEN` | secret | off prod; GitHub | staging; GitHub | us |
| `NETLIFY_AUTH_TOKEN` | secret | local | local, one per person | Netlify |
| `PICKUP_SCHEDULE_HOOK` | build hook URL | local | local | Netlify |
| `PAYPAL_*_EMAIL`, `_PASSWORD` | sandbox logins | local | local | PayPal |

So every branch's deploy preview holds production's Resend audience
key, webhook secret and read key today. Fork pull requests need
approval before they build (the site's untrusted-deploy setting is
`review`), which keeps them out.

`SQUARE_APPLICATION_ID`, `SQUARE_LOCATION_ID` and `PAYPAL_CLIENT_ID`
are public: the order page receives them. The sandbox PayPal logins
sit in `.env.staging` only and are not in `.env.sample`.

The rest of `.env.sample` is configuration, not secret:
`ACCOUNTS_ENABLED`, `ADMIN_EMAILS`, `ADMIN_URL`, `AXIOM_DATASET`,
`CONTACT_URL`, `DEV_NOTIFICATIONS_EMAIL`, `MAIL_*`, `NETLIFY_SITE_ID`, `PAYPAL_ENV`,
`PICKUP_SCHEDULE`, `RESEND_AUDIENCE_ID`, `SITE_CONTEXT`, `SITE_URL`,
`SQUARE_ENV`, `SQUARE_VERSION`, `SQUARE_WEBHOOK_URL`, `VENMO_HIDDEN`,
and Netlify's own `HUGO_*` and `NODE_VERSION`.

There is no session or signing secret. Sign-in links, sessions and
unsubscribe links are random 32-byte tokens in the `auth` Blobs store
(`lib/auth.mjs`, `lib/news.mjs`). Links and sessions are stored under
a hash of the token (`session/<sha256(id)>`), so reading Blobs gives
no live id. Nothing to rotate.

## One set per environment (#251)

*Per env* in the table means production keeps the value it has,
staging gets new credentials of its own, previews get none, and
development gets a fake in `.env`. James creates every credential and
sets every value; agents never see them.

- **Square:** a Developer Console app per environment, each with its
  own token and webhook key. Development uses a second Square
  developer login with its own test account, so it shares no sandbox
  data with staging.
- **PayPal:** a sandbox app per environment, each with its own
  business account, credentials and webhooks. Staging's business
  account needs Venmo on and `buyer-country=US`.
- **Resend:** production only (decided 2026-10-17). Staging sends no
  email: its `MAIL_DRIVER` is the outbox, James reads the mail in its
  email library, and it holds no Resend team, key, audience or
  webhook. Development and previews get none either. The code
  enforces it: `netlify/functions/lib/resend-guard.mjs` refuses any
  call to Resend's API outside production, whatever the variables
  say, and `test/resend-guard.test.mjs` fails if a module that calls
  Resend skips the check. Delete the farm team's Resend webhook that
  points at staging.
- **Axiom:** a dataset and an ingest-only token each for production
  and staging.
- **Healthchecks:** separate checks per environment. Staging's jobs
  check needs a period of about 6 hours, since its jobs run every 2
  to 6 hours (#164).
- **Backup export (Cloudflare R2):** production only. The token is
  bucket-scoped *Object Read & Write* (James approved it 2026-10-17,
  D-EXPORT): R2 offers no write-only token, so a bucket lock rule
  stops deletes and overwrites, and the age encryption makes a read
  worthless. Copies are kept 30 days (D-189): the lock rule protects
  each object for 30 days and a lifecycle rule deletes older ones. `BACKUP_R2_SECRET_ACCESS_KEY` is a secret; the setup is
  in `docs/backup.md`.
- **`STAGING_TOKEN`:** staging only.
- **`E2E_STAGING_TOKEN`:** staging only; the end-to-end suite's own
  token (`docs/staging.md`). The suite holds it and no Netlify token.
- **`NETLIFY_AUTH_TOKEN`:** one per person, since Netlify cannot
  scope a token. The e2e suite no longer uses it (#266).
- **Previews** (after #255): `SITE_CONTEXT=deploy-preview` and
  `PICKUP_SCHEDULE`, `MAIL_DRIVER` unset so mail is logged, and
  nothing else. A preview then shows no pay buttons and its order API
  answers 502, but pages, the news sign-up, contact and health work.

The order: make the new credentials, push them with `bin/nff env
push`, confirm with `bin/nff env check`, then revoke the old shared
ones. The old non-production values go once staging's replacements
are live. Production's values are not revoked; `RESEND_READ_KEY` and
the old `RESEND_WEBHOOK_SECRET` go only after P9.

## Pushing and checking env

These land with #264; until then, set values one at a time with
`netlify env:set`.

The launch guide generates `.env.production.sample`,
`.env.staging.sample` and `.env.development.sample`, and they are
committed from James's approval in it. Each lists only the keys its
environment uses. A key left empty in the staging or production
sample is a secret. The development sample has a working fake for
every key, so `cp .env.development.sample .env` runs the tests and
the dev server.

- **`bin/nff env push --production|--staging`** sets every key in the
  filled-in `.env.production` or `.env.staging` on that context, one
  `netlify env:set` per key (`env:import` cannot target a context),
  with `--secret` for each secret. It reads the other values back.
  Netlify never returns a secret, so secrets are checked by name
  only.
- **`bin/nff env check --production|--staging`** compares the key
  names in the sample, the local file and the Netlify context, and
  fails on any difference. It also fails on any value attached to
  several contexts or to "all", which is how sharing happens on
  Netlify. It prints names, never values.
- **`npm run check:env`** runs in the Netlify build, beside
  `check:schedule`, and fails the build when a key the sample lists
  for that context is missing.

After a push, deploy, as the rules say.

## Square

**`SQUARE_ACCESS_TOKEN`.** The application's personal access token,
one for sandbox and one for production. It never expires. It carries
every permission on the farm's Square account, whatever the scopes
`order-form.md` lists: a leak lets someone read every customer and
order and refund any payment.

Square offers no overlap: Replace issues a new token and the old one
should be taken as dead at once (not verified whether Square allows a
grace period). Checkout fails from that moment until the new deploy
is live, card and Venmo alike, since a Venmo payment is recorded on
the Square order. Expect five minutes or so.

1. Pick a quiet hour; check `bin/nff orders list --open` and that no
   checkout is under way.
2. Developer Console → the app → Credentials → Production → Replace
   (beside the access token). Copy the new token.
3. `netlify env:set SQUARE_ACCESS_TOKEN <new> --context production
   --secret --json`, then trigger a production deploy.
4. Update `.env.production` (and `.env` if it holds production).
5. When the deploy is live, `GET /api/health` and `bin/nff
   --production orders list`. Place a small real order and refund it
   if in doubt.

The sandbox token is the same steps under Sandbox, for each context
that holds it (after #251, staging alone) and `.env.staging`. No
customer is affected.

Cadence: on the schedule. Console access counts as access.

**`SQUARE_WEBHOOK_SIGNATURE_KEY`.** The subscription's HMAC key;
`square-webhook.mjs:29` checks one key only. Leaked, it lets someone
forge refund events onto orders. Replace it in the Developer Console
(Webhooks → the subscription → replace the signature key) or with
`UpdateWebhookSubscriptionSignatureKey`. Until the deploy with the new
key is live, deliveries answer 401 and Square retries them for up to
24 hours, so nothing is lost and no customer notices. Set it on
Netlify, deploy, update `.env.*`. Cadence: on the schedule.

`SQUARE_APPLICATION_ID` and `SQUARE_LOCATION_ID` are public; the page
receives both.

## PayPal

**`PAYPAL_CLIENT_SECRET`.** The REST app's secret, live and sandbox.
Leaked with the public client id, it moves money out of the farm's
PayPal Business account through the API (refunds, payouts if
enabled). PayPal allows two secrets per app, so this rotates without
downtime:

1. developer.paypal.com → Apps & Credentials → Live → the app →
   add a second secret.
2. `netlify env:set PAYPAL_CLIENT_SECRET <new> --context production
   --secret --json`; deploy; update `.env.production`.
3. Take a Venmo payment or run `bin/nff --production` against PayPal
   to prove the new secret.
4. Disable the old secret, then delete it.

A warm function keeps its cached bearer token (`lib/paypal.mjs:98`)
for its lifetime, so the old secret's disable shows only on new
tokens. Sandbox is the same under Sandbox. Cadence: on the schedule.

**`PAYPAL_WEBHOOK_ID`.** Not a secret: the subscription's id, which
`verify-webhook-signature` needs (`lib/paypal.mjs:338`). It changes
only if the webhook is deleted and recreated; then set the new id and
deploy, or every PayPal webhook fails verification.

## Resend

API keys cannot be rotated in place: create a new key with the same
permission and domain, swap it in, delete the old one. Keys can be
created and deleted by API, but permission and domain only in the
dashboard.

- **`RESEND_API_KEY`**: sending access for the domain. Leaked, it
  sends mail as the farm and burns the daily quota and the domain's
  reputation. Create, set on Netlify (production; staging has its
  own), deploy, delete the old. No downtime.
- **`RESEND_AUDIENCE_KEY`**: the key the newsletter sync uses
  (`lib/news.mjs:380`). If full access, a leak reads and edits every
  contact. Same steps.
- **`RESEND_LOOKUP_KEY`**: full access, local only, for `bin/nff
  --production mail` (`lib/sent.mjs:36`). Leaked, it reads every email
  the site has sent, with customer addresses. Create, update
  `.env.production`, delete the old.
- **`RESEND_READ_KEY`**: read by no code in the release; only the old
  invoice checkout's `venmo-inbound` read received email with it.
  Delete it from Netlify and Resend after P9 rather than rotate it.
- **`RESEND_WEBHOOK_SECRET`**: the endpoint's `whsec_` secret. Rotate
  in the dashboard or with `POST /webhooks/{id}/signing-secret/rotate`.
  For 24 hours Resend signs with both secrets, and
  `resend-webhook.mjs:49` accepts any matching `v1` signature, so set
  the new one and deploy within the day. No downtime. Today
  production's value is the old Venmo inbound endpoint's secret. On
  launch day #237 replaces it with the `/api/resend/webhook`
  endpoint's, and the old value is not kept.

Cadence: on the schedule; the lookup key also whenever the laptop
changes hands.

## Axiom

**`AXIOM_TOKEN`**: ingest into the dataset. Leaked, someone writes
junk into the logs or, with wider rights, reads them (order ids,
emails). Settings → API tokens → the token → Regenerate, or
`POST /v2/tokens/{id}/regenerate` with `existingTokenExpiresAt` set
a day out, which keeps the old token alive while the deploy lands.
Set, deploy, update `.env.*`. Logs are lost only for a failed swap.
Give each token an expiry a few weeks past its next scheduled
rotation, so a missed date shows as an expired token rather than
going unnoticed.

## healthchecks.io

**`HEALTHCHECKS_JOBS_URL`, `HEALTHCHECKS_ALERT_URL`**: ping URLs with
the check's UUID in them, which is immutable. Leaked, someone can
ping a check well and hide an outage, or post `/fail` and page James.
To replace one, create a new check with the same period, grace and
channels (dashboard, or `POST /api/v3/checks/` with a read-write API
key), set its URL, deploy, delete the old check. Cadence: on a leak
only. The project's API keys (Settings → API Access) are separate;
none is stored here.

## Staging

**`STAGING_TOKEN`**: guards `/api/staging/*` (the outbox, with its
magic links, and the jobs run) and lifts the order limit off
production (`orders.mjs:73`, `staging.mjs:107`). Production holds the
name with no value and answers 404 there anyway. Leaked, someone reads
staging's outbox and signs in as a staging customer. Generate a new
random value and set it in one sitting on Netlify (each context that
holds it; after #251, staging alone), as the GitHub repository secret
(`gh secret set STAGING_TOKEN`), and in `.env.staging`; redeploy
staging; re-enter it in the staging toolbar. Until the GitHub secret
matches, the Staging jobs workflow fails. Cadence: on the schedule,
and when someone leaves the bullpen or a reviewer no longer needs
staging.

## Netlify

**`NETLIFY_AUTH_TOKEN`**: a personal access token, local only, for
bin/nff to reach Blobs. A PAT carries every
permission its owner has on Netlify: every site, every env var, DNS,
deploys, and every order and customer in Blobs. The worst leak here.

User settings → Applications → Personal access tokens → New access
token, expiring on the next Jan 1. Put it in each `.env.*`, run
`bin/nff --production health`, then Revoke the old one. No downtime;
nothing on Netlify reads it. Cadence: every Jan 1, before the old
token expires, and at once on a leak. A Netlify password reset
revokes every PAT at once, so after one, mint a new token before the
CLI is needed. The `netlify` CLI's own login is a separate token in
`~/Library/Preferences/netlify/config.json`; `netlify logout` and
`login` replace it.

**`PICKUP_SCHEDULE_HOOK`**: a build hook URL. Leaked, anyone can
start production builds. Site configuration → Build hooks → delete
and recreate; update `.env.production`.

## Sessions

There is no secret to rotate. To end every customer session (after a
Blobs leak, say), delete every `session/` key in the production
`auth` store (the daily sweep also deletes any session stored under
a raw id, from before sessions were hashed); each customer signs in
again by magic link. bin/nff has no command for this yet;
`customers rename` ends one customer's.

## Known gaps (2026-10-16)

- Until #251 is done, the contexts share values as the table shows,
  and `farm-news.md`'s claim that each environment has its own
  webhook endpoint and secret is not yet true.
- The local `.env` is a production file (`SQUARE_ENV=production`)
  rather than a link to `.env.development`, as `.env.sample` says, and
  there is no `.env.production`; `RESEND_LOOKUP_KEY` sits in `.env`.

## Out of scope

The dashboard's secrets (Supabase, VAPID) are its own; see its
repository. `GITHUB_TOKEN` in the workflows is minted per run.

## Vendor references

Checked 2026-10-15.

- Square webhook retries (24 hours):
  <https://developer.squareup.com/docs/webhooks/troubleshooting>
- Square signature key:
  <https://developer.squareup.com/reference/square/webhook-subscriptions-api/update-webhook-subscription-signature-key>
- Resend webhook secret rotation (24-hour overlap):
  <https://resend.com/docs/api-reference/webhooks/rotate-signing-secret>
- Resend API keys: <https://resend.com/docs/dashboard/api-keys/introduction>
- Axiom tokens: <https://axiom.co/docs/reference/tokens> and
  <https://axiom.co/docs/restapi/endpoints/regenerateToken>
- healthchecks.io: <https://healthchecks.io/docs/api/>
- Netlify personal access tokens:
  <https://docs.netlify.com/api/get-started/>
- PayPal's two-secret rotation is from PayPal's announcement, not
  its current docs; confirm in Apps & Credentials before relying on
  it.
