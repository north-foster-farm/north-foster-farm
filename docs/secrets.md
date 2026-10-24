# Secrets

Every credential the site holds, where each copy lives, and how to
replace it. Names only: values belong in Netlify, the vendor's
dashboard, the password manager and the ignored `.env.*` files, never
here. `.env.sample` is the list of names the code reads; this is what
to do with them. The dashboard's secrets follow the same rules and
have their own page in its repository (`docs/secrets.md` there, not
yet written; it is after-launch work).

## The rules

1. **James creates every credential and sets every value. Agents never
   see one.** Nothing below changes that. A secret is never pasted
   into chat, an issue, a commit, a log or an agent's report; if one
   lands in such a place, treat it as leaked and rotate it. The env
   tools may be run by an agent only under the two guarantees in
   "Agents may run the env tools".
2. **The password manager's "NFF launch" folder is the master copy of
   every value.** It is the only copy that can be read back, since
   Netlify never returns a secret. "Every copy" below includes it.
3. **Production keeps its keys through launch** (James, 2026-10-16).
   The launch is fixed forward (`docs/rollback.md`): there is no
   rebuild of the old checkout and no hold on its credentials. New,
   separate keys go to staging, and development gets fakes. The old
   checkout's credentials (`RESEND_READ_KEY`, the old inbound
   `RESEND_WEBHOOK_SECRET` and its endpoint) are revoked once launch
   day's live checks pass.
4. **A change on Netlify needs a deploy.** Functions read their
   environment at deploy time. After `bin/nff env push`, trigger a
   production deploy (Deploys → Trigger deploy, or `bin/nff netlify
   api createSiteBuild`) and wait for it to publish before revoking
   the old value. What a key change means for a rollback is in
   `docs/rollback.md`.
5. **New first, old last.** Create the replacement, set it, deploy,
   prove it, then revoke the old one, on the schedule in rule 6. The
   Square access token is the exception (see Square), and it runs
   under maintenance mode.
6. **A routine rotation keeps the old credential for 31 days.** One
   rule for every key. The old credential stays valid for 31 days
   after the new one is live, or until its own Jan 31 expiry,
   whichever comes first, and is then revoked or destroyed. Both
   dates go in the rotation log (rule 11), and the December reminder
   also lists revocations still pending. Each vendor section points
   here and states only what differs. Within the overlap a deploy
   built before the rotation still works; the rollback floor that
   follows from it is `docs/rollback.md`'s to state.
   - **A leak is not routine: revoke at once,** with no overlap. The
     one exception is the age private key, which cannot be revoked:
     the old one is kept only to decrypt existing backups (Backups).
   - **Secrets we generate ourselves are swapped at once,** with no
     overlap and no code to accept two values: `STAGING_TOKEN`,
     `E2E_STAGING_TOKEN` and `MAINTENANCE_SECRET`. For a staging
     token, set the new value on Netlify's staging context, the
     GitHub secret, its env file and the password manager in one
     sitting. For `MAINTENANCE_SECRET` the only cost is that James's
     old phone link stops working; the new link goes in the password
     manager. They are low in sensitivity or easily re-entered, and an
     overlap would need code to accept two values.
   - **A vendor that cannot overlap** is named in its own section as
     the exception: Square's Replace (no documented grace period) and
     Resend's webhook secret (a 24-hour window of its own).
7. **Maintenance mode first** when a key that moves money (Square,
   PayPal) or the Netlify token may be in someone else's hands, and
   for any step that has no overlap, except where a section says
   otherwise (PayPal). `bin/nff --production maintenance on` and
   `off` (`docs/maintenance.md`).
8. **One value per context.** Set each value on its own context, never
   on "all", and never copy one context's value to another.
9. **Every copy.** A secret often lives in two or three places (the
   table says which). Update them all in one sitting.
10. **Set secrets as secret.** `bin/nff env push` does it; by hand,
    `bin/nff netlify env:set NAME value --context ctx --secret
    --json`. `--scope` silently fails; leave scopes at the default.
    Every Netlify command goes through `bin/nff netlify`, which
    carries the Keychain token (see Netlify).
11. **Write it down.** Every rotation gets a line in
    `docs/rotation-log.md`: name, date, environment, reason
    (`schedule`, `leak`, `lost device`, `access ended`) and who. When
    the old credential is revoked, a second line with reason
    `revoked` records that date, so a pending revocation is a
    rotation with no `revoked` line after it. Names and dates only,
    never a value. The log covers every secret: each name in the
    table below, and each secret name in `.env.sample`, has a seed
    entry in it. A `lint-and-test` check fails on any name without
    one, because the December reminder sees only logged secrets, and
    an unlogged one would silently never rotate.

## Schedule

- **Every secret rotates between Dec 1 and Jan 1**, once a year
  (James, 2026-10-18; replaces "January 1" and the six-month rule).
- **Every credential that can expire is set to expire on Jan 31** of
  the next year: a month to rotate, a month of buffer, so a missed
  rotation shows as an expired token rather than going unnoticed.
  That covers the Netlify personal access token and the Axiom tokens.
  The Square access token cannot expire (see Square) and still rotates
  in the window. Resend keys do not expire, so the staging gate's key
  and the others rotate by the calendar alone.
- **The 31-day overlap** (rule 6) puts the revocation of an old
  credential up to 31 days after its rotation, or at its Jan 31
  expiry if that comes first. A rotation made on Dec 20 is revoked
  Jan 20; one made on Jan 1 is revoked Jan 31.
- **Ping URLs, ids and the build hook** rotate only on a leak.
- **The reminder.** On Dec 1 the scheduled jobs email
  `DEV_NOTIFICATIONS_EMAIL` what is still due, read from the rotation
  log, then weekly, then one louder email in the last week of
  December (`netlify/functions/lib/rotation.mjs`; the job is in
  `docs/monitoring.md`). It also lists each `schedule` rotation since
  Dec 1 whose old credential is still waiting to be revoked (no
  `revoked` line for that name and environment on or after it), with
  the day to revoke it by, the 31st day or Jan 31 if sooner, and
  "overdue" once past. Secrets swapped at once (`STAGING_TOKEN`,
  `E2E_STAGING_TOKEN`, `MAINTENANCE_SECRET`) and the age key are never
  listed. The weekly reminders go on through January while anything is
  still due or pending, and stop when the log shows it all done. A
  secret missing from the log is invisible to it, which is why the log
  is seeded with every secret.
- **Quiet hours.** The Square token rotates under maintenance mode,
  in a quiet hour inside the window.
- **Vendor sources.** Re-check every source under "Vendor references"
  during each window and update its "Checked" date.

## Where they live

