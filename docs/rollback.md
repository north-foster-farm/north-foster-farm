# Rollback

How to take production back to the last good deploy, what that does
and does not put back, and the drill that proves it before launch.
At release, the last good deploy is `ff6270c`, the invoice checkout.

## Two ways back

| | Publish a previous deploy | Revert on `main` |
| --- | --- | --- |
| What happens | Netlify serves an older atomic deploy: its HTML, its functions, its schedule | A new commit restores the old tree; Netlify builds and publishes it |
| Live in | Seconds once the call is made (Netlify: "instantaneous") | A passing `lint-and-test` run, then the push and a build: a few minutes (see below) |
| Env vars | The values set when that deploy was built (see below) | The values set now |
| Survives the next push | Only if auto publishing is locked | Yes |
| Needs | The deploy still to exist (30 days on this plan) | git, and GitHub Actions up |
| Undo | Publish the release deploy again | Revert the revert |

Publish a previous deploy first, every time. It is the fast path, it
touches nothing in git and no branch rule applies to it. Revert on
`main` only when the rollback has to outlive a lock (more than a day
or so), or when the old deploy has already been deleted.

Netlify's word on env vars: "Each deploy ... uses the environment
variable values that were set at the time of deployment"
(docs.netlify.com/build/functions/environment-variables). So a
republished deploy carries its own snapshot, not today's values. This
is inferred for a restored deploy; the docs do not say it outright,
and the drill checks it.

## Before the release

Do these before the release deploys, or the instant path may not be
there when it is needed.

1. **Make a fresh rollback target.** The site is on Netlify's Starter
   plan, which deletes deploys after 30 days. It keeps only the
   published deploy and the latest successful production deploy. The
   `ff6270c` deploy now live (`6ab75a97fcf30a0008d12991`) was built
   2026-09-26, so once the release replaces it, it is only kept until
   about 2026-10-26. On the day before the release, rebuild `main`
   (Deploys, Trigger deploy, Deploy site; or `netlify api
   createSiteBuild --data '{"site_id":"<id>"}'`). That gives a deploy
   of `ff6270c` built with today's env, and 30 days of instant
   rollback from then.
2. **Write down the two deploy ids**: the fresh `ff6270c` deploy (the
   rollback target) and, once it is live, the release deploy (the way
   forward). Put them on #237.
   ```
   netlify api listSiteDeploys \
     --data '{"site_id":"<id>","branch":"main","per_page":3}' \
     | jq -r '.[] | [.id, .commit_ref[0:7], .published_at] | @tsv'
   ```
3. **Leave the old checkout's plumbing in place for a week.** #237's
   P9 deletes Resend's inbound webhook to `/api/venmo/inbound` and
   drops the `invoice.*` events from Square's subscription. Both are
   what the invoice checkout runs on. Hold P9 until the release has
   run a week without a rollback; until then a rollback lands on a
   working old checkout.
4. **Keep the old checkout's Resend credentials until P9.** The old
   `venmo-inbound` reads two of them: `RESEND_WEBHOOK_SECRET`, the
   inbound endpoint's signing secret, and `RESEND_READ_KEY`, which
   reads the received email. On launch day #237 sets
   `RESEND_WEBHOOK_SECRET` on production to the new
   `/api/resend/webhook` endpoint's secret. The fresh `ff6270c` deploy
   from step 1 keeps the old value in its snapshot, so the instant
   path is safe; a revert on `main` after launch day is not, because
   it builds with the new value and every Venmo email would fail its
   signature check. So before launch day, James keeps a copy of the
   current production `RESEND_WEBHOOK_SECRET` (Netlify does not show a
   secret again), and until P9 nobody rotates the inbound endpoint's
   secret, deletes the endpoint or deletes `RESEND_READ_KEY`.

## Rolling back

The site id is in `.netlify/state.json` of a linked checkout.
`netlify api` takes path parameters in `--data`.

1. **Decide.** Roll back for a broken order path that a fix cannot
   reach production within the hour: payments failing, orders not
   recorded, the order page not loading. A wrong word or a layout
   fault is fixed forward.
2. **Look at what is in flight.** Venmo checkouts waiting for capture
   live under `checkout/` in the `orders` store. The old code never
   finishes them.
   ```
   netlify blobs:list orders --prefix checkout/
   ```
   Note each key. An approved Venmo payment that is never captured
   lapses at PayPal and costs the customer nothing; tell any customer
   listed here to order again.
