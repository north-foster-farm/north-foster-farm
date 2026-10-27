# Security

The decisions are James's, made on #267 on 2026-10-18. This page says
what each one is and what is built to enforce it. Where this page and
the code differ, the code is right.

## The repositories are public, for good

`north-foster-farm` and `nff-dashboard` stay public and in the
organization (James, 2026-10-18). A private repository would cost
Netlify's paid plan and GitHub's code security add-on; James revisits
when site revenue makes that cost a non-issue. Until then these rules
are standing, not a stopgap:

- **No key value and no personal data** in the repository, an issue,
  a pull request, an Actions log or artifact, or the `launch-guide`
  branch. A leaked value is rotated (`docs/secrets.md`).
- **Actions logs print counts and outcomes only.** Workflow logs and
  uploaded artifacts are readable by anyone, so neither may hold a
  finding, a report or a name.
- **Exploitable specifics stay out of public issues.** An issue may
  say that a weakness or incident exists, not how to use it.
- **Incident write-ups live in the gitignored `incidents/` folder** at
  the repository root, on disk, never pushed (`docs/rollback.md`).
- **Scan reports never go anywhere public.** That covers the secret
  scan, the function review, ZAP and any later audit. The log carries
  a pass or fail and a count. The full report is not yet placed; the
  proposal is below.

**Where the full ZAP report goes (proposed, James decides).** Encrypt
it to James's age key before it leaves the runner and put the file in
the private R2 bucket, as the backup does (`docs/backup.md`). Nothing
readable is ever uploaded, and the one key that reads it never leaves
his Mac. The alternative is to mail it to `DEV_NOTIFICATIONS_EMAIL`,
which is simpler but leaves findings in a mailbox. Neither is built;
the ZAP scans are not yet either.

**Revisit trigger.** Moving the repositories to James's personal
account and making them private is no longer planned. James reopens it
when site revenue covers the extra cost. Doing so means re-linking
Netlify, apps and webhooks, and fixing every anonymous read
(`raw.githubusercontent.com`, image links) first.

## Logging changes to production records

James approved this rule on #303 on 2026-10-27 (#497). It covers
the `bin/nff` commands and every server action: Netlify functions,
scheduled jobs and webhooks.

- **Log:** every change to a production record made by a person or
  the CLI. Each line records the time, who acted (CLI, farm, host or
  customer), the action, the target, and the values before and after.
  Money and membership changes are always logged.
- **Don't log:** reads, `--dry-run` and previews, scheduled jobs that
  changed nothing, and anything on staging or development unless it's
  needed for debugging.
- **Never in a log:** secrets or tokens, payment details, or a full
  email address, phone number or street address. Mask addresses as in
  #496, keeping the first three and last three characters of each
  part.
- **Log records are append-only** and follow the retention rules for
  customer data.
- Any new command or action that changes production records ships
  with its log line and a test, as part of the definition of done.

`netlify/functions/lib/log.mjs` already scrubs every line on its way
in: named personal fields are removed and an email address in any
string becomes a short hash. The rule asks more of the line than the
scrubber can supply (who acted, before and after), so each write path
writes those fields itself. The audit of today's write paths against
this rule is on #497.

## GitHub's free security features

