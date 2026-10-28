# Rollback

The launch release is fixed forward. Rolling back to the invoice
checkout (`ff6270c`) is not an option (James, 2026-10-18). If the
release misbehaves, maintenance mode stops orders and account changes
while the fix is built, and the fix goes out the normal way.

This page covers that, then the rollback that exists from the second
production release on: publishing the previous deploy of the new site.

## At launch: fix forward

1. **Stop the damage.** Turn maintenance mode on for production:
   `bin/nff --production maintenance on`, or from a phone the signed
   ON link that `bin/nff maintenance links` prints
   (`docs/maintenance.md`). It blocks ordering, checkout, the account
   area, sign-in, sign-up and farm-news sign-ups, on the server, and
   it shows customers one message. Webhooks, Venmo capture, the
   scheduled jobs and admin access keep running, so money already in
   flight still settles. A signed-in admin still gets through, to
   prove the fix.
2. **Look at what is in flight.** Venmo checkouts waiting for capture
   live under `checkout/` in the `orders` store, and capture goes on
   during maintenance.
   ```
   bin/nff netlify blobs:list orders --prefix checkout/
   ```
   Note each key. Also look in Square and PayPal for a payment with no
   order record, as in the daily payments check
   (`docs/daily-check.md`), and refund each where it was taken.
3. **Fix on `next`**, let it reach `staging`, check it there, then the
   coordinator fast-forwards `main` after James's go. The usual path
   applies, including `lint-and-test`.
4. **Check production** with the live checks from the launch guide,
   then turn maintenance off (`bin/nff --production maintenance off`)
   and confirm an order page loads.
5. **Write down what happened** in the gitignored `incidents/`
   directory at the repo root: what broke, the times, the deploy ids,
   the orders affected. The repository is public for good, so the
   report is written on disk and never pushed. A public issue says only
   that an incident happened, with no customer or order detail
   (`docs/security.md`).

Step 2 is manual on purpose for launch: it needs the Mac, and looking
in Square and PayPal for a payment with no order is done by hand, with
James at his desk for the whole launch. Catching "payment
taken, no order" early belongs to the planned detector (below, #375);
until it lands James runs the same look every morning
(`docs/daily-check.md`). The order page's health relies on the
telemetry already decided. Hardening is post-launch work, not a
blocker.

A wrong word or a layout fault needs no maintenance mode; fix it
forward and say nothing.

## A bad dependency: two cases

An exploited dependency calls for opposite moves depending on how it
got here (James, 2026-10-18; the policy is in `docs/security.md`).

**Case A: a bad release we adopted** (a hijacked or malicious
version).

1. Roll back, to a deploy built before the bad version entered the
   lockfile. The "Rolling back" steps below apply; with the rule for
   key changes, this is the deploy that also predates any key change.
2. Revert the lockfile on `next` and pin away from the bad version.
3. **Treat it as a leak.** Every secret the code could reach, at build
   time or at run time, is rotated under the leak procedure in
   `docs/secrets.md`: revoke at once, no overlap. That makes the
   rolled-back deploy's keys dead, so it is a target only until the
   new keys are live; then fix forward or revert on `next` and
   promote.
4. Write it up in `incidents/`.

**Case B: an actively exploited flaw in a version we have had for a
while.** Rolling back does not help, because earlier versions carry
the flaw too.

1. **Fix forward.** Adopt the patched release at once. The 7-day
   cooldown is waived for that one package and version, with
   `bin/nff supply waive <package> <version> --advisory GHSA-...
   --reason "..."`, which records it and prints the line for the pull
   request. The signature check still applies.
2. **Contain the exposure** until the patch is live: maintenance mode
   (`bin/nff --production maintenance on`), or switch off just the
   affected feature if that is enough.
3. The pull request to `main` still needs James's approval, and the
   waiver is recorded in it and in `incidents/`.

## From the second release: two ways back

From the second production release, production has a previous release
of the new site to go back to. The one-tap rollback (next section)
automates the publish path below; until it is built, these are the
manual steps.