3. **Publish the rollback target.**
   ```
   netlify api restoreSiteDeploy \
     --data '{"site_id":"<id>","deploy_id":"<rollback id>"}'
   ```
   Or, in the UI: Deploys, open the deploy, Publish deploy.
4. **Lock auto publishing**, so the next push to `main` builds but does
   not publish. Netlify's docs imply that publishing an old deploy does
   not lock by itself.
   ```
   netlify api lockDeploy --data '{"deploy_id":"<rollback id>"}'
   ```
   Or Deploys, Lock to stop auto publishing.
5. **Confirm the old site is live.** The release's health answer has a
   `context` key and the old one does not; the release serves
   `/api/checkout/config` and the old site answers 404.
   ```
   curl -s https://www.northfosterfarm.com/api/health | jq 'has("context")'
   curl -s -o /dev/null -w '%{http_code}\n' \
     https://www.northfosterfarm.com/api/checkout/config
   ```
   Expect `false` and `404`. Then load `/order/`, without placing an
   order, and check that the invoice form shows.
6. **Tell the channels.** Post on the issue that tracks the incident:
   what broke, the time, the deploy ids.

## What a rollback does not undo

A rollback swaps code. Everything the release wrote or registered
outside the deploy stays.

**Blobs.** The stores are site-wide: both versions read and write the
same `orders`, `customers`, `auth`, `stock` and `jobs` in production.
What the old code meets:

- Orders born `paid`, with `payment.via` (`square` or `venmo`) and no
  `square.invoiceId`. The old jobs treat a `paid` order as the release
  does: delivery reminder at 18:00, `fulfilled` after its date
  (`origin/main:netlify/functions/lib/jobs.mjs:220-243`). The old
  account page shows no invoice for them
  (`origin/main:netlify/functions/lib/account.mjs:75-77`). A customer
  cancel of a paid order is flagged for a refund by hand, not refunded
  (`account.mjs:164-175` there). Read from the code, not run; the drill
  runs it.
- `checkout/` and `by-paypal/` keys, which the old code ignores.
- Customers with `marketing` and the farm-news fields, which the old
  code does not read or clear.
- The `jobs` store's outbox, library and ledger keys, harmless.

**Records the old code writes.** While rolled back, new orders are
invoice orders, `submitted` until paid. The release does not process
them: its jobs only flag a `submitted` record
(`netlify/functions/lib/records.mjs:12-14`). Before rolling forward,
each must be paid, cancelled or abandoned by the old jobs, as in
`docs/qa-launch.md` RF-08.

**Webhooks.** Registrations point at endpoints the old code lacks:

| Vendor | Endpoint | Under the old code |
| --- | --- | --- |
| PayPal | `/api/paypal/webhook` | 404; PayPal retries (its schedule not checked) |
| Resend | `/api/resend/webhook` | 404; Resend may disable an endpoint that keeps failing |
| Square | `/api/square/webhook` | Exists; handles what the old code knows |

Unsubscribes lost to 404s are reconciled by the first daily audience
sync after rolling forward. After rolling forward, check that the
Resend endpoint is still enabled.

**Env vars.** The release adds `PICKUP_SCHEDULE`,
`PICKUP_SCHEDULE_HOOK`, `SITE_CONTEXT`, `VENMO_HIDDEN`,
`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV`,
`PAYPAL_WEBHOOK_ID`, `SQUARE_APPLICATION_ID`, `RESEND_AUDIENCE_ID`,
`RESEND_AUDIENCE_KEY`, `RESEND_LOOKUP_KEY` and
`RESEND_WEBHOOK_SECRET` under its new meaning, and stops reading
`RESEND_READ_KEY`. The old code ignores the new ones. Leave them all
set; unsetting one changes nothing until the next deploy, and the way
forward needs them. `MAIL_DRIVER` keeps `resend` in production either
way. The one name both versions read with different values is
`RESEND_WEBHOOK_SECRET`; a revert on `main` sets it back first (below).

**Scheduled functions.** Both versions schedule `jobs` every fifteen
minutes; the published deploy's schedule is the one that runs. The
old jobs do not sync the farm-news audience, sweep stale checkouts,
capture a Venmo payment the page left, or chase contact messages.