The first three are on in both repositories, the site and the
dashboard, since 2026-10-20 (#283):

- Secret scanning with push protection.
- Private vulnerability reporting, so an outsider writes to James and
  not to a public issue.
- Dependabot alerts and security updates.
- CodeQL runs from the repository's own workflow (below), not the
  default setup, which would scan every branch.

Who can read Code scanning alerts on a public repository is not
confirmed. James checks the Security tab signed out. If alerts show,
an open alert is public the moment CodeQL raises it, so resolve it
quickly.

## Dependency policy

One policy for both repositories and every part of each: site,
functions, edge functions, build tooling, dev tooling and Actions. No
part updates faster than another.

1. **Exact versions.** No `^` or `~` in any `package.json`; `.npmrc`
   sets `save-exact=true`. Lockfiles are committed and CI installs
   with `npm ci`. Node (`.nvmrc`, `NODE_VERSION`) and Hugo
   (`HUGO_VERSION`) are pinned. Actions are pinned to full commit SHAs
   with the version in a comment.
2. **Cooldown.** No release is adopted until it has been public for
   7 days. Dependabot's `cooldown` enforces it, and the
   `supply-chain` CI job fails when a lockfile resolves a package
   published less than 7 days ago. Unreadable publish dates fail
   too.
3. **Authenticity.** `supply-chain` also runs `npm audit signatures`,
   and fails on an invalid signature or attestation. A package with no
   provenance attestation fails unless its name is in
   `security/attestation-baseline.json`; James approves a new one by a
   pull request that adds it. The baseline holds the packages already
   resolved without one on 2026-10-18, taken as found. Since then,
   James approved on 2026-10-20 (#279) seven build and lint packages
   that never ship: `@csstools/css-syntax-patches-for-csstree`,
   `@keyv/bigmap`, `@keyv/serialize`, `get-east-asian-width`,
   `hashery`, `hookified` and `qified`.
4. **Updates arrive as Dependabot pull requests into `next`**, minor
   and patch in one group each Monday 08:00 Eastern, a major version
   in its own. They pass the full suite like any change. A major bump
   waits for James.
5. **A new dependency needs James's approval** (#303, 2026-10-27).
   New dependencies are allowed when they provide clear value,
   especially where a well-tested package replaces code that could
   break in subtle ways (encoders, parsers, crypto, date handling and
   similar). Lean toward fewer dependencies: if a small amount of
   simple code does the job, write it. James has the final say on
   every new package. Before adding one, post a short proposal: the
   package, its version and license, how well it's maintained, what it
   replaces, and why it beats hand-rolling. Don't add it until James
   approves. Approved packages are pinned. The proposal and the pull
   request that adds the package also state how big its own
   dependency tree is. No automation checks this.

Where installing a patched version would pull in young transitive
packages, adopt an older patched version, or hold the transitive one
with `overrides` in `package.json`.

## Remediation runs on events, not deadlines

- A pinned version may run indefinitely while it has no known
  vulnerability. Being out of date is never a reason to update.
- The `audit` CI job runs `npm audit` over every lockfile and the
  GitHub advisory database over the Actions in use. It fails while a
  finding has neither a fix in the lockfile nor a recorded exception.
  The log prints counts only.
- **Promoting to `main` is blocked while any known vulnerability is
  unresolved.** It resolves by an update or by an exception. This does
  not require taking every available update. `staging` is not blocked:
  it serves no customers, and build-only tooling should not stop QA
  (James, 2026-10-20, #283, relaxing the earlier rule that blocked
  `staging` too). The gate is `release-audit`, its own workflow
  (`release-audit.yml`) that runs only on a pull request into `main`,
  so no run on another event can satisfy it for the same commit.
  `audit` runs the same command on every push and blocks nothing.
- **Exceptions are James's call and are recorded** in
  `security/exceptions.json`: package, advisory id, why, how we are
  exposed, and the plan. Entries are public-safe; exploit detail goes
  in `incidents/`. An exception comes back by itself, failing `audit`
  and the daily production audit, once the GitHub advisory database
  names a patched version of the package, unless `reraisedFor` names
  the version James has already looked at. npm's own fix hint does
  not count: it can name a downgrade of some other package.
- **A daily audit of what is deployed** (`prod-audit.yml`) finds the
  deployed commit, audits its lockfile, and pings a Healthchecks
  check: a plain ping when clean, `/fail` when not. The ping URL is the
  Actions secret `PROD_AUDIT_PING_URL`. A new advisory against the
  deployed lockfile alerts James out of band. The alert is the
  threshold, not a calendar. Scheduled workflows start only from the
  default branch, so it runs once the workflow reaches `main`.

## A bad dependency in production

Two cases, and they call for opposite moves.

**Case A: a bad release we adopted** (a hijacked or malicious
version).

1. Roll back per `docs/rollback.md` to a deploy built before the bad
   version entered the lockfile.
2. Revert the lockfile on `next` and pin away from that version.
3. **Treat it as a leak.** Rotate every secret the code could reach,
   at build time or at run time, under the leak procedure in
   `docs/secrets.md`: revoke at once, no overlap.
4. Write it up in `incidents/`.

**Case B: an actively exploited flaw in a version we have had for a
while.** Earlier versions carry it too, so a rollback does not help.

1. **Fix forward.** Adopt the patched release at once. The cooldown is
   waived for that one package and version, and the waiver is
   recorded in the pull request and in `incidents/`. The signature
   check still applies.
2. **Contain the exposure** until the patch is live: maintenance mode,
   or switch off just the affected feature.
3. The pull request to `main` still needs James's approval.

The recorded waiver is `security/cooldown-waivers.json`, read by the
`supply-chain` check, so no hand edit is needed:

```
bin/nff supply waive <package> <version> --advisory GHSA-... \
  --reason "..."
bin/nff supply waivers
bin/nff supply unwaive <package> <version>
```

`waive` refuses a version range, a missing advisory or reason, and a
repeat. It writes an incident note to `incidents/` with the Case B
to-do list and prints the line to paste into the pull request.
`--file <path>` targets another repository's copy, the dashboard's.

## Code analysis

- **CodeQL** (`codeql.yml`; the dashboard has its own for `main`) runs
  only on pull requests into and pushes to `next`, `staging` and
  `main`. Its check, `codeql`, fails on an open alert of high or
  critical security severity (`bin/codeql/gate.mjs`). A commit is
  scanned once: the run looks for an analysis of that SHA first and
  reuses it, so a fast-forward to `staging` or `main` does not rescan.
  Dismissing an alert in GitHub, with a reason, is the recorded
  exception and is James's call.
- **Tests in the normal suite:**
  - hostile input: every customer-typed field through every email
    template comes out as inert text (`test/hostile-input.test.mjs`),
    and the dashboard pins its raw-HTML and URL sinks to a reviewed
    list;
  - webhook signatures: Square, PayPal and Resend refuse an unsigned
    or forged delivery with every record unchanged, and a replay
    changes nothing (`test/webhook-security.test.mjs`);
  - row-level security in `nff-dashboard`: a test reads every
    migration and fails if a table lacks it or a policy, grant or
    definer function is open to `anon`, and a daily check reads every
    table as a signed-out visitor against production, once the two
    public repository variables are set (`SUPABASE_URL`,
    `SUPABASE_ANON_KEY`).
- **One review of the functions** against the OWASP Top 10 and one
  history scan for secrets were done once. Both reports are private.
  Neither found a launch blocker, and the history scan found no live
  credential. The standing control against a future one is push
  protection.

## Fast-forward only

`next`, `staging` and `main` take fast-forwards only. Two rulesets on
`north-foster-farm`, with no bypass actor:

- `fast-forward only: next, staging, main`: linear history, no force
  push, no deletion.
- `required checks: staging, main`: `lint-and-test`, `supply-chain`
  and `codeql`, each from the GitHub Actions app. James decided the
  next sets on 2026-10-20 (#283): `build` on both, `release-audit` on
  `main` only, `record-shape` on `staging`, and the e2e checks. They
  are applied once each job is green and James confirms.

`next` requires no check, because lanes land by pushing a commit that
has no result yet. GitHub accepts a direct push of a commit whose
required checks already passed and refuses one with none.

GitHub's merge button cannot fast-forward: "Rebase and merge" makes new
SHAs, which breaks both the fast-forward and the rule that a passed
check belongs to its SHA. So:

- **Branch to `next`:** rebase onto `next`, then push the fast-forward.
- **`next` to `staging`, `staging` to `main`:** `bin/nff promote
  staging|main [--dry-run]` pushes that commit and nothing else. It
  refuses a non-fast-forward and a commit without every check the
  agreed ruleset for that branch requires (`REQUIRED_CHECKS` in
  `bin/promote.mjs`): `lint-and-test`, `supply-chain`, `codeql` and
  `build`, plus `record-shape` for `staging` and `release-audit` for
  `main`. For `main` it also requires the commit to be the head of an
  open staging-to-main pull request from this repository's `staging`,
  with an `LGTM` label put on after the push that brought the commit
  to `staging` (from the repository's activity, not the commit date,
  which can predate the label) and still on it, since taking the label
  off withdraws the approval; when none is open it opens one, so
  `release-audit` runs, and stops. It
  audits the commit's own lockfile first: reported now, blocking once
  `AUDIT_BLOCKS` is set, because a check that passed earlier cannot
  see an advisory published since.
- **A release branch to `main`:** `bin/nff promote main release/<name>`
  (James, 2026-10-26) takes `main` one step by a merge commit, so that
  every staging commit stays reachable from `main`. It is still a
  fast-forward of `main`. The commit must have exactly two parents: the
  first is `main` as it is now, the second is a commit `staging`
  already holds, and the commit's tree is that second parent's, so the
  merge adds nothing `staging` did not. The checks, the pull request and
  the `LGTM` label are those of this commit and its own branch, not
  `staging`'s: the pull request is the open one from `release/<name>`
  into `main`, and the label must be newer than the push (a creation or
  a force-push, which the activity records apart from a push) that left
  the branch at this commit. A rebuilt branch is a new commit, so the
  checks and the label start again. The name must match
  `release/[a-z0-9-]+`. `main`'s ruleset allows this because linear
  history is required on `next` and `staging` only. Once `main` holds
  a release merge, that commit is on `main` alone, so `staging` is no
  fast-forward of `main` and plain `promote main` refuses: every later
  release, a hotfix included, is a release branch too.

**There is no pull-request rule on `main`.** It would reject the
fast-forward, and the only way past it is a bypass for the one account
every agent shares. So `bin/nff promote main` checks James's approval
and GitHub does not. It shows the evidence is on the pull request, not
who put it there, because GitHub holds one account. A second reviewer
account, with one required approval and no bypass, would make the
approval enforceable. That is James's decision.

No bypass is recorded because none is needed. If CI itself is down,
James turns the ruleset off in Settings, pushes, turns it on again and
writes it up in `incidents/`.

`nff-dashboard` keeps its one ruleset on `main` (pull request, rebase
merges, required check `check`). It gains linear history,
`supply-chain` and `codeql`, and its admin bypass narrows to pull
requests only, once the pull request that adds those workflows merges.