| | Publish a previous deploy | Revert on `next` and promote |
| --- | --- | --- |
| What happens | Netlify serves an older atomic deploy: its HTML, its functions, its schedule | A new commit on `next` undoes the release; it is promoted to `staging` and `main`, and Netlify builds and publishes it |
| Live in | Seconds once the call is made (Netlify: "instantaneous") | Green checks on `next`, the full e2e suite on `staging`, James's approval, two promotions and a build: a few minutes once he approves and the suite has passed (#502, 2026-10-28) |
| Env vars | The values set when that deploy was built (see below) | The values set now |
| Survives the next push | Only if auto publishing is locked | Yes |
| Needs | The deploy still to exist (30 days on this plan) | git, and GitHub Actions up |
| Undo | Publish the release deploy again | Revert the revert |

Publish a previous deploy first. It is the fast path, it touches
nothing in git and no branch rule applies to it. Revert on `next` and
promote (or unlock) once the rollback has been live 24 hours with no
fix ready, or as soon as anything else must reach production,
whichever comes first: the lock blocks every publish from `main`.
Revert earlier when the old deploy has been deleted or was built
before a key whose old credential is revoked.

Two words, kept apart. A **redeploy** runs a new build, with today's
env values. **Republishing** an old deploy (`restoreSiteDeploy`) runs
no build and serves what was built then.

Netlify's word on env vars: "Each deploy ... uses the environment
variable values that were set at the time of deployment"
(docs.netlify.com/build/functions/environment-variables). So a
republished deploy should carry its own snapshot, not today's values.
This is inferred for a restored deploy; the docs do not say it
outright. The env-snapshot test (see "The rehearsals") proves it on
staging before the second production release, and before launch if it
fits. Until its result is recorded on #267 and here, the rule below
stands.

**The rule for key changes.** Netlify applies an env change only to a
new build. After a production key changes, the previous deploy, the
instant rollback target, still holds the old key. Whether that key
still works depends on why it changed (`docs/secrets.md`, rule 6):

- **After a routine rotation, a deploy built before it works for the
  31 days of the overlap,** or until the old credential's own Jan 31
  expiry, whichever is first. Within that window the previous deploy
  is a safe target. The window and its end date are in the rotation
  log, which has a `revoked` line once the old credential is gone.
- **After a leak, or once the old credential is revoked, it holds a
  dead key.** Never publish a deploy built before that change. Roll
  back past one by reverting on `next` and promoting, which builds
  with current values, or fix forward. A secret we generate ourselves
  (`STAGING_TOKEN`, `MAINTENANCE_SECRET`) has no overlap, so any
  deploy built before its change is already past the floor.

The deploy built after a key change is the new rollback floor, and
the floor moves up to it the day the old credential is revoked.

## The one-tap rollback (designed 2026-10-18, not built)

James's direction on #267 (comment 6246673085). It is post-launch work,
built before the second production release, when production first has
a previous release of the new site to go back to. Design first, with
James's approval before anything is built; the exact signed-link
design is the open item. What he has decided:

- **Rollbacks don't wait for a human.** James is told, at
  `DEV_NOTIFICATIONS_EMAIL`, as early as possible, and no stage has a
  human bottleneck except the one tap that starts it.
- **James starts it, with one tap** from an email or the admin
  dashboard. Jim does not get the option unless a reason comes up.
  The tap is bound to James's identity: a bare emailed link is not
  enough. The expected shape is a signed, single-use, short-lived link
  that opens a dashboard page behind his existing sign-in, with one
  "Roll back now" button.
- **Everything after the tap is automatic, and James is told at
  each step:** (1) snapshot the work in flight, meaning Venmo
  checkouts awaiting capture and any payment Square or PayPal
  confirmed with no matching order; (2) re-publish the target; (3)
  lock auto publishing; (4) verify the target is live (health,
  checkout config and the order page); (5) email affected customers
  from sales@ with a template James approves in advance, and email
  James the same list with what to do about each order (refund, fill
  in, or re-order); (6) write the incident record, in the gitignored
  `incidents/` folder and, once the dashboard pages exist, there,
  never on a public issue. If any step fails, alert loudly and stop;
  never retry a publish in a loop.