**Emails already sent.** They cannot be recalled. Their links lead to
the old site: `/account/orders/<id>` still works (the old
`netlify.toml` has the redirect), but farm-news confirmation links
under `/api/news/` answer 404 until rolling forward.

**Open tabs.** HTML revalidates on every load (`netlify.toml`), so a
fresh page is the old one at once. A tab already on the new order page
calls `/api/checkout/config` (404) and fails to load the card fields.
Not run; the drill checks what the customer sees.

**Square and PayPal.** Payments, Square customers and Square orders
the release made stay. Refund them with the release's `bin/nff` from
a checkout of `next`. The old CLI predates Venmo through PayPal and
the release's refund paths; do not use it on the release's orders.

## Rolling forward

1. Every `submitted` order from the rollback window is settled.
2. Publish the release deploy (`restoreSiteDeploy` with its id), or
   the fix's deploy if one was built while locked.
3. Unlock: `netlify api unlockDeploy --data '{"deploy_id":"<id>"}'`.
4. Check `/api/health` has `context`, and run one card order in the
   style of #237's live checks.
5. Check the Resend and PayPal webhooks are enabled.

Republishing an older release deploy brings back its env snapshot.
If an env var changed after it was built, trigger a fresh deploy
instead.

## Reverting on `main` instead

For a rollback that has to last, or when the deploy is gone. Ask James
before pushing to `main`; it auto-deploys.

Branch protection on `main` takes only a fast-forward to a commit that
has passed `lint-and-test`, and binds admins too (`docs/staging.md`).
So the revert is one commit on a branch, checked by CI, then
fast-forwarded. The commit keeps the release's `.github/`: `ff6270c`
has no `ci.yml`, and a run can only be started on a ref that has one.

```
R=north-foster-farm/north-foster-farm
git -C <site> fetch origin
git -C <site> switch -c revert-release origin/main
git -C <site> read-tree -u --reset ff6270c
git -C <site> checkout origin/main -- .github
git -C <site> commit -m "Revert to the invoice checkout"
git -C <site> --no-pager diff --stat ff6270c -- . ':!.github'  # empty
git -C <site> push -u origin revert-release
gh workflow run ci.yml -R $R --ref revert-release
gh run list -R $R --workflow ci.yml --branch revert-release -L 1
gh run watch <run id> -R $R --exit-status
```

Dispatch the run the moment the branch is pushed: `ci.yml` runs on
its own only for `next`, `staging`, `main` and pull requests, and
`lgtm-automerge` refuses a pull request into `main`. The one run so
far (2026-10-16) waited 2 seconds for a runner and took 24, so the
check adds about a minute. Then, once it passes:

1. **If launch day has passed**, set production's
   `RESEND_WEBHOOK_SECRET` back to the old inbound secret James kept
   (see "Before the release", step 4), or the old Venmo inbound
   rejects every email: `netlify env:set RESEND_WEBHOOK_SECRET <old>
   --context production --secret --json`.
2. Fast-forward and push:
   ```
   git -C <site> switch main
   git -C <site> merge --ff-only revert-release
   git -C <site> push origin main
   ```

If auto publishing is locked, the push builds but does not publish:
unlock, or publish the new deploy. The `ff6270c` build command runs
lint and the tests again (`npm run deploy`) but not `check:schedule`,
so it does not need `PICKUP_SCHEDULE`. To go forward again, revert the
revert the same way, back to the release's tree, after setting
`RESEND_WEBHOOK_SECRET` back to the new endpoint's secret.

If the check cannot pass (GitHub Actions down, or the old suite
failing under CI), nobody can push around it. Only James can switch
the rule off for `main` in the repository's settings, push, and
switch it on again. Publishing the previous deploy needs none of this.

## The drill

Run before launch, with James. Write down each timing.

**Never deploy `ff6270c` to staging or a preview.** Its store layer
ignores `SITE_CONTEXT` and uses the bare store names in every context
(`origin/main:netlify/functions/lib/store.mjs:57-70`), so a staging
deploy of it reads and writes production's orders. And Netlify
publishes previous deploys for production only; a branch deploy
always serves its latest build. The publish path is therefore
rehearsed on production, between two deploys whose output is the same
(`6e6a665` and `ff6270c` differ only in
`.github/workflows/staging-jobs.yml`). The revert path and the data
are rehearsed on staging and locally.