Netlify contexts: `production`, `branch-deploy` (staging),
`deploy-preview` and `dev`. Locally, bin/nff and the e2e suite read
`.env` (a link to `.env.development`), `.env.staging` (`--staging`)
and `.env.production` (`--production`), all ignored by `.gitignore`;
the e2e suite also reads `.env.e2e-staging`. GitHub holds repository
secrets for the workflows. The password manager holds the master copy
of every row.

| Name | Kind | Set on | Also kept in | Issued by |
| --- | --- | --- | --- | --- |
| `SQUARE_ACCESS_TOKEN` | secret | production; staging | env file | Square |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | secret | production; staging | env file | Square |
| `SQUARE_WEBHOOK_SIGNATURE_KEY_PREVIOUS` | secret, optional | production, during a swap only | env file | Square |
| `PAYPAL_CLIENT_SECRET` | secret | production; staging | env file | PayPal |
| `PAYPAL_WEBHOOK_ID` | id | production; staging | env file | PayPal |
| `RESEND_API_KEY` | secret | production only | env file | Resend |
| `RESEND_AUDIENCE_KEY` | secret | production only | env file | Resend |
| `RESEND_WEBHOOK_SECRET` | secret | production only | env file | Resend |
| `RESEND_READ_KEY` | secret, old | production, until launch day's live checks pass | none | Resend |
| `AXIOM_TOKEN` | secret | production; staging | env file | Axiom |
| `HEALTHCHECKS_JOBS_URL`, `_ALERT_URL`, `_BACKUP_URL`, `_PACKING_URL` | ping URLs | each environment (backup and packing: production only) | env file | healthchecks.io |
| `PROD_AUDIT_PING_URL` | ping URL | GitHub Actions secret, in each repository | password manager | healthchecks.io |
| The ntfy topic | secret name | Healthchecks' channel and James's phone | password manager | us |
| `BACKUP_R2_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` | secret | production only | env file | Cloudflare |
| The age private key | secret | James's Mac only; never Netlify | offline copy | us |
| `STAGING_TOKEN` | secret | staging; GitHub secret | `.env.staging` | us |
| `GATE_RESEND_KEY` | secret | staging | `.env.staging` | Resend |
| `E2E_STAGING_TOKEN` | secret | staging; GitHub secret | `.env.e2e-staging` | us |
| `MAINTENANCE_SECRET` | secret | each environment | env file | us |
| `FARM_NOTIFICATIONS_EMAIL` | address (sales@northfosterfarm.com), configuration | each environment | env file | us |
| `DEV_NOTIFICATIONS_EMAIL` | address (dev@northfosterfarm.com), configuration | each environment | env file | us |
| `ESCALATED_NOTIFICATIONS_EMAIL` | address (office@northfosterfarm.com), configuration | each environment | env file | us |
| `NETLIFY_AUTH_TOKEN` | secret | macOS Keychain only | password manager | Netlify |
| `PICKUP_SCHEDULE_HOOK` | build hook URL | env file | password manager | Netlify |
| `PAYPAL_*_EMAIL`, `_PASSWORD` | sandbox logins | `.env.staging` only | password manager | PayPal |

*Set on* names the Netlify contexts that hold the value, each with
its own. Previews and `dev` hold none of them (see the next section).
*Env file* is the environment's own `.env.production` or `.env.staging`.

Temporary, until #251 is done: staging, previews and `dev` still
share one set of Square, PayPal and Axiom values. Delete this note with
#251.

`SQUARE_APPLICATION_ID`, `SQUARE_LOCATION_ID` and `PAYPAL_CLIENT_ID`
are public: the order page receives them. The sandbox PayPal logins
sit in `.env.staging` only and are not in `.env.sample`.

The three notification addresses are configuration, each required in
production and each with its own value in staging, never
production's:

- `FARM_NOTIFICATIONS_EMAIL` (sales@northfosterfarm.com): the farm's
  notice of each new order, the contact form's messages (reply-to the
  writer), the 8:00 morning report and the 18:00 tomorrow email. No
  alert goes there.
- `DEV_NOTIFICATIONS_EMAIL` (dev@northfosterfarm.com): every alert of
  every kind, with no fallback, plus the maintenance flip notices,
  the session-end notice, the rotation reminder and the maintenance
  bypass's admin address. Jim no longer hears the flips. Unset, the
  production build and `bin/nff env check` fail.
- `ESCALATED_NOTIFICATIONS_EMAIL` (office@northfosterfarm.com): one
  message only, the "orders not recorded" escalation below. Jim gets
  nothing else from the system.

All three are required in production and staging. The staging and
development samples hold their own values: staging's are blank in the
sample and filled in `.env.staging`; development uses example.com
addresses.

`ADMIN_EMAILS` is gone. The build and `bin/nff env check` both fail
if the name is present in any sample, env file or Netlify context
(production and staging builds read their own sample; `env check`
also reads the local file and Netlify). For a stray `ADMIN_EMAILS` on
Netlify, `env check` prints the unset command; it never deletes.

The rest of `.env.sample` is configuration, not secret:
`ACCOUNTS_ENABLED`, `ADMIN_URL`, `AXIOM_DATASET`, `CONTACT_URL`,
`GATE_MAIL_FROM` and `GATE_TOOLBAR_EMAIL` (staging only; see
Staging), `MAIL_*`, `NETLIFY_SITE_ID`, `PAYPAL_ENV`,
`PICKUP_SCHEDULE`, `RESEND_AUDIENCE_ID`, `RESEND_SENDING_KEY_NAME`
(the sending key's name in Resend, which the send breaker uses to find
it), `SITE_CONTEXT`, `SITE_URL`, `SQUARE_ENV`, `SQUARE_VERSION`,
`SQUARE_WEBHOOK_URL`, `VENMO_HIDDEN`, and Netlify's own `HUGO_*` and
`NODE_VERSION`.

**Launch blocker: previews and `dev` hold no production value.** Every
value on `deploy-preview` and `dev` is removed except `SITE_CONTEXT`
and `PICKUP_SCHEDULE`; `bin/nff env check` proves it (launch guide
step `env-contexts`).