- **No automatic detection starts a rollback.** Healthchecks,
  UptimeRobot and Axiom alerts stay as they are. The one exception is
  a dedicated detector for "orders not being recorded", a payment
  confirmed by Square or PayPal with no matching order record. It
  never starts a rollback; it pushes James's phone (ntfy), emails
  `DEV_NOTIFICATIONS_EMAIL` and the alerts check, and repeats until
  acknowledged, with the payment ids, the rollback link and the
  incident page in every alert. The design proposes the reconciliation
  window and how to handle false positives.
- **Incident pages in the admin dashboard.** General pages for a bad
  deploy with an unknown cause: what a rollback does and doesn't undo;
  plain answers to "Do card payments work right now?", "Venmo?",
  "Are emails going out?", "Can customers sign in?"; step-by-step
  recovery; how to roll forward. Scenario pages for the likeliest and
  worst cases (agents propose the list; start from orders not
  recorded, card payments failing, Venmo failing, the order page
  down, emails not sending, a bad price or stock count, the scheduled
  jobs stopped). Every alert and rollback email carries the relevant
  information or a link to the right page.

- **If James is unreachable, Jim switches on maintenance mode** and
  waits for James. Jim never rolls back.
- **A second address, the escape valve.** The env var
  `ESCALATED_NOTIFICATIONS_EMAIL` holds `office@northfosterfarm.com`.
  It is separate from `DEV_NOTIFICATIONS_EMAIL` (`dev@`), which takes
  every other alert, the full technical stream, for James alone. The
  escalation address receives exactly one kind of message, for the
  "orders not recorded" emergency only, in plain, non-technical
  language: James has not responded, switch on maintenance mode, here
  is the signed ON link. Jim is a non-technical partner and gets
  nothing else from the system, since more would make a bad situation
  worse. A test proves that no alert except this escalation can reach
  the address (`test/rotation.test.mjs`, "never lets an alert reach
  the escalation address").
- **Trigger.** The alert is `orders.not_recorded` (a payment taken,
  no order). The escalation sends its message an hour after the alert
  is raised, and again every hour while it is unacknowledged. The
  variable is in `docs/secrets.md`, the env samples and `env check`,
  and is required in production; staging has its own value, never
  production's.
- **Not built yet.** The detector that raises `orders.not_recorded`
  does not exist (#375), so the escalation has nothing to watch; the
  daily payments check (`docs/daily-check.md`) stands in until then. The
  acknowledgement is `acknowledge` in `lib/health.mjs`, but no CLI
  command or dashboard button calls it. Build one with the detector,
  or the escalation cannot be stopped short of the next alert after
  a restart. This is an open item for the rollback design.
- **Wording.** The message is a draft, `escalation` in
  `lib/templates.mjs`: "James hasn't responded to an urgent problem
  with online orders", with a "Switch on maintenance mode" button.
  James approves the words before launch.
- **Hard gate.** The one-tap rollback must be built and rehearsed
  before the second production release. It is a blocking step in the
  launch guide and in the post-deploy checklist (#237): that release
  cannot ship without it.

Nothing here is written down elsewhere yet beyond the issue comment;
the design document is the first deliverable.

## Rolling back

The site id is in `.netlify/state.json` of a linked checkout.
`netlify api` takes path parameters in `--data`.

1. **Decide.** Roll back for a broken order path that a fix cannot
   reach production within the hour: payments failing, orders not
   recorded, the order page not loading. A wrong word or a layout
   fault is fixed forward. Put maintenance mode on first if
   customers could be hurt while you decide
   (`bin/nff --production maintenance on`).
2. **Look at what is in flight**, as in "At launch" step 2.
3. **Search the release's commits for `Record-shape:`**
   (`git log --grep 'Record-shape:' <previous release>..<release>`).
   If any commit carries a trailer other than `Record-shape: none`,
   the release changed a stored record: switch maintenance mode on
   before publishing the older deploy, so old code never writes
   beside new-shaped records, and leave it on until the checks pass.
4. **Pick the target**: the previous release's deploy, built after the
   last key change. Its id is on the release's issue.
   ```
   bin/nff netlify api listSiteDeploys \
     --data '{"site_id":"<id>","branch":"main","per_page":5}' \
     | jq -r '.[] | [.id, .commit_ref[0:7], .published_at] | @tsv'
   ```
5. **Publish it.**
   ```
   bin/nff netlify api restoreSiteDeploy \
     --data '{"site_id":"<id>","deploy_id":"<target id>"}'
   ```
   Or, in the UI: Deploys, open the deploy, Publish deploy.
6. **Lock auto publishing**, so the next push to `main` builds but does
   not publish. Netlify's docs imply that publishing an old deploy
   does not lock by itself.
   ```
   bin/nff netlify api lockDeploy --data '{"deploy_id":"<target id>"}'
   ```
   Or Deploys, Lock to stop auto publishing.
7. **Confirm the target is live**: `/api/health` answers 200,
   `/api/checkout/config` shows the production application id
   (`sq0idp-`), and `/order/` loads. Do not place an order.
8. **Write it down** in the gitignored `incidents/` directory: what
   broke, the time, the deploy ids. A public issue says only that an
   incident happened.
9. **Watch the clock.** Once the rollback has been live 24 hours with
   no fix ready, or as soon as anything else must reach production,
   unlock, or revert on `next` and promote (below). The lock blocks every publish
   from `main`.

## What a rollback does not undo

A rollback swaps code. Everything the release wrote or registered
outside the deploy stays.

- **Blobs.** The stores are site-wide: both versions read and write
  the same `orders`, `customers`, `auth`, `stock` and `jobs`. A
  release that changed a record's shape leaves records the older code
  must still read. Any commit that changes the shape of a stored
  record (Blobs keys, record fields, a data migration) carries a
  trailer, `Record-shape: <what changed>`, or `Record-shape: none`
  where the commit touches the store code but changes no shape. The
  trailer needs a value, so the check cannot be met by accident.
  Before publishing an older deploy, search the release's commits for
  it (Rolling back, step 3); maintenance mode goes on first when a
  trailer says anything but `none`. See "The record-shape check".
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

## The record-shape check

`bin/check-record-shape.mjs` is the rule. If the commits in
the checked range touch any of these paths (`SHAPE_PATHS` in the
script; change them there), at least one commit in the range must
carry the trailer:

- `netlify/functions/lib/store.mjs` (stores and keys)
- `netlify/functions/lib/records.mjs` (order and customer records and
  their indexes)
- `netlify/functions/lib/checkout.mjs`, `edit.mjs`, `account.mjs`,
  `admin.mjs`, `forget.mjs`, `backup.mjs` and `stock.mjs` (the code
  that writes, rewrites, restores or removes them)
- `netlify/migrations/` and `bin/migrations/` (neither exists yet)

A malformed trailer (`Record shape: none`, an empty `Record-shape:`)
fails whatever the range touches. It runs in three places, all strict
(James, 2026-10-20, #283):

- **The pre-push hook** (`.githooks/pre-push`, set up by `npm
  install`) checks the commits the remote branch lacks, or, for a new
  or rebased branch, those since `origin/next`. It refuses the push,
  so the agent who wrote the commit fixes it before anything lands.
- **CI's `record-shape` check** runs on every push and pull request,
  `next` included: a pull request checks its own commits, merge
  commits skipped; a push checks the commits it added. A commit that
  skipped the hook shows red on its own push and is fixed forward.
  It is the check `staging` requires; `main` takes only what
  `staging` has.
- **A run with no usable base** (dispatched, a new branch, a
  force-push whose old tip is gone) checks against `origin/main`.

The release that first puts these files on `main` needs a trailer in
its range: cut it with an empty commit that says `Record-shape: none`
when no shape changed, or what changed when one did. James or the
coordinator makes that statement, not a lane. `--warn` reports
without failing, for an early look.

To read the trailers a release carries, before an older deploy goes
up:

```
git log --grep '^Record-shape:' <old>..<new>
```

## Rolling forward

1. Every order from the rollback window is settled.
2. Publish the release deploy (`restoreSiteDeploy` with its id), or
   the fix's deploy if one was built while locked.
3. **Unlock auto publishing**:
   `bin/nff netlify api unlockDeploy --data '{"deploy_id":"<id>"}'`.
4. **Check each webhook is still enabled**: PayPal, Square and
   Resend. A failing endpoint may have been disabled while the older
   code answered 404.
5. Check `/api/health`, and run one card order in the style of the
   launch guide's live checks.

Republishing an older release deploy brings back its env snapshot.
If an env var changed after it was built, redeploy (a new build, with
today's values) instead.

## Reverting on `next` and promoting instead

For a rollback that has to last, when the deploy is gone, or when it
was built before a key change. Ask James before promoting to `main`;
it auto-deploys.

Switch maintenance mode on first when the release carries a
`Record-shape:` trailer (other than `none`), and for any data
migration: the revert builds in minutes, and old code must not write
records beside the new shape meanwhile
(`bin/nff --production maintenance on`, off after the checks).

`next`, `staging` and `main` take only fast-forwards, with linear
history and no bypass (`docs/security.md`). A revert committed on
`main` would leave it holding a commit `staging` lacks, and the next
promotion could no longer fast-forward. So the revert lands on
`next` and is promoted like any release: the same CI, the same
required checks and James's approval for `main`, nothing skipped. A
revert that touches a lockfile must also pass the `supply-chain`
cooldown, so pinning back to an older version does.

Revert the release on a branch off `next`. If `next` also holds work
that must not ship yet, revert it in the same range by ending the
range at `origin/next` instead, and restore it after the release:

```
git -C <site> fetch origin
git -C <site> switch -c revert-release origin/next
git -C <site> revert --no-edit <first release commit>^..origin/main
git -C <site> push origin revert-release:next
```

The push to `next` starts CI. Once `lint-and-test`, `supply-chain`,
`codeql`, `build` and `record-shape` are green on it, promote:

```
bin/nff promote staging
bin/nff promote main
```

`promote main` refuses until James's `LGTM` is on the open
staging-to-main pull request, put on after the revert reached
`staging`. If no
such pull request is open, the first run opens it and stops.

**After the launch merge, promote `main` from a release branch.** The
launch put a merge commit on `main` alone, and the linear-history rule
keeps it off `staging`, so `staging` is no fast-forward of `main` any
more and plain `promote main` refuses. Every later release, a revert
included, goes as `release/<name>` (first parent `main`, second parent
the `staging` commit, same tree) and `bin/nff promote main
release/<name>`; see `docs/security.md`. To undo the launch itself,
put one commit on `next` that restores the first parent's tree
(`ff6270cf`), carry it through `staging`, and release it that way.
Resetting `main` to that first parent instead needs the `no
force-push` ruleset off, which only James can do, and it republishes
the invoice checkout beside records the new code wrote, which the
fix-forward rule above exists to avoid.

If auto publishing is locked, the promotion to `main` builds but does
not publish: unlock, or publish the new deploy. To go forward again,
revert the revert the same way.

If the check cannot pass (GitHub Actions down), nobody can push around
it. Only James can switch the ruleset off in the repository's
settings, push, switch it on again and write it up in `incidents/`.
Publishing the previous deploy needs none of this.

After launch, the revert is scripted as one command, `bin/nff
rollback revert`: branch, revert range, push to `next`, watch CI,
promote twice. It stops on any failure and asks James for his go
before it promotes to `main`. It is tracked under After launch and does not
block anything.

## The rehearsals

The launch rehearsals are three, all before launch (the third before
the second production release at the latest, before launch if it
fits):

- **Maintenance mode, on staging** (a launch guide step): the open-tab
  case, a payment made just before the switch is flipped, and a
  webhook arriving while it is on. The checkout lane's tests cover
  every blocked and allowed path.
- **The webhook registrations, in the sandbox** (agent work, below).
- **The env-snapshot test, on staging** (a launch guide step; it needs
  Netlify access, so it is James or a tool run he allows). Set a
  harmless staging env value and build a deploy. Change the value.
  Republish the older deploy with `restoreSiteDeploy`, which runs no
  build. Check which value its functions see, and whether the
  republish locks auto publishing. Then redeploy and check that the
  new value shows, the other half of the redeploy versus republish
  distinction. Record the result on #267 and here, and remove the
  first "Not verified" item. The rule for key changes stays until
  then.

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
the second production release. The first is settled sooner, by the
env-snapshot test above:

- That a restored deploy's functions use their build-time env, and
  that `restoreSiteDeploy` does not lock (the env-snapshot test).
- How long a publish takes, call to first good `curl`.
- PayPal's and Resend's retry and disable rules for a failing
  endpoint.
- What an open tab of the order page shows after a rollback.
- That a revert commit passes `lint-and-test`.