### A. The publish path, on production

1. Trigger a production build of `main` (`ff6270c`). Record its deploy
   id and `deploy_time`. Expect `ready` and published in under two
   minutes. This is also the fresh rollback target.
2. Publish the older deploy `6ab75a97fcf30a0008d12991` with
   `restoreSiteDeploy`. Record the time from the call to
   `getSite`'s `published_deploy.id` naming it, and to the first
   `curl` of `/api/health` that succeeds. Expect seconds.
3. Check `getSite`'s `published_deploy.locked`. This answers whether
   publishing locks by itself. Expect `false`.
4. `lockDeploy` on it. Expect `locked: true`.
5. Trigger another build of `main`. Expect it to reach `ready` and not
   be published; `published_deploy.id` still names `6ab75a97`.
6. Publish the deploy from step 1 again and `unlockDeploy`. Expect it
   published and `locked` false. Record the total time.
7. Run `bin/nff --production jobs history` after the next quarter
   hour. Expect a run from the restored deploy: the schedule moved
   with the deploy.

### B. The revert path, on staging

With the coordinator, since staging is force-pushed. **Run B before
James switches on the branch rules** (a launch guide step). Step 3
puts `staging` back with a force push, which the rules refuse once
they are on, and the rules give staging no way back but a revert of
the revert.

1. On a branch from `staging`, revert a recent page-only commit
   (record which) and push it as `staging`. Record push to `ready`.
   The release's build runs `check:schedule` and `check:grid`; staging's
   builds have run 30 to 60 seconds, once 167.
2. Check the change is gone on
   `staging--north-foster-farm.netlify.app`.
3. Force-push `staging` back to its old tip. Record the time again.
4. In a scratch clone, build the production revert from "Reverting on
   `main` instead" on top of `origin/main`. Expect the diff against
   `ff6270c` outside `.github/` to be empty and `git merge-base
   --is-ancestor origin/main revert-release` to succeed.
5. Push it as `revert-drill`, never as `main`, and run its check
   (`gh workflow run ci.yml --ref revert-drill`, then `gh run watch`).
   Record dispatch to green. Expect it to pass: `ff6270c`'s suite has
   never run under CI's `env -i`, and this is the only proof before
   it is needed. Delete `revert-drill` after.

### C. Old code over new records, locally

1. Export staging's records, read-only:
   `netlify blobs:list branch-deploy-orders`, then `blobs:get` each
   key into a folder. The same for `customers` and `auth`.
2. In a worktree of `ff6270c`, a small script seeds `testStores()`
   with them and runs the old `runJobs` with mail captured, the Square
   invoice calls stubbed, and `now` at 18:05 the day before a delivery.
3. Expect no `jobs.errors`, no `order.unreadable`, delivery reminders
   only for paid delivery orders due tomorrow, and no Square call.
4. Run the old `publicOrder` (account page) over each order. Expect no
   throw.
5. The reverse: a `submitted` record from the old checkout, run
   through the release's jobs. Expect it flagged, not touched.

### D. The webhooks, in the sandbox

List the registrations the runbook names, so the commands are known
before they are needed: Square's subscriptions
(`GET /v2/webhooks/subscriptions`), PayPal's webhooks
(`GET /v1/notifications/webhooks`), Resend's endpoints in its
dashboard. Expect the staging URLs from `docs/staging.md`.

### Record

| Step | Measure |
| --- | --- |
| A1 | Build `deploy_time`, push to published |
| A2 | Call to published; call to first good `curl` |
| A3 | Whether publishing locked |
| A5 | Whether the locked site held |
| A6 | Rollback and back, end to end |
| B1, B3 | Staging push to `ready` |
| B5 | Revert's `lint-and-test`, dispatch to green |
| C | Any exception or invariant, by order |

Put the results on #244 and update this page's timings.

## Not verified

- That a restored deploy's functions use their build-time env, and
  that `restoreSiteDeploy` does not lock. Drill A checks both.
- PayPal's and Resend's retry and disable rules for a failing
  endpoint.
- What an open tab of the new order page shows after a rollback.
- Old-code behavior over new records, beyond reading the code. Drill
  C runs it.
- That `ff6270c`'s tree passes `lint-and-test`. Drill B5 runs it.