**Customer sessions are hashed at rest** (launch blocker, #269).
There is no session or signing secret. Sign-in links, sessions and
unsubscribe links are random 32-byte tokens in the `auth` Blobs store
(`lib/auth.mjs`, `lib/news.mjs`), stored under a hash of the token
(`session/<sha256(id)>`), so reading Blobs gives no live id. Nothing
to rotate. Sessions that were stored under a raw id before the change
are ended at the release (`bin/nff jobs run --production`, or the
daily sweep); everyone signed in at that moment signs in again once.

## One set per environment (#251)

Production keeps the value it has, staging gets new credentials of
its own, previews get none, and development gets a fake in `.env`.

- **Square:** a Developer Console app per environment, each with its
  own token and webhook key. Development uses a second Square
  developer login with its own test account, so it shares no sandbox
  data with staging.
- **PayPal:** a sandbox app per environment, each with its own
  business account, credentials and webhooks. Staging's business
  account needs Venmo on and `buyer-country=US`.
- **Resend:** production only (decided 2026-10-17), with one
  exception. Staging sends no email: its `MAIL_DRIVER` is the outbox,
  James reads the mail in its email library, and it holds no audience
  or webhook. The exception, approved 2026-10-18, is the access
  gate's sign-in link (Staging): it goes through a staging-only
  sending key, `GATE_RESEND_KEY`, never production's. Development and
  previews send none. The code enforces it:
  `netlify/functions/lib/resend-guard.mjs` refuses any call to
  Resend's API outside production, whatever the variables say, except
  the gate's own send, and `test/resend-guard.test.mjs` fails if a
  module that calls Resend skips the check. Delete the farm team's
  Resend webhook that points at staging.
- **Axiom:** a dataset and an ingest token each for production and
  staging.
- **Healthchecks:** separate checks per environment. Staging's jobs
  check needs a period of about 6 hours, since its jobs run every 2
  to 6 hours (#164).
- **Backup export (Cloudflare R2):** production only. The token is
  bucket-scoped *Object Read & Write* (James approved it 2026-10-17,
  D-EXPORT): R2 offers no write-only token, so a bucket lock rule
  stops deletes and overwrites, and the age encryption makes a read
  worthless. Copies are kept 30 days (D-189): the lock rule protects
  each object for 30 days and a lifecycle rule deletes older ones.
  The setup is in `docs/backup.md`.
- **`STAGING_TOKEN` and the gate's variables (`GATE_RESEND_KEY`,
  `GATE_MAIL_FROM`, `GATE_TOOLBAR_EMAIL`):** staging only; production
  holds none of these names, not even empty, and the build fails if
  it does (b60a03b). `STAGING_REVIEWER_TOKEN` is retired and must not
  exist anywhere. If a name exists in the production context, unset
  it (`bin/nff netlify env:unset NAME --context production`).
- **`E2E_STAGING_TOKEN`:** staging only; the end-to-end suite's own
  token (`docs/staging.md`). The suite holds it and no Netlify token
  (#266). Until it is set on the staging context and saved in
  `.env.e2e-staging`, the back-office e2e specs cannot run.
- **Previews** (after #255): `SITE_CONTEXT=deploy-preview` and
  `PICKUP_SCHEDULE`, `MAIL_DRIVER` unset so mail is logged, and
  nothing else. A preview then shows no pay buttons, only a plain
  "payments are switched off in previews" message (wording is a
  draft for James), and its order API answers 403 with it
  (`paymentsOff` in `lib/payments.mjs`), but pages, the news sign-up,
  contact and health work. Fork pull requests need approval before
  they build (the site's untrusted-deploy setting is `review`). Previews
  sit behind the same access gate as staging, with a separate
  allowlist (`docs/staging.md`).

The order: make the new credentials, push them with `bin/nff env
push`, confirm with `bin/nff env check` and `env verify`, then revoke
the old shared ones. The old non-production values go once staging's
replacements are live. Production's values stay. A staging or
production build fails `check:env` until that context has had its
`env push`, so the first push comes before the first build.

## Pushing and checking env

The launch guide generates `.env.production.sample`,
`.env.staging.sample` and `.env.development.sample`; James approves
them in review, and saving the filled-in files stays a step on his
laptop. Each sample lists only the keys its environment uses. A key
left empty in the staging or production sample is a secret, except a
key marked `# Public:`. The development sample has a working fake for
every key, so `cp .env.development.sample .env` runs the tests and
the dev server.

- **`bin/nff env push --production|--staging`** sets every key in the
  filled-in `.env.production` or `.env.staging` on that context, one
  Netlify call per key (`env:import` cannot target a context), with
  the secret flag for each secret. It reads the other values back.
  Netlify never returns a secret, so secrets are checked by name
  only. Nothing it sets is live until a deploy, so it then asks
  `Deploy <context> now? [Y/n]` and posts the context's build hook
  (`PICKUP_SCHEDULE_HOOK` in its env file), or does so without asking
  on `--allow-deploy`. With no terminal, no hook or an answer of no,
  it ends on a "NOT LIVE YET" line. The Netlify calls in `env push`
  have not run live: the first staging push proves them.
- **`bin/nff env check --production|--staging`** compares the key
  names in the sample, the local file and the Netlify context, and
  fails on any difference. It also fails on any value attached to
  several contexts or to "all", which is how sharing happens on
  Netlify, and proves that no production value reaches a preview:
  `deploy-preview` and `dev` may hold `SITE_CONTEXT` and
  `PICKUP_SCHEDULE` and nothing else. It prints the unset commands
  that clear a leak, by name, never a value.
- **`bin/nff env verify --production|--staging`** is the only proof
  that a value is right. Run it after `env push` and the deploy. It
  makes one harmless, read-only call per service: Square (the
  location), PayPal (a login, then the webhook), Resend (production
  only: the domains, and the audience's contacts), Axiom (an ingest
  of nothing) and R2 (a one-object listing). Healthchecks URLs are
  checked for shape only, since any ping is recorded as a success. It
  reports by name, `ok` or `FAILED`, never a value, and lists the keys
  no call can check (signing secrets, tokens the site itself issues).
  It is the proof after a rotation; a real payment is optional.
- **`npm run check:env`** runs in the Netlify build, beside
  `check:schedule`, and fails the build when a key the sample lists
  for that context is missing, or a context holds a name it should
  not.

### Agents may run the env tools

An agent may run `env push`, `env check` and `env verify`, under two
guarantees:

1. **No value in any output, error paths included.** Values reach
   Netlify in the body of an API request made inside the tool
   (`envRunner` in `bin/env/netlify.mjs`), never on a command line,
   where `ps` and shell history would show them. Every error is
   scrubbed of every value in the env file and of the access token
   before it is printed, and quotes none of Netlify's reply, which can
   echo a value. `test/env-runner.test.mjs` proves it.
2. **Agents never open or print the `.env.*` files.** Only the tools
   read them. An agent that needs to know what a file holds runs
   `env check` or `env verify`, which answer by name. (The samples,
   `.env.*.sample`, hold no values and are open to read.)

James still creates every credential. These rules are about who may
run the tools, not who makes or sees values.

## Accounts

Every account that can reach a secret has two-factor sign-in, and its
recovery codes are in the password manager: Netlify, GitHub, Square,
PayPal, Resend, Cloudflare, Axiom, Healthchecks, UptimeRobot and
Fastmail. Any second factor will do; an authenticator app or a
security key beats a text message. A launch guide step has James
confirm each one.

## Square

**`SQUARE_ACCESS_TOKEN`.** The application's personal access token,
one for sandbox and one for production. It carries every permission
on the farm's Square account: Square calls it a "full-access
(unscoped) access token" that "provides unrestricted Square API
access to resources in a Square account" (Access tokens, below). A
leak lets someone read every customer and order and refund any
payment, whatever scopes `order-form.md` lists.

*It cannot expire.* James's reading is that a personal access token
has no expiry, so the Jan 31 rule does not apply to it. Square's
access-token page does not say so outright; a third-party secret
scanner's page does. To close it, James looks at the token in
Developer Console → Credentials: it shows no expiry date. It still
rotates in the Dec 1 to Jan 1 window.

*Replace has no documented grace period, so assume none.* Square's
documentation does not say what happens to the old token when
Replace issues a new one, and no source found settles it (searched
2026-10-18). Treat the old token as dead the moment Replace is
clicked. This is the exception to the 31-day overlap (rule 6), so the
rotation runs under maintenance mode. **Open, post-launch QA, to
check before Dec 1:** James replaces the sandbox token (no customer
is affected) and, with the old value kept for a minute, makes one
read-only call with it (for example `bin/nff --staging health`
before updating the env file, or a `GET /v2/locations`). If it still
answers, record the minutes it stays valid here, with the date, and
the steps may use it.

Checkout fails from the Replace until the new deploy is live, card
and Venmo alike, since a Venmo payment is recorded on the Square
order. Maintenance mode covers it, and its admin bypass lets a real
test order prove the new token before it goes off.

1. Switch maintenance mode on: `bin/nff --production maintenance on`.
   Check `bin/nff --production orders list --open` for a payment
   under way (a payment already started finishes and is recorded).
2. Developer Console → the app → Credentials → Production → Replace
   (beside the access token). Copy the new token.
3. `bin/nff env push --production` after updating `.env.production`
   (or `bin/nff netlify env:set SQUARE_ACCESS_TOKEN <new> --context
   production --secret --json`), then deploy.
4. Update the password manager's copy.
5. When the deploy is live, `bin/nff env verify --production`, then
   place a small real order as a signed-in admin (the bypass lets it
   through) and refund it.
6. Switch maintenance mode off: `bin/nff --production maintenance
   off`. Add the line to `docs/rotation-log.md`.

The sandbox token is the same steps under Sandbox, for the staging
context and `.env.staging`, without maintenance mode.

**`SQUARE_WEBHOOK_SIGNATURE_KEY`.** The subscription's HMAC key.
Leaked, it lets someone forge refund events onto orders. The swap has
no gap because `square-webhook.mjs` accepts either of two keys, the
current one and an optional `SQUARE_WEBHOOK_SIGNATURE_KEY_PREVIOUS`
(James's decision, 2026-10-18; landed in 91599b4, with tests).

1. In the Developer Console (Webhooks → the subscription), or with
   `UpdateWebhookSubscriptionSignatureKey`, make the new key.
2. Set the old value as `SQUARE_WEBHOOK_SIGNATURE_KEY_PREVIOUS` and
   the new one as `SQUARE_WEBHOOK_SIGNATURE_KEY`; deploy.
3. Check a delivery verifies.
4. **Remove `SQUARE_WEBHOOK_SIGNATURE_KEY_PREVIOUS`** and deploy, 31
   days later (rule 6). The swap is safe only if the old key is gone
   afterward; on a leak, skip step 2 and remove the old key at once.

Signature failures page James (see "Alerts", below).

`SQUARE_APPLICATION_ID` and `SQUARE_LOCATION_ID` are public; the page
receives both. Changing either, or `SQUARE_ENV`, on a live site runs
under maintenance mode (`docs/order-form.md`).

**After launch:** evaluate a scoped login (OAuth with the minimum
permissions) instead of the all-powerful personal access token, to
limit what a leak could do.

## PayPal

**`PAYPAL_CLIENT_SECRET`.** The REST app's secret, live and sandbox.
Leaked with the public client id, it moves money out of the farm's
PayPal Business account through the API (refunds, payouts if
enabled). The swap has an overlap because an app can hold two
secrets, each enabled or disabled, a disabled one re-enabled until
deleted (PayPal's engineering post on credential rotation, below).
That post is old and PayPal's current docs do not describe the
feature, so **open, post-launch QA, to check before Dec 1:** James
confirms in Apps & Credentials → Live → the app that the page offers
a second secret and a disable control, and records the result here.
No maintenance mode is needed for a routine swap, since both secrets
work at once.

1. Add a second secret to the app.
2. `bin/nff env push --production` with the new one in
   `.env.production`; deploy. The deploy also drops the site's cached
   bearer token (`lib/paypal.mjs:98`), which a warm function otherwise
   keeps for its lifetime.
3. `bin/nff env verify --production` (one read-only PayPal call).
4. Thirty-one days later (rule 6), disable the old secret, then, a
   day later, delete it.

**On a leak:**

1. Disable the old secret in PayPal at once.
2. Watch PayPal's account activity for refunds, payouts and captures
   the farm did not make, for the access token's lifetime. A stolen
   secret may already have minted bearer tokens, which work against
   PayPal's API directly, and PayPal's documents say a token is valid
   for the seconds its response states (`expires_in`; the REST
   guide's sample shows 31668, about 8.8 hours). Look in Activity on
   the Business account and in the REST app's dashboard. No current
   REST document describes a call that ends an existing token
   (searched 2026-10-18); **open,** James asks PayPal or tests it
   with a sandbox app (mint a token, disable the secret, call the
   API with the token) and records the answer here.
3. Switch maintenance mode on only until the new secret is deployed
   and verified, a matter of minutes. Closing the shop for the
   token's lifetime would protect nothing, since the stolen token is
   used against PayPal directly, and it would turn away card orders
   all day. A switch that stops only the PayPal and Venmo path, so
   that Card keeps taking orders, does not exist yet; it is an
   after-launch item.

**`PAYPAL_WEBHOOK_ID`.** Not a secret: the subscription's id, which
`verify-webhook-signature` needs (`lib/paypal.mjs:338`). It changes
only if the webhook is deleted and recreated; then set the new id and
deploy, or every PayPal webhook fails verification.

**`PAYPAL_CLIENT_ID`** is public.

Changing `PAYPAL_ENV` or `PAYPAL_CLIENT_ID` on a live site runs under
maintenance mode (`docs/order-form.md`).

## Resend

API keys cannot be rotated in place: create a new key with the same
permission and domain, swap it in, delete the old one. Keys can be
created and deleted by API, but permission and domain only in the
dashboard. A key's permission is `full_access` ("can create, delete,
get, and update any resource") or `sending_access` ("can only send
emails"); only a sending key can be limited to one domain (Resend's
create-key reference, below).

- **`RESEND_API_KEY`**: sending access for the domain. Leaked, it
  sends mail as the farm, and the harm is two: the domain's
  reputation, with spam placed in inboxes, and an outage. Pro has a
  monthly send limit even without a daily one, so a spammer can use it
  up and stop order confirmations and alerts. The "no daily quota"
  reading is James's and unchecked: verify it on Resend's pricing page
  at the Pro upgrade and record it under Vendor references. The send
  breaker (below) is the leak detection. Create, set on Netlify
  (production only), deploy, and delete the old after 31 days (rule
  6). No downtime.
- **`RESEND_AUDIENCE_KEY`**: the key the newsletter sync uses
  (`lib/news.mjs:380`). It needs `full_access`: only that permission
  can create, update and delete contacts, so it cannot be a sending
  key. **A known, accepted risk:** a leak exposes every contact in
  the audience and lets someone edit or delete them. **Open:** James
  confirms the key shows "Full access" in Resend → API Keys (the
  dashboard is the source; the documents do not list contacts by
  name). The breaker depends on it, since it deletes the sending key
  with this one, so the check gates the breaker's rehearsal. Same
  swap steps as the sending key.
- **`RESEND_READ_KEY`**: read by no code in the release; only the old
  invoice checkout's `venmo-inbound` read received email with it.
  Delete it from Netlify and Resend once launch day's live checks
  pass.
- **`RESEND_WEBHOOK_SECRET`**: the endpoint's `whsec_` secret. Rotate
  in the dashboard or with `POST /webhooks/{id}/signing-secret/rotate`.
  For 24 hours Resend signs with both secrets, and
  `resend-webhook.mjs:49` accepts any matching `v1` signature, so set
  the new one and deploy within the day. This is the exception to the
  31-day overlap (rule 6): the vendor's window is 24 hours. No
  downtime. On launch day
  #237 replaces the old Venmo inbound endpoint's value with the
  `/api/resend/webhook` endpoint's; the old one is revoked after the
  live checks pass, with the old endpoint.
- **There is no lookup key.** `RESEND_LOOKUP_KEY` and `bin/nff
  --production mail` are gone (da7cffa). James deletes the key in
  Resend and its line in `.env.production`; to see what was sent, use
  Resend's dashboard.

- **`GATE_RESEND_KEY`**: the staging access gate's own sending key
  (Staging), made for staging alone and never production's. It sends
  the sign-in link and nothing else, to allowlisted addresses. It is
  vendor-issued, so a routine rotation keeps the old key 31 days
  (rule 6), and Resend keys do not expire, so only the calendar
  rotates it, Dec 1 to Jan 1. It has a row in the table and the
  rotation log, and a place in the incident order. The send breaker
  covers it with a ceiling of its own.
- **Cadence:** on the schedule. After a leak, check new or deleted
  keys and new or deleted webhooks, and read what the breaker
  recorded.

### The send breaker

Nobody watches a sent log; the code does
(`netlify/functions/lib/breaker.mjs`, thresholds in
`data/breaker.json`), and shuts sending down before damage, even when
the cause is harmless. It is the leak detection for both sending keys.

What it needs from Resend, once:

1. Webhooks → the `/api/resend/webhook` endpoint: tick `email.sent`,
   `email.bounced` and `email.complained`, beside the contact events
   already there.
2. API Keys → `RESEND_AUDIENCE_KEY` shows "Full access".
3. `RESEND_SENDING_KEY_NAME` is set to the sending key's name in
   Resend, since the key list cannot say which key is which.

What trips it:

| Trip | When | Why this number |
| --- | --- | --- |
| Foreign send | any `email.sent` whose message id our send path did not record | the key is in use outside our code |
| Volume, hour | more than 25 sends in a UTC hour | normal is a handful an hour |
| Volume, day | more than 100 sends in a UTC day | normal is a few dozen |
| Bounces | 3 or more and 10% or more of the last two hours' sends, over at least 10 sends | Resend asks senders to stay under 4% |
| Complaints | 2 in the last two hours | a handful of sends a day makes any complaint a lot |

The gate's mail has its own ceiling, 6 an hour and 20 a day
(`data/gate.json`). A planned bulk send is declared first: `bin/nff
breaker declare --count 90 --hours 3 --note "launch invitations"`
raises both ceilings for those hours and no longer. A send bigger than
declared still trips.

When it trips, the stop flag is written to the jobs store, so every
function instance stops sending at once. Orders keep being taken and
their emails are held, not lost. The sending key is deleted through
Resend's API with the audience key. The phone is alerted through
Healthchecks (a down push, then an up push), a channel that does not
use Resend, and the incident is kept.

After a trip:

1. `bin/nff breaker status --production`: what tripped it, and whether
   the key was deleted and the phone alerted.
2. Find the cause. A foreign send means the key leaked: also rotate
   the audience key. Resend's dashboard shows what was sent.
3. Make a new sending key, set `RESEND_API_KEY`, deploy.
4. `bin/nff breaker reset --yes --production`. It writes the incident
   to `incidents/`; add the cause to it.
5. `bin/nff breaker flush --production --dry-run`, then without
   `--dry-run`, sends the held mail. Sign-in links and anything over
   72 hours old are not sent.

It never resets itself. Mail sent from Resend's dashboard or any tool
other than this code trips the foreign-send check, and a launch
invitation to the old list can bounce past 10%; both trip by design.
If the webhook is not subscribed to `email.sent`, foreign sends go
unseen: `bin/nff breaker status` warns when sends over 15 minutes old
never came back.

## Axiom

**`AXIOM_TOKEN`**: one per environment, ingest into that environment's
dataset. Axiom's basic API tokens "let you ingest data to Axiom" into
the datasets chosen; their privileges cannot be changed after
creation (Axiom's token reference, below). The documents do not use
the words "ingest-only", so **open:** James opens each token in
Axiom → Settings → API tokens and confirms it shows ingest on one
dataset and nothing else; this page then drops the hedge. A leaked
ingest token lets someone write junk into the logs and nothing more.

Rotate with Settings → API tokens → the token → Regenerate, or
`POST /v2/tokens/{id}/regenerate` with `existingTokenExpiresAt` set 31
days out, or at Jan 31 if that is sooner (rule 6), which keeps the
old token alive after the deploy lands. Set, deploy, `env verify`.
Logs are lost only for a failed swap.

*Expiry.* A token created without `expiresAt` never expires (Axiom's
create-token reference), so set every token to expire Jan 31 of the
next year when it is made.

*What the logs hold.* Every log record is scrubbed before it leaves
the site (26b0501): contact fields are removed, emails become
`[email:hash]` and phones `[phone]`, and `test/log-privacy.test.mjs`
fails if one is logged. Records carry order ids, not customers.
Retention is 30 days on the free plan per `docs/monitoring.md`, not
confirmed against Axiom's documents: **open,** James checks the
dataset's retention setting in Axiom. The privacy page needs a line
that logs never hold contact details; it is a review item for James
with before and after text, and nobody edits `content/privacy.md`
before he approves.

## healthchecks.io

**`HEALTHCHECKS_JOBS_URL`, `_ALERT_URL`, `_BACKUP_URL`** and
**`PROD_AUDIT_PING_URL`** (a GitHub Actions secret, one check per
repository, for the daily production audit): ping URLs
with the check's UUID in them, which is immutable. Leaked, someone can
ping a check well and hide an outage, or post `/fail` and page James.
To replace one, create a new check with the same period, grace and
channels (dashboard, or `POST /api/v3/checks/` with a read-write API
key), set its URL, deploy, delete the old check. Cadence: on a leak
only. The project's API keys (Settings → API Access) are separate;
none is stored here.

**The ntfy topic.** Production's three checks push to a phone through
an ntfy topic. Anyone who knows the topic's name can read the alerts
and send fake ones. To replace it on a leak: make a new random topic
name (at least 20 random characters), subscribe the phone to it,
update Healthchecks' ntfy channel to it, send a test alert, then
unsubscribe from the old topic. The name is kept in the password
manager and nowhere else.

## Alerts on failed webhook signatures

When PayPal, Square or Resend notifications start failing verification
(a wrong `PAYPAL_WEBHOOK_ID`, a recreated webhook, a rotated secret
not yet deployed), the failure pages James through the alerts check
and does not only log (30c08b1, 3e48b67; `docs/monitoring.md`).

## Backups

**`BACKUP_R2_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`.** The nightly
export's bucket-scoped token (see "One set per environment"). Rotate
in Cloudflare → R2 → Manage API tokens: create the new token, push,
deploy, `env verify`, and delete the old after 31 days (rule 6). A
leaked token can read and write backups but not delete or overwrite
them (bucket lock), and a read yields only age-encrypted files.

**The age private key** decrypts every backup. It lives on James's
Mac, never on Netlify, with a second copy offline; lose both and every
backup is unreadable (`docs/backup.md`). Only the public key
(`BACKUP_AGE_RECIPIENT`) is on the site. To replace it, on the
schedule or on a leak, make a new key pair, change
`BACKUP_AGE_RECIPIENT`, and re-encrypt nothing. A private key cannot
be revoked, so rule 6 reads differently here: **keep the old private
key, both copies, for 31 days after the change,** so the 30-day
backup window stays readable (a December rotation would otherwise
leave the most recent backups unreadable), then destroy both. After a
leak the old key is kept for the same purpose only, to decrypt the
existing backups, and nothing else uses it. A leaked private key does
not expose past backups to anyone without the files, but with the
bucket token it opens them.

*Restore testing.* Today `docs/backup.md` has a one-off manual
rehearsal. After launch, restoring is tested on a schedule and every
restoration path is proven automatically (a post-launch QA item in the
launch guide): monthly, and once in each rotation window, a run
fetches a recent backup, decrypts it, restores into scratch stores,
compares counts and clears them. The paths are the online private key,
the offline copy, production and staging backups, and `restore-db.mjs`
for the dashboard's Supabase if it is in scope. The offline copy needs
a design that lets a test use it without bringing it online, or a short
manual step with the rest automated. A failure alerts James through
healthchecks.io, and each run appends to the rehearsal record.

## Staging

Staging, every branch deploy and every deploy preview sit behind an
access gate (`docs/staging.md`). It runs at Netlify's edge and is never
active in production: its build does not install it, and a test fails
if it could run there. A visitor signs in by an emailed link, from an
allowlist of exact addresses and whole domains, and a session lasts a
year. Every non-production response carries `X-Robots-Tag: noindex`.

Production holds none of the staging names below, not even an empty
one, and answers 404 to the staging API anyway. The production build
and `bin/nff env check` fail if one appears in production's
environment, the production sample or `.env.production`.

**The gate's variables,** set on the staging context with `bin/nff env
push --staging`. The staging build fails until all three are set:

- `GATE_RESEND_KEY`: a Resend sending key made for staging alone,
  never production's (Resend). It sends the sign-in link and nothing
  else, and the code refuses any recipient not on the allowlist. A
  leak lets someone send mail as the gate to the allowlist only; the
  breaker's low ceiling bounds it.
- `GATE_MAIL_FROM`: the sender of the link, on a domain verified in
  that Resend account. Configuration.
- `GATE_TOOLBAR_EMAIL`: James's address, whose session opens the
  toolbar's owner areas (every session's mail, Approve and Rewrite).
  Configuration, never a literal in code.

**The allowlist and sessions** live in the staging stores and are run
from the CLI (previews keep a separate list, `--preview`):

```
bin/nff --staging gate allow add|remove|list <email|@domain>
bin/nff --staging gate sessions end <email>
bin/nff --staging gate sessions end-all
```

Removing an address from the allowlist ends its sessions. Ending every
session is part of the incident rotation (Incident response). James
seeds the allowlist before staging first gets the gate, with his own
address, Jim's and any others he names; since #294 every one of them
gets the toolbar, scoped to their own session (below).

**Staging sends no email,** with exactly one exception: the gate's
sign-in links. One plain-text template, no other mail path, the
staging-only key, a recipient check against the allowlist and the
send breaker's own ceiling. Everything else stays on the outbox.

**Machine access** passes the gate by credential or signature, never
by being public. Each exemption below is a row of `EXEMPTIONS` in
`netlify/functions/lib/gate-edge.mjs`, and `test/gate.test.mjs` proves
each stays closed without its credential:

| Way past the gate | Credential |
| --- | --- |
| Square and PayPal sandbox webhooks | their own signature checks (`SQUARE_WEBHOOK_SIGNATURE_KEY`, `PAYPAL_WEBHOOK_ID`) |
| `/api/staging/jobs/run` and `/api/health` | `STAGING_TOKEN`, as a header |
| The end-to-end suite | `E2E_STAGING_TOKEN`, as a header or the `nff_gate_machine` cookie |
| `/api/gate/*` | none: it is the sign-in itself |
| `/version.json` (exact path) | none: the build's commit and version, both public in the repository |

**`STAGING_TOKEN`** is for machines only: the Staging jobs workflow
and health checks. It is never typed into a browser, and there is no
"Staging token" prompt. It opens the jobs run, the info and the crash
proof, and nothing that reads mail. Leaked, someone can run staging's
jobs. A swap is at once, with no overlap (rule 6): the new random
value goes on Netlify's staging context, the GitHub secret (`gh secret
set STAGING_TOKEN`), `.env.staging` and the password manager in one
sitting, and staging is redeployed. Until the GitHub secret matches,
the Staging jobs workflow fails. It expires Jan 31 and is rotated on
the schedule, and when someone with access leaves. `E2E_STAGING_TOKEN`
is swapped the same way, with `.env.e2e-staging` for its env file.

`STAGING_REVIEWER_TOKEN` is retired; the name must not exist. If it
does anywhere, unset it (`bin/nff netlify env:unset
STAGING_REVIEWER_TOKEN --context branch:staging`).

**The repository is public, and stays so (`docs/security.md`), so its
Actions logs and artifacts are public.** This is a standing rule. Every
workflow prints counts and outcomes only: never sign-in links, outbox
contents, customer emails, names, order details or a scan's findings,
and uploads no report. The Staging jobs
runs that printed order ids are deleted by James (a launch guide step
lists them); the workflow on `main` still prints full reports until
the release lands there, and James confirms it stopped once it has. A
test fails on a workflow that prints such output.

### What opens the toolbar

The toolbar's back end, `/api/staging/*`, opens for any gate session
(#294); the browser's cookie is the credential and nothing is typed.
A session reads only the mail its own requests wrote, and a sign-in
link in it only when it went to the session's own address. James's
session, the one whose address is `GATE_TOOLBAR_EMAIL`, opens more.
Without a gate session nothing here answers (401), and the edge stops
the request before it arrives.

| Area | Gate session | James's session | `STAGING_TOKEN` |
| --- | --- | --- | --- |
| Inbox: this session's emails, a sign-in link for another address withheld; clear them | yes | yes | no |
| Sent: every email staging wrote, from every session and none, with real sign-in links and customers' addresses; clear it | no | yes | no |
| Email library: every email built from sample data (fake sign-in links) | yes | yes | no |
| Review: approve and rewrite the library's emails | no | yes | no |
| Clock: this browser's date and time for the site (branch-deploy and dev only) | yes | yes | no |
| Jobs run: the scheduled jobs now, as of a time, or at 6:00, 8:00 or 18:00 on the clock's day, and send today's reports again | yes | yes | yes |
| Signature library: copy-ready email signatures | yes | yes | no |
| Info: the deploy's context, mail driver, Square environment and clock, and the key in use | yes | yes | yes |
| Crash test: throws on purpose to prove the alert | no | yes | yes |

`E2E_STAGING_TOKEN` opens `/api/staging/e2e` and lifts the order and
contact limits for a request carrying it, and nothing else. The
browser reset acts on the browser alone and needs no key. Each new
toolbar feature adds a row here and decides in `KEYS`
(`netlify/functions/staging.mjs`) which way in opens it; the default
for a token is nothing.

## Netlify

**`NETLIFY_AUTH_TOKEN`**: a personal access token for bin/nff to
reach Blobs. It carries every permission its owner has on Netlify:
every site, every env var, DNS, deploys, and every order and customer
in Blobs. The worst leak here, so it lives once, in the macOS
Keychain, and in no `.env.*` file or sample (`bin/nff env check`
fails if one sets the name). bin/nff reads it from there when given
`--staging`, `--production`, `--preview` or `--scratch`; bare
development runs on fakes and never looks. If the item is missing
bin/nff says so and stops. It stays only because agents' `bin/nff`
commands need Blobs (orders, refunds, health, exports).

Store it once, or replace it (the command asks for the value, so it
stays out of the shell's history):

```
security add-generic-password -a nff -s nff-netlify-auth-token -U -w
```

User settings → Applications → Personal access tokens → New access
token, **expiring Jan 31 of next year**. Run the command above with
the new value, run `bin/nff --production health`, then Revoke the old
one 31 days later, or at its Jan 31 expiry if sooner (rule 6). No
downtime; nothing on Netlify reads it. Rotate in the Dec 1 to Jan 1
window, and revoke at once on a leak. A Netlify password reset revokes
every PAT at once, so after one, mint a new token before the CLI is
needed.

**The `netlify` CLI login** is retired. Its token sat in plain text in
`~/Library/Preferences/netlify/config.json` with the same access as
the Keychain token. Run `netlify logout` once and never `netlify
login` again. `bin/nff` passes the Keychain token to the CLI through
the child process's environment, and `bin/nff netlify <args>` runs any
runbook command that way (`bin/nff netlify env:set ...`). A machine
that still has a login file is a finding: it joins the lost-laptop
checklist, to be revoked with the token. Run `netlify logout` there
first.

**After launch:** propose replacing bin/nff's Blobs calls with the
site's own admin API, behind an admin session or a scoped admin key,
so the personal access token can be deleted.

**`PICKUP_SCHEDULE_HOOK`**: a build hook URL. Leaked, anyone can start
production builds. Site configuration → Build hooks → delete and
recreate; update `.env.production` and the password manager.

**`MAINTENANCE_SECRET`** signs the phone links that flip maintenance
mode (`docs/maintenance.md`). Whoever holds a link can flip it.
`bin/nff maintenance rotate` kills every link handed out. It is
swapped at once, with no overlap (rule 6): set the new value in every
copy in one sitting. The only cost is that James's old phone link
stops working; the new link goes in the password manager.

## Sessions

There is no secret to rotate. The staging gate's sessions are a
separate store: `bin/nff --staging gate sessions end-all` ends them
(Staging). To end every customer session, run
`bin/nff sessions end-all --production|--staging`. It deletes every
session, asks for confirmation (or takes `--yes`), and emails
`DEV_NOTIFICATIONS_EMAIL` when it runs; each customer signs in again
by magic link. Run it with maintenance mode on, so accounts are
closed while it happens, and off after. (The command landed in
07eafda; it later becomes a button in the admin dashboard.)
`customers rename` ends one customer's.

## Incident response

**Rotate at once** on a suspected leak, a lost laptop, or someone with
access leaving. Do this before anything else; the schedule is not a
substitute. Each section above says what counts as access for that
secret.

1. **Maintenance mode first** when Square or the Netlify token may be
   in someone else's hands: `bin/nff --production maintenance on`.
   Keep it on until the new keys are live and checked, then off. If
   bin/nff itself cannot run (the laptop is the thing lost), use a
   signed phone link from another device, or `bin/nff netlify ...`
   from a clean machine. PayPal is handled differently, since
   closing the shop protects nothing against a stolen secret (see
   PayPal).
2. **Rotate, in this order, the blast radius. A leak means revoke at
   once, with no overlap** (rule 6):
   1. The Netlify personal access token (Netlify: revoke the token).
      Any leftover `netlify` CLI login is the same access: revoke
      its token too (`netlify logout` on a machine still holding
      one). Use `bin/nff netlify ...` from the clean machine.
   2. Square (access token, webhook key) and PayPal (secret).
   3. Resend (sending key, audience key, webhook secret) and the
      staging gate's `GATE_RESEND_KEY`.
   4. Axiom, Healthchecks and the ntfy topic, the R2 token, the age
      key (the old private key is kept only to decrypt existing
      backups), `STAGING_TOKEN` and `E2E_STAGING_TOKEN`,
      `MAINTENANCE_SECRET`, the build hook.
   5. If access to Blobs is suspected, end every customer session
      (Sessions, above), and the staging gate's
      (`bin/nff --staging gate sessions end-all`).
   6. Change passwords and reset two-factor for the accounts on the
      laptop or in the browser (Accounts, above), and sign out all
      sessions on each.
3. **Check what the leaked key did,** and record it in the incident
   record. The record lives in the gitignored `incidents/` folder at
   the repository root (`docs/rollback.md`, section 1), never on a
   public issue:
   - Square: refunds, payments, customer exports.
   - PayPal: refunds, payouts, new webhooks or apps.
   - Resend: what the breaker recorded (`bin/nff breaker status`),
     Resend's own log of what was sent, new or deleted keys and
     webhooks, bounces and complaints.
   - Netlify: the audit log, env changes, deploys, build hooks.
   - Axiom: token use. GitHub: secrets and workflow runs.
4. **Notifications go to three addresses, and no others.**
   `DEV_NOTIFICATIONS_EMAIL` (dev@northfosterfarm.com) takes every
   alert of every kind, with no fallback; the maintenance flip
   notices, the session-end notice, the rotation reminder and the
   maintenance bypass's admin address go there too, and only there.
   `FARM_NOTIFICATIONS_EMAIL` (sales@northfosterfarm.com) takes the
   farm's notice of each new order, the contact form's messages, the
   8:00 morning report and the 18:00 tomorrow email, but no alert.
   `ESCALATED_NOTIFICATIONS_EMAIL` (office@northfosterfarm.com) takes
   one message: "orders not recorded" (`orders.not_recorded`), in
   plain language, that James has not responded, to switch on
   maintenance mode, with the current epoch's signed ON link, built
   when the message is sent. It goes out after the alert has been
   unacknowledged for an hour and again every hour while the alert
   stays open; acknowledging it stops it
   (`docs/rollback.md`, section 3). Jim
   gets nothing else from the system. The alert-by-alert split is in
   `docs/monitoring.md`. Creating dev@ in Fastmail is a blocking
   launch gate, followed by a test message sent through the real
   notification path (`bin/nff mail test-dev`, the rotation reminder
   or the deploy-failed sender) and confirmed received: deploy-failed,
   alert and rotation emails all depend on it.
5. **Customer data.** If details may be exposed, write down what and
   whose in the incident record, and decide whether customers must be
   told. Rhode Island's breach rules may apply; that is a legal
   question for the time.
6. **Log every incident rotation** in `docs/rotation-log.md` with
   reason `leak`, `lost device` or `access ended`.

## Known gaps

None at launch. The three that stood open on 2026-10-16 are launch
blockers: one set per environment (#251, with #255 and #266), the
production `.env` as a link to `.env.development`, and hashed
sessions (#269). Anything still listed here at release time is
written as an accepted gap, with James's approval and a date.

## Out of scope

The dashboard's secrets (Supabase service key, VAPID) are its own,
under the same rules, with their own rotation log and a place in the
lost-laptop checklist; see its repository when its page exists.
`GITHUB_TOKEN` in the workflows is minted per run.

**UptimeRobot** holds no key the site uses. It does hold an account
login and a link to James's phone for alerts, so it is in Accounts
(two-factor) and in the lost-laptop checklist.

## Vendor references

Checked 2026-10-18; re-check every one in each Dec 1 to Jan 1
window and update this date.

- Square access tokens ("Provides unrestricted Square API access",
  full-access, unscoped; says nothing on expiry or Replace):
  <https://developer.squareup.com/docs/build-basics/access-tokens>
- Square webhook retries (24 hours):
  <https://developer.squareup.com/docs/webhooks/troubleshooting>
- Square signature key:
  <https://developer.squareup.com/reference/square/webhook-subscriptions-api/update-webhook-subscription-signature-key>
- A third-party scanner's page, the only source found that says a
  Square personal token does not expire and Replace issues a new one
  (not Square's own): <https://detectors.xygeni.io/xydocs/secrets/detectors/square_token.html>
- PayPal credential rotation (maximum of two secrets, each enabled or
  disabled, a disabled one can be re-enabled, a deleted one cannot;
  an old post, not current docs):
  <https://medium.com/@paypaltech/feature-release-credential-rotation-on-developer-portal-to-enhance-app-security-ba5d8d7e734b>
- PayPal REST guide (`expires_in`, sample 31668 seconds; nothing on
  ending a token): <https://developer.paypal.com/api/rest/>
- PayPal security guidelines (rotate credentials regularly):
  <https://developer.paypal.com/security-guidelines>
- Resend API keys and permissions (`full_access`, `sending_access`):
  <https://resend.com/docs/api-reference/api-keys/create-api-key>
- Resend webhook secret rotation (24-hour overlap):
  <https://resend.com/docs/api-reference/webhooks/rotate-signing-secret>
- Axiom tokens (basic tokens ingest into chosen datasets):
  <https://axiom.co/docs/reference/tokens>
- Axiom create and regenerate (`expiresAt` omitted means no expiry):
  <https://axiom.co/docs/restapi/endpoints/createToken> and
  <https://axiom.co/docs/restapi/endpoints/regenerateToken>
- healthchecks.io: <https://healthchecks.io/docs/api/>
- Netlify personal access tokens:
  <https://docs.netlify.com/api/get-started/>

### Open questions for James

Each is a thing to look at, with the page that records the answer:

1. Square: does the old token still answer after Replace, and for how
   long? (Square section.) Does the credentials page show no expiry?
2. PayPal: does Apps & Credentials offer a second secret and a disable
   control? Can an issued token be ended, or does it live out
   `expires_in`? (PayPal section.)
3. Axiom: does each token show ingest on one dataset and nothing
   else? What is the dataset's retention? (Axiom section.)
4. Resend: does `RESEND_AUDIENCE_KEY` show "Full access"? Is there no
   daily quota on Pro? (Resend section.)
