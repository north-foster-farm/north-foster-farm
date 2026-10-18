# Rollback

The launch release is fixed forward. Rolling back to the invoice
checkout (`ff6270c`) is not an option (James, 2026-10-18). If the
release misbehaves, maintenance mode stops orders and account changes
while the fix is built, and the fix goes out the normal way.

This page covers that, then the rollback that exists from the second
production release on: publishing the previous deploy of the new site.

## At launch: fix forward

1. **Stop the damage.** Turn maintenance mode on for production
   (`<maintenance on>`: the command and the dashboard switch are the
   checkout lane's, see `docs/maintenance.md` once it lands). It
   blocks ordering, checkout, the account area, sign-in, sign-up and
   farm-news sign-ups, on the server, and it shows customers one
   message. Webhooks, Venmo capture, the scheduled jobs and admin
   access keep running, so money already in flight still settles.
2. **Look at what is in flight.** Venmo checkouts waiting for capture
   live under `checkout/` in the `orders` store, and capture goes on
   during maintenance.
   ```
   netlify blobs:list orders --prefix checkout/
   ```
   Note each key. Also look in Square and PayPal for a payment with no
   order record; each is refunded with `bin/nff` (below).
3. **Fix on `next`**, let it reach `staging`, check it there, then the
   coordinator fast-forwards `main` after James's go. The usual path
   applies, including `lint-and-test`.
4. **Check production** with the live checks from the launch guide,
   then turn maintenance off (`<maintenance off>`) and confirm an
   order page loads.
5. **Say what happened** on the issue that tracks the incident: what
   broke, the times, the deploy ids, the orders affected.

A wrong word or a layout fault needs no maintenance mode; fix it
forward and say nothing.

## From the second release: two ways back

From the second production release, production has a previous release
of the new site to go back to. The one-tap rollback designed on
2026-10-18 (#267) automates the publish path below; until it is
built, these are the manual steps.

| | Publish a previous deploy | Revert on `main` |
| --- | --- | --- |
| What happens | Netlify serves an older atomic deploy: its HTML, its functions, its schedule | A new commit undoes the release; Netlify builds and publishes it |
| Live in | Seconds once the call is made (Netlify: "instantaneous") | A passing `lint-and-test` run, then the push and a build: a few minutes |
| Env vars | The values set when that deploy was built (see below) | The values set now |
| Survives the next push | Only if auto publishing is locked | Yes |
| Needs | The deploy still to exist (30 days on this plan) | git, and GitHub Actions up |
| Undo | Publish the release deploy again | Revert the revert |

Publish a previous deploy first. It is the fast path, it touches
nothing in git and no branch rule applies to it. Revert on `main` only
when the rollback has to outlive a lock (more than a day or so), when
the old deploy has been deleted, or when the deploy was built before a
key changed.

Netlify's word on env vars: "Each deploy ... uses the environment
variable values that were set at the time of deployment"
(docs.netlify.com/build/functions/environment-variables). So a
republished deploy carries its own snapshot, not today's values. This
is inferred for a restored deploy; the docs do not say it outright.

**The rule for key changes.** Netlify applies an env change only to a
new build. After a production key changes (the yearly January 1
rotation or a leak), the previous deploy, the instant rollback target,
still holds the old, revoked key. Never publish a deploy built before
a key change. Roll back past one by reverting on `main`, which builds
with current values, or fix forward. The deploy built after a
rotation is the new rollback floor (`docs/secrets.md`).

## Rolling back

The site id is in `.netlify/state.json` of a linked checkout.
`netlify api` takes path parameters in `--data`.

1. **Decide.** Roll back for a broken order path that a fix cannot
   reach production within the hour: payments failing, orders not
   recorded, the order page not loading. A wrong word or a layout
   fault is fixed forward. Put maintenance mode on first if
   customers could be hurt while you decide.
2. **Look at what is in flight**, as in "At launch" step 2.
3. **Pick the target**: the previous release's deploy, built after the
   last key change. Its id is on the release's issue.
   ```
   netlify api listSiteDeploys \
     --data '{"site_id":"<id>","branch":"main","per_page":5}' \
     | jq -r '.[] | [.id, .commit_ref[0:7], .published_at] | @tsv'
   ```
4. **Publish it.**
   ```
   netlify api restoreSiteDeploy \
     --data '{"site_id":"<id>","deploy_id":"<target id>"}'
   ```
   Or, in the UI: Deploys, open the deploy, Publish deploy.
5. **Lock auto publishing**, so the next push to `main` builds but does
   not publish. Netlify's docs imply that publishing an old deploy
   does not lock by itself.
   ```
   netlify api lockDeploy --data '{"deploy_id":"<target id>"}'
   ```
   Or Deploys, Lock to stop auto publishing.
6. **Confirm the target is live**: `/api/health` answers 200,
   `/api/checkout/config` shows the production application id
   (`sq0idp-`), and `/order/` loads. Do not place an order.
7. **Tell the channels.** Post on the incident issue: what broke, the
   time, the deploy ids.

## What a rollback does not undo

A rollback swaps code. Everything the release wrote or registered
outside the deploy stays.

- **Blobs.** The stores are site-wide: both versions read and write
  the same `orders`, `customers`, `auth`, `stock` and `jobs`. A
  release that changed a record's shape leaves records the older code
  must still read; check the release notes for any such change before
  publishing.
- **Webhooks.** PayPal, Square and Resend keep sending to the same
  URLs. An endpoint the older code lacks answers 404; PayPal retries,
  and Resend may disable an endpoint that keeps failing. After
  rolling forward, check each is still enabled.
- **Env vars.** Variables a release added stay set, and unsetting one
  changes nothing until the next deploy.
- **Scheduled functions.** The published deploy's schedule is the one
  that runs.
- **Emails already sent.** They cannot be recalled, and their links
  keep pointing at the live site.
- **Open tabs.** HTML revalidates on every load (`netlify.toml`), so a
  fresh page is the older one at once. A tab already open may call an
  endpoint the older code lacks.
- **Square and PayPal.** Payments, Square customers and Square orders
  stay. Refund them with `bin/nff` from a checkout of `next`.

## Rolling forward

1. Every order from the rollback window is settled.
2. Publish the release deploy (`restoreSiteDeploy` with its id), or
   the fix's deploy if one was built while locked.
3. Unlock: `netlify api unlockDeploy --data '{"deploy_id":"<id>"}'`.
4. Check `/api/health`, and run one card order in the style of the
   launch guide's live checks.
5. Check the Resend and PayPal webhooks are enabled.

Republishing an older release deploy brings back its env snapshot.
If an env var changed after it was built, trigger a fresh deploy
instead.

## Reverting on `main` instead

For a rollback that has to last, when the deploy is gone, or when it
was built before a key change. Ask James before pushing to `main`; it
auto-deploys.

Branch protection on `main` takes only a fast-forward to a commit that
has passed `lint-and-test`, and binds admins too (`docs/staging.md`).
So the revert is one commit on a branch, checked by CI, then
fast-forwarded.

```
R=north-foster-farm/north-foster-farm
git -C <site> fetch origin
git -C <site> switch -c revert-release origin/main
git -C <site> revert --no-edit <first release commit>^..origin/main
git -C <site> push -u origin revert-release
gh workflow run ci.yml -R $R --ref revert-release
gh run list -R $R --workflow ci.yml --branch revert-release -L 1
gh run watch <run id> -R $R --exit-status
```

Dispatch the run the moment the branch is pushed: `ci.yml` runs on
its own only for `next`, `staging`, `main` and pull requests, and
`lgtm-automerge` refuses a pull request into `main`. The one run so
far (2026-10-16) waited 2 seconds for a runner and took 24. Once it
passes, fast-forward and push:

```
git -C <site> switch main
git -C <site> merge --ff-only revert-release
git -C <site> push origin main
```

If auto publishing is locked, the push builds but does not publish:
unlock, or publish the new deploy. To go forward again, revert the
revert the same way.

If the check cannot pass (GitHub Actions down), nobody can push around
it. Only James can switch the rule off for `main` in the repository's
settings, push, and switch it on again. Publishing the previous deploy
needs none of this.

## The rehearsals

The launch rehearsals are two, both before launch:

- **Maintenance mode, on staging** (a launch guide step): the open-tab
  case, a payment made just before the switch is flipped, and a
  webhook arriving while it is on. The checkout lane's tests cover
  every blocked and allowed path.
- **The webhook registrations, in the sandbox** (agent work, below).

The drill that rehearsed rolling back to the invoice checkout is
retired: its parts A (publish a deploy of `ff6270c` on production),
B (revert to `ff6270c`, on staging), and C (old code over new
records) existed only for that rollback. Part D stays. The webhook
commands are needed at launch whichever way a problem is fixed, and
an incident needs them known in advance.

### D. The webhooks, in the sandbox

List the registrations the runbook names, so the commands are known
before they are needed: Square's subscriptions
(`GET /v2/webhooks/subscriptions`), PayPal's webhooks
(`GET /v1/notifications/webhooks`), Resend's endpoints in its
dashboard. Expect the staging URLs from `docs/staging.md`. Record the
result on #244.

## Not verified

These were to be settled by the retired drill. They stay open until
the one-tap rollback is built and rehearsed on the new site, before
the second production release:

- That a restored deploy's functions use their build-time env, and
  that `restoreSiteDeploy` does not lock.
- How long a publish takes, call to first good `curl`.
- PayPal's and Resend's retry and disable rules for a failing
  endpoint.
- What an open tab of the order page shows after a rollback.
- That a revert commit passes `lint-and-test`.
