# Compacting staging for main

At launch `main` takes the whole of `staging`, but not as the thousand
commits the lanes made one at a time, and not as one squash (James,
#303, #452). This plan groups them into 68 units and says how to build
them as one commit each on top of `main`, on release day (#381), after
the freeze and the #423 QA pass. The coordinator approves it. It is
written for an agent to carry out: every decision is made here, and
the day itself is mechanics.

There is no script. The steps below are plain git, and an agent may
type them or put them in a throwaway loop under `.ignored/`; nothing
for the build is committed.

## The hard rule

Before anything is pushed, the compacted branch's tree must be
identical to `staging`'s:

```
git rev-parse compact/v1.0.0^{tree}
git rev-parse origin/staging^{tree}
```

must print the same id, and `git diff --exit-code origin/staging
compact/v1.0.0` must print nothing. If either fails, stop: push no
branch and no tag, and report what differed. Nothing in this plan
overrides this rule.

## How the map works

- **Base.** The units go on `main` at `ff6270cf7e08` ("Run staging's
  jobs every fifteen minutes"), the `main` this map was made against.
- **Units are runs.** Each unit is an unbroken run of `staging`'s
  history: from the commit after the previous unit's last commit,
  through its own last commit. The map names each unit's first and
  last commit and how many it holds; `git log --reverse --oneline
  <previous last>..<last>` lists them. The first unit's previous last
  is the base.
- **Why runs, not themes.** The lanes edited the same files (the QA
  plan, the order page, `bin/nff`) in every theme, so replaying the
  commits regrouped by theme conflicted on 900 of the first 1,015, and
  moving only the commits that commute still left 192 pieces, each a
  tree `staging` never had. A run has neither problem: each compacted
  commit's tree is one `staging` really held at the unit's last commit,
  so every commit on `main` builds and could be deployed as it was.
  That is also why a unit is never rebuilt by cherry-picking: its tree
  is taken whole.

Each compacted commit is built from:

- **Tree:** the tree of the unit's last commit.
- **Parent:** the compacted commit before it (the base for unit 1).
- **Message:** the unit's title; a blank line; its body as written
  below (already wrapped at 72); a blank line; the line
  `Compacts <n> commits of staging, <first>..<last>, kept at
  archive/pre-v1.0.0.` (wrapped at 72); then the record-shape
  trailers, if any (below). No other trailer.
- **Author and committer:** both names, emails and dates are the unit's
  last commit's, so main's log dates each unit by when it landed and
  the same map always builds the same hashes. The compacted commits are
  not signed; the signed originals stay under the archive tag.

**Record-shape trailers.** CI's record-shape check
(`bin/check-record-shape.mjs`) reads a range's trailers, and the range
`main..compact/v1.0.0` must pass it as `main..staging` does. For each
unit, list its originals' trailers with

```
git log --reverse \
  --format='%(trailers:key=Record-shape,valueonly,unfold)' \
  <previous last>..<last>
```

Skip the blank lines. Write one `Record-shape: <value>` line for each
distinct value other than `none`, in that order. If every value is
`none`, write one `Record-shape: none`. If the list is empty, write
none. Never copy an
original's body: a line in it that looks like the trailer and is not
fails the check.

## Release day

Run in a fresh clone or worktree. Nothing below pushes before step 5.

1. **Preconditions.** The freeze is on, the #423 QA pass is done and
   the coordinator has approved this plan. `git fetch origin`. Check
   `git rev-parse origin/main` is still `ff6270cf7e08...`; if `main`
   has moved, stop and see "If main moves" below. Note `S`, the full
   hash of `origin/staging`, and `N`, of `origin/next`. Push nothing
   to `next` or `staging` from here to step 7, and ask the lanes to do
   the same.

2. **Check the map against staging.** `git rev-list --count
   origin/main..origin/staging` must equal the map's total (1,028 when
   written). `git log --no-walk=unsorted --format='%h %p'` given every
   unit's first commit, in order, must print each unit's parent as the
   previous unit's last (the base for unit 1). The last unit's last
   commit must be `S`. If `staging` has moved past it, apply "Keeping
   the map current" to this file first, commit that, and start again.

3. **Build.** Set `P` to the base. For each unit in order, with `L` its
   last commit:
   - write its message to a file under `.ignored/`, as above;
   - read L's identity: `git log -1 --format='%an|%ae|%aI|%cn|%ce|%cI'
     L`, and set `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`,
     `GIT_AUTHOR_DATE`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` and
     `GIT_COMMITTER_DATE` from it;
   - `git commit-tree L^{tree} -p P -F <message file>`; it prints the
     new commit, which becomes `P`.

   `commit-tree` writes objects only and runs no hook, which is right
   here: every tree it commits already passed CI on `staging`. After
   the last unit, `git branch compact/v1.0.0 P`. Call it `C`.

4. **Check.** All of these, and stop on any failure:
   - the hard rule above;
   - `git rev-list --count origin/main..compact/v1.0.0` is the number
     of units (68 when written), and `git log --reverse --format=%s
     origin/main..compact/v1.0.0` reads the titles in the map's order;
   - for each unit, `git diff --exit-code <unit's commit in C> <L>`
     prints nothing (spot-check three if pressed for time; the tree
     check covers the end);
   - `node bin/check-record-shape.mjs origin/main compact/v1.0.0`
     passes.

5. **Keep the originals.** `git tag archive/pre-v1.0.0 S`, and when `N`
   differs from `S`, `git tag archive/pre-v1.0.0-next N`. Push the
   tags. The issues, the QA plan and `docs/` quote the old hashes; the
   tags keep every one of them resolvable.

6. **Carry next's own commits.** Only when `N` differs from `S` (it
   should not under the freeze): `git switch -c compact/next N`, `git
   rebase --onto compact/v1.0.0 S`, then `git diff --exit-code N
   compact/next` must print nothing.

7. **Realign next and staging.** James turns off the `fast-forward
   only` ruleset for `next` and `staging` (edits its targets to `main`
   alone, so `main` keeps it). The `required checks` ruleset stays on.
   Then:
   - `git push --force-with-lease=next:N origin compact/v1.0.0:next`,
     and wait for every check `bin/nff promote` requires on `C`
     (`REQUIRED_CHECKS` in `bin/promote.mjs`);
   - `git push --force-with-lease=staging:S origin
     compact/v1.0.0:staging`; the required-checks rule accepts it
     because `C` passed on `next`. Netlify rebuilds staging from the
     same tree;
   - James restores the ruleset's targets, and the window goes in
     `incidents/` as `docs/security.md` asks;
   - with `compact/next`, `git push origin compact/next:next`, now a
     fast-forward.

8. **Promote.** `bin/nff promote main`, unchanged: `C` is a
   fast-forward of `main`. It opens the staging-to-main pull request
   (or finds the open one, whose head is now `C`), release-audit runs
   on it, James labels it LGTM, and the second run fast-forwards
   `main` to `C`.

9. **Tag the release.** `git tag -a v1.0.0 -m "North Foster Farm
   1.0.0" C`, push it, and make the GitHub release. `git log --reverse
   --format='- %s' ff6270cf7e08..v1.0.0` lists the units for its
   notes.

## Keeping the map current

`staging` only moves forward (the rulesets allow nothing else), so the
units written here never change and the map is never regenerated. What
lands on `staging` after the last unit's last commit is appended:

- **By default, to the last unit.** Its last commit moves to the new
  `staging` head and its count grows. This includes the commit that
  updates this file and the freeze's last fixes.
- **As a new unit**, when a batch deserves its own commit on `main` (a
  feature, a fix family, a dependency batch): add a section at the end
  with its title (50 characters or fewer, imperative), body and range.
- **Never into an earlier unit.** A unit must stay a run, or its tree
  stops being one `staging` held.

The coordinator (or whoever runs `bin/nff promote staging`) updates
this file after each promotion, or once at the freeze; step 2 catches
any drift either way. At the freeze, reread the last unit's title and
body against what it now holds, and update the totals in steps 2 and
4.

**If main moves.** `main` only moves by fast-forward to a `staging`
commit. If it must move before the launch, promote it to a unit's last
commit: that unit and every one before it are then on `main` as
originals, so drop them from the map and make the new `main` the base.
A promotion to the middle of a unit splits it at that commit first.

## What it does to the flow

**Promotion.** `bin/nff promote` does not change. Today `main`
fast-forwards to `staging`; after step 8 all three branches stand on
`C`, so later promotions are fast-forwards from there, as before. The
only difference is the one window in step 7.

**Why staging and next are reset, not merged.** Merging `main` back
would add a merge commit, which the linear-history rule refuses, and
the next promotion would carry all the originals into `main` through
it, undoing the compaction. There is no fast-forward from `S` to `C`,
so the two branches are reset onto `C` with a lease, once. They are
reset before `main` moves, so `promote` checks `main` against
`staging` as it always does.

**The pull request into main.** It shows the units as its commits and
the same files changed as before. Its LGTM must come after step 7:
`promote` dates the label against the push that brought `C` to
`staging`, so a label from before the reset does not count.

**v1.0.0.** It goes on `C`, the commit `main` points to, never on `S`.
The archive tags are not releases. `/version.json` and the Square
order tag carry `C`'s hash from the first deploy of `C` on.

**Open lane branches.** A branch made from the old `next` must move
with `git rebase --onto origin/next archive/pre-v1.0.0-next` (or
`archive/pre-v1.0.0` when `N` was `S`). A plain `git rebase
origin/next` would replay the originals. Open pull requests into
`next` move the same way, and no cloud lane runs in the window. The
old `lane/*` branches on origin keep the originals alive too; deleting
them can wait.

**The rulesets (#263, #283).** Neither has a bypass actor, so the
reset needs the `fast-forward only` ruleset off for `next` and
`staging`, and only James can do that. `main` is never force-pushed,
keeps both rulesets throughout, and takes `C` as a fast-forward with
every required check green.

## The map

Base `ff6270cf7e08`. 68 units, 1,028 commits, through `staging` at
`d68af8b1b146` (2026-10-25). Each unit's range is its first and last
commit, inclusive.

### 1. Add the news section and rework the home page

13 commits, `d5d06ddc16a7`..`bca986e747dd`.

```
Moves the past home page updates into a news section with its list,
post and embed templates, and posts the September update. Applies
James's three walkthroughs of the header, hero, home card, About,
policy and 404 pages, and makes Get in touch one statement with the
facts in the footer.
```

### 2. Tune the home bands; charge outside-area fees

11 commits, `ac39a13827d4`..`8399ce5e6005`.

```
Drops the ZIP field's Check button, scales the hero outline, orders
the markets by volume and adds a Shop now band above the footer.
Charges $3 more for a Rhode Island address outside the delivery area
and says so, replaces the share preview, opens the morning pickup
window at nine and invites customers to follow the farm on Instagram.
```

### 3. Give previews their own data; start farm news

6 commits, `aacf76c0ad05`..`497495f8941f`.

```
Gives every non-production deploy its own data, mail and toolbar,
read from SITE_CONTEXT at runtime. Reworks the account settings tab,
adds the farm-news box to the checkout and the sign-up that invites
the old list and syncs the audience.
```

### 4. Take payment on the order page

6 commits, `4024697da81e`..`bd5ec3c85ce4`.

```
Takes payment on the order page itself, serves Square's Apple Pay
domain file and replaces the share card. The CLI reads a per-context
env file and completes a refund when Square reports it done.
```

### 5. Rework the order page and cart from review

14 commits, `6881e1396ce2`..`645ac9c66dab`.

```
Six review passes over the staging checkout: defaults, the hover
menu, field polish, the details column, the cart as an accordion
around its total row, and every way to pay in one grid. Charges no
delivery fee on an empty cart and fixes three checkout defects from
launch QA.
```

### 6. Rework the footer, buttons, hero and About

8 commits, `818ef305f736`..`59ac9f1f6709`.

```
Rewords How to buy for paying on the page, strengthens button hovers,
reworks the footer and its news sign-up, adds a video shortcode for
self-hosted clips and the tight-quarters clip on About, reworks the
hero and shares the egg-spinner button.
```

### 7. Add contact, search, top bar and delivery map

8 commits, `d4b04c2b1cb0`..`d0d5c5828d45`.

```
Adds the contact page, the coop video behind the hero, a top bar for
the next pop-up, product search in the header and the delivery map on
home and the delivery policy. Rescues Venmo payments the page never
finished and shows the three ways to buy outside market season.
```

### 8. Sync PayPal refunds; build news page and map

12 commits, `8c46330dbbed`..`d40045368bb7`.

```
Moves the September update into news and gives the news page years,
pictures and infinite scroll. Finds the capture in PayPal's refund
webhook and repeats PayPal dashboard refunds on Square. Makes the
delivery map clean and interactive, adds eleven ZIPs and drops the
invoice era from the code.
```

### 9. Add the launch QA plan and a Playwright suite

19 commits, `0d987f2b2f3e`..`fc3e607ea964`.

```
Writes the launch QA plan and its Playwright suite, and covers the
checkout fixes, button hovers, footer, hero, About, contact page,
pop-up bar, search, off-season band, Venmo, refunds, delivery map and
news pages.
```

### 10. Retire the paper form; answer contact mail

12 commits, `c59ceedeb8ef`..`bf7d2a365290`.

```
Removes Find my order and the paper order form, says how paying works
now, replaces the favicon with the gingham egg and serves the manifest
as JSON. Keeps an order's payments and refunds as lists, lets the farm
answer a help message by replying, answers the contact form at
/api/contact and shows the cart count on the header's Order link.
```

### 11. Draft the privacy, delivery and a11y policies

9 commits, `1fa9299ec4f3`..`778b15f62156`.

```
Drafts the privacy policy, the delivery policy and the accessibility
statement for launch, shows the dollar sign on the area charge and
gives the About page's markets their seasons. Adds QA checks for the
favicon set, the sign-in link limit, the paper form and llms.txt, and
records the 25 September staging pass.
```

### 12. Fix the second staging pass; add a skip link

21 commits, `5a0f86fb4f4d`..`9e30b46a6f2f`.

```
Fixes what the second staging pass found: item labels, descriptions,
?method= links, the staging token prompt, the quantity box, search
reopening and the map's ZIP check. Sends contact messages for real,
marks fields in error for screen readers, lets readers reach the
map's pins and adds a skip link.
```

### 13. Rebuild the header, hero and directions links

24 commits, `332f971ad3fc`..`ef78b8e14a6c`.

```
Puts the farm's logo in every page's header over a green stripe, lays
the header in a Bootstrap container and veils the hero in black. Adds
the grid check on built pages, Google and Apple Maps directions to the
farm's listing, the split Order button with a cart that checks out,
and an order picker on the contact page.
```

### 14. Sync sign-in across pages; fix the phone cart

17 commits, `6263483654db`..`2fd7522b6c1a`.

```
Shows a sign-in or sign-out on every page at once, keeps a
hover-opened Account menu open on a click and puts Home in the
navigation. Tells a rate-limited contact writer so, calls it the drop
site, lets the open phone cart show more lines and runs staging's
jobs every fifteen minutes.
```

### 15. Let a customer change a paid order

6 commits, `6d8575c6580a`..`169471c4ba3d`.

```
Lets a customer change the items in a paid order, pay the difference
by Venmo, and open the order on the order page to do it. Tells the
customer and the farm about the change and documents it for QA.
```

### 16. Hide Venmo for now; close drop sites Friday

6 commits, `29c21dca0279`..`c21ed6432af2`.

```
Keeps one complete env file per context, hides Venmo behind ?venmo
while VENMO_HIDDEN is set and shows it disabled with Coming soon.
States each drop site's cutoff and closes drop-site orders at the end
of Friday.
```

### 17. Add the staging email library and its reviews

24 commits, `dab6a1822d46`..`30239609b5a8`.

```
Adds an email library to the staging toolbar where emails are
approved and rewritten, reads what Resend sent from bin/nff, and
ports James's reviews. Retries a failed send once, replies to a
customer by name, puts Contact in the header and says in James's
words what a missed or undelivered delivery means.
```

### 18. Build llms.txt; join farm news at once

8 commits, `91138775f702`..`b0144ff179dc`.

```
Applies W5 and W6 to the privacy policy, lets site sign-ups join farm
news at once, builds llms.txt from the site's data, keeps staging out
of search and fills the share tags. Features the newest post atop the
news page.
```

### 19. Tune the hero, map pins and cart on phones

12 commits, `24cee445e39a`..`4e15b6a1df3d`.

```
Raises the hero's contrast on phones, thins the header stripe,
steadies the video button, stacks the map's pins by ZIP, keeps hover
styles off touch screens and reworks the cart's badges, Expand and
Hide toggle and button.
```

### 20. Fit the site to phone browsers

22 commits, `e5457c41ff42`..`ca823d9c78c0`.

```
Brings the specs and QA plan up to the site, stops double taps
zooming, tints the page's ends and the menu backdrop, keeps the top
bar clear of a notch, trims the mini cart and settles the news
sign-up's place and placeholder.
```

### 21. Start the missed-delivery hold; tune posts

24 commits, `4d27be6cd283`..`2da7b0feed06`.

```
Records why a delivery failed, holds a missed delivery seven days
before cancelling it, keeps its fees when due and drafts the
missed-delivery emails. Reworks the September post, signs posts James
and Jim, stops the cart's total row folding the cart and lists each
way to buy by icon on the home page.
```

### 22. Reflow the order page, policies and contact

28 commits, `c17e21ed7cd5`..`0e286da1adb1`.

```
Reflows the order page's steps, groups the mini cart's lines, reworks
search's close and focus, raises muted text to AA, makes the policy's
ZIP card one button, moves the news sign-up and sets the contact page
in a rail and a main column.
```

### 23. Rebuild the header as a navbar; prune media

29 commits, `9e3bd0408410`..`270827a44652`.

```
Rebuilds the header row as a Bootstrap navbar, restores order
breadcrumbs and names the section in view. Reads the policy's numbers
from data, sets the footer in two columns, refunds every cancel,
retires unused media and logo files, credits Lucide, Feather and
Tabler in a NOTICE and removes the phone fields.
```

### 24. Refund every cancel; split the map in two

23 commits, `404f54b00ac4`..`6ebc22fc84e1`.

```
Makes every cancel email a refund notice that says why, welcomes farm
news sign-ups with a one-click unsubscribe, records why a delivery was
missed and stops recording the browser and referrer. Applies the #233
privacy decisions, lists third-party cookies, reshapes the cart and
splits the map into Delivery and Places.
```

### 25. Book pickups from the schedule; rework account

15 commits, `42b4dfb10fb1`..`a05a7f7c93f0`.

```
Books pickups from the farm's schedule and offers its times, catching
a lapsed one. Renames a customer's email from the CLI, shows the
chicken on Account, calls the list farm news everywhere, applies the
T1a cancel wording and reworks the account settings and receipts.
```

### 26. Apply James's copy and #197 decisions

27 commits, `8fd38b5ca342`..`3ad98d055e83`.

```
Lands James's order page lead, missed-delivery fee paragraph, welcome
email and cancel reasons, retires orders deny for cancelling a
pickup, names the top bar and shop band as regions, darkens outline
type to AA and records every media asset's provenance.
```

### 27. Check overflow in WebKit; sweep old sessions

18 commits, `131dd7baedc8`..`9a519d08a6a9`.

```
Runs each market on its own season, floats a bare ZIP field on the
map, tests every page for sideways overflow and runs the layout and
a11y checks in iPhone WebKit. Alerts the farm when a Square refund
fails and sweeps expired sign-in links and sessions.
```

### 28. Read every repeated fact from data/

20 commits, `b6ee62946ccf`..`b169a0ce9e18`.

```
Reads the launch email's facts, the order page's weekdays, the hero's
town, the September post and the farm's name from data/, and fails
the build on a copied fact. Builds every logo from James's vectors,
makes the JSON-LD logo the mark and builds llms.txt from the site
alone.
```

### 29. Walk every page by keyboard; update docs

15 commits, `97bcf1b7fa95`..`ec44292331ee`.

```
Tests the keyboard path through every page and keeps focus clear of
the floating cart and out of folded controls. Brings the order form
doc, the staging doc and the README up to date and reads the pickup
schedule back after setting it.
```

### 30. Run CI in Actions; add alerts and error reports

16 commits, `e0f467bb69dd`..`56ff6353ae41`.

```
Reserves each order id before payment, runs lint and tests in GitHub
Actions, gives every alert kind a guide entry, alerts on uncaught
exceptions and webhook signature failures and rewrites monitoring
around UptimeRobot. Adds fake payment drivers, browser error reports
without personal details and source maps kept in the deploy's own
store.
```

### 31. Add backups, retention and secret rotation

19 commits, `251c46fcaec0`..`596496912751`.

```
Adds the nightly encrypted backup export kept 30 days, lets customers
delete their details and scrubs records after 7 years, and states
retention on the privacy page. Writes down rollback and secret
rotation, keeps staging and previews off Resend's API and swaps the
map and egg icons.
```

### 32. Harden orders and health; recast launch post

15 commits, `4cf6f2a7633b`..`241c843f7d6e`.

```
Records a paid order right whatever follows, fails health when
production is misconfigured, adds a Permissions-Policy header and
keeps the order payload out of the console. Recasts the launch post
as a tour of ordering, adds the Signatures panel and limits pickup
days to next week's Saturday.
```

### 33. Add maintenance mode; prove previews hold none

18 commits, `1e95741580b2`..`6303fce0ce2f`.

```
Adds maintenance mode, enforced on the server, shown on the pages and
run by bin/nff, with an admin let through. Hashes sessions at rest,
runs e2e without a Netlify token, proves previews hold no production
value, commits the three env samples and adds bin/nff env verify.
```

### 34. Swap webhook keys; keep details out of logs

21 commits, `91599b40b86f`..`f22218bd77d3`.

```
Accepts two Square webhook keys during a swap, mutes webhook alerts
per provider, keeps customers' details out of the logs, fails
production that holds a staging key and prints counts only in the
public jobs log. Adds a reviewer key and a signatures library to the
toolbar, reads the Netlify token from the Keychain and adds bin/nff
sessions end-all.
```

### 35. Rework the phone cart's panes

17 commits, `8425acb09a97`..`ebf952e990b6`.

```
Lets the phone cart's two panes take turns, caps them at 55% of the
screen and keeps the discount field above the keyboard. Makes Reset
clear everything, starts the order page with Card chosen and rewords
the contact page.
```

### 36. Rework the map's zoom, pins, towns and Places

11 commits, `b425b44ca595`..`a483fcb1021a`.

```
Puts the zoom inside the map, lets outside-area ZIPs be picked,
brightens and outlines the selected pin's town, tints towns with a pin
and scrolls the places list beside the map. Opens the launch email as
a tour of ordering.
```

### 37. Review the runbooks; check Record-shape in CI

9 commits, `54c2f8ae5600`..`fb7aa7e1a29e`.

```
Revises the rollback runbook and secrets.md after review, adds a
gitignored incidents/ directory, fails CI on record-shape changes with
no trailer, checks the rotation log covers every secret and adds
bin/nff mail test-dev and bin/nff netlify.
```

### 38. Time out, reconcile and guard every order send

16 commits, `41c3d0c64649`..`74f1b9f7a7be`.

```
Times out the order path's outbound calls, keeps earlier attempts'
Venmo checkouts, reconciles with Square before a later attempt pays
and sends order emails after the answer under Resend's
Idempotency-Key. Adds the Resend send breaker and its bin/nff command,
drops the date from news URLs and caps the phone cart pane.
```

### 39. Gate non-production deploys; split notices

12 commits, `703bf89e9401`..`06b553263c5c`.

```
Adds the access gate for non-production deploys with its allowlist
and session commands, opens the toolbar by gate session and passes the
gate in e2e. Splits farm notices three ways, retiring ADMIN_EMAILS,
and closes round 2 of secrets.md and rollback.md.
```

### 40. Pin, audit and CodeQL-scan the supply chain

18 commits, `3c0574b19617`..`48ff833930f5`.

```
Pins packages, Node and the Actions to exact versions, sets a 7-day
cooldown with an attestation check, updates seven packages past
advisories and adds the dependency audit with its exceptions file, in
CI and daily on production. Adds the CodeQL gate and fixes its
findings.
```

### 41. Add bin/nff promote and the security page

17 commits, `cc8801059940`..`c21a7d671a54`.

```
Adds bin/nff promote, fast-forward only, encodes the order page's
mailto address, keys the gate's limit on IP and address, shows
processor detail only off production and adds the security page. Adds
rollback Cases A and B, describes the rulesets and adds the production
audit heartbeat.
```

### 42. Tune the phone cart; build the map redesign

12 commits, `5c3915aa8b70`..`c72fa1f64b29`.

```
Makes the cart's count and total one control, caps the phone cart by
the visible height and teaches the Hide pill. Settles the footer's
spacing and builds rev 2 of the map redesign (#214).
```

### 43. Log consent; add skeletons and dark footer

13 commits, `fd2f86c6fe83`..`f77fbc4e53b5`.

```
Adds the farm silhouette to the footer, logs consent with schema-only
customer fields, adds the list-mail template and welcome draft and
loading skeletons for late regions. Renames eggs and the pack tiers,
fixes rounds 3 and 4 of the order page and cart, builds the final dark
footer and runs one functions server per worktree.
```

### 44. Update tooling; hide sold-out items; CI build

19 commits, `136bc86d3e17`..`7dd52b06fbaa`.

```
Darkens the map's land, updates the CSS build and lint tooling with
its provenance approvals and audit exceptions, guards Get in touch and
the news field, grades eggs Grade A and hides products whose stock
reaches zero. Builds the site and checks its HTML in CI and runs lint
and tests in a pre-commit hook.
```

### 45. Add restock labels and catalog 2026-v9

19 commits, `ce4b2cbc162e`..`6ea90e5281de`.

```
Keeps a paid order's date, adds restock types, labels and the archived
stock alert, sets a one-pound minimum pack, moves SKUs to tenths and
maps old SKUs in Reorder links and saved carts. Fixes Tab order on the
order page and the cart's room at 320px.
```

### 46. Gate main on release-audit; run e2e in CI

14 commits, `89349f0b0b24`..`230058175a5e`.

```
Gates main on release-audit, enforces the Record-shape trailer at the
push and runs the e2e suite in Actions with one pinned Netlify CLI,
fixing the specs the burn-in caught. Compares the staging token in
constant time.
```

### 47. Send the daily packing slips as one PDF

5 commits, `14e3f17ed7da`..`55bf347f8f42`.

```
Sends the daily packing slips as one PDF, packs unpaid orders,
survives a lost send, wraps slip text in linear time and leaves a
change's refund off the slip.
```

### 48. Add the staging clock; clean and inline SVGs

14 commits, `839f4f8a15c3`..`b9ad70ba8543`.

```
Opens the staging toolbar to every session with a clock, session mail
and a test card, and brands the staging sign-in pages. Swaps in the
APPPA lockup, adds the SVG clean-up and its check and inlines every
SVG from a file.
```

### 49. Guard Pay and sends; refuse fulfilled cancels

27 commits, `91994828ae1c`..`33dd320440ea`.

```
Spins the egg on every button that sends, makes Sign in a plain link,
splits Free Delivery into two badges, fits the Pay button and ignores
a second Pay press. Refuses to cancel a fulfilled order, alerts when
an account notice can't reach the farm, unsubscribes quiet accounts
after a year and opens the main pull request when promoting main.
```

### 50. Say an order made an account; tidy the cart

11 commits, `1ce258a69a18`..`21ca87574b08`.

```
Tells the customer when the order made them an account, lists and
answers farm messages from the CLI, says Not available for a product
no longer sold, aligns Pay and the delivery date and hides the cart
when it floats again on the way up.
```

### 51. Add delivery passes; rebuild the toolbar

7 commits, `885ec8d2ec82`..`4ae88fea9de0`.

```
Adds farm-issued delivery passes, standing and fee-waiving, held and
used by compare-and-swap, and says when the total changed under the
customer. Rebuilds the staging toolbar with a section sidebar and
simplifies the sign-in page.
```

### 52. Wrap prose orphans; sell by Square's stock

11 commits, `7dee11476fc6`..`38f3dd327b95`.

```
Keeps the last two words of prose on one line outside tables and
catches a retired phrase split by markup. Says Returning soon where
Add goes, shows Grade A on every egg row, updates a Square order at
its own location and sells by Square's stock count at the farm.
```

### 53. Rework the account page and its menus

11 commits, `f37802d3de0f`..`f8d913560d6e`.

```
Gives phones their own account dropdown, sets the account page with
email on top, reworks the Address and Settings tabs, confirms deletion
in a full-screen dialog, adds Leave us a review and lays out orders
and receipts over rows.
```

### 54. Sweep Square orders and profiles left open

11 commits, `9bfa3df9a48a`..`17fc742d4edd`.

```
Reports and sweeps open Square orders and the profiles a failed
checkout made, once a day at every location, under one deletion kill
switch that pauses at once.
```

### 55. Let customers change their own email

9 commits, `ca20507dff52`..`4b99e862ac24`.

```
Lets customers change their own email, confirmed with a POST, with
approved wording and limits on probes, and takes Aller out of the
emails.
```

### 56. Build one JSON-LD graph; hold the build fresh

8 commits, `11cbbe5e5e9a`..`aa40f61cea1c`.

```
Builds the structured data as one JSON-LD graph with Product and Offer
on the order page, titles every page Page | North Foster Farm,
completes the web manifest and holds the sitemap, llms.txt and
manifest to the build. Asks before bin/nff changes production.
```

### 57. Ask, move or cancel a missed delivery

10 commits, `14036c96dc14`..`c2bff50a8267`.

```
Asks the customer after a missed delivery, moves it to another day or
cancels it when its hold runs out, holds it only once the customer
knows, and closes three gaps in the hold (#193).
```

### 58. Check daily that every refund settled

7 commits, `f50428fd3329`..`0236f035c17a`.

```
Checks daily that every refund settled, never mutes its alerts and
marks a refund failed or stalled once the farm is told. Switches on
the 1 January 2027 prices by date.
```

### 59. Change orders from the CLI; add gh-shot

8 commits, `7be9c58d7ace`..`e53a896a119e`.

```
Changes an order for the customer from the CLI, finishes a pending
edit retried by its key without charging twice, books market pickup,
adds --no-email, and adds bin/gh-shot for screenshots in issues.
```

### 60. Add scheduled pickup and restructure Places

34 commits, `e55c11d9fd5a`..`093c9cad304c`.

```
Models scheduled pickup as series and occurrences, offers it on the
order page and the account, sends confirmed hours to Square and names
it across the site. Restructures Places around locations, gives every
order row one design and fixes the empty mini cart.
```

### 61. Sync the cart across devices; add downloads

16 commits, `97841a5b7753`..`9dc077214625`.

```
Carries a signed-in customer's cart across devices, keeps the videos
setting on the account and downloads order and receipt history as
CSV.
```

### 62. Tag Square orders; fail closed on stock

19 commits, `84205b1085f9`..`c9df9746c857`.

```
Spells canceled and fulfill the US way, flags website orders changed
in Square, completes a fulfilled order there and tags Square orders
with the site version. Shows every region's failure as an alert, fails
closed when stock can't be checked and floats the mid-size cart as a
panel.
```

### 63. Brand and harden the packing slips

7 commits, `953dbf30755f`..`eb410579111a`.

```
Brands the customer's packing slip, sets its payments and totals as a
ledger, previews every slip in the toolbar and hardens the slips
routes.
```

### 64. Apply the walkthrough: home, map, account

20 commits, `9f4eb19646aa`..`6acbcfd57ac6`.

```
Gives outline buttons a white face, trims the home markets block,
moves the farm news sign-up below the footer links, rewrites How to
buy and reworks the mini cart's buttons. Applies the map walkthrough,
shows the customer's chicken in place of Account and reworks the
account forms and wording.
```

### 65. Add cloud lanes; finish slips and the cart rail

16 commits, `3f45345e5d14`..`c70b76a7bdb4`.

```
Lightens the lines outside the delivery area, finishes the packing
slip rules and preview, lands the rail's Cart link after the layout
moves and dispatches cloud lanes to Claude Code in Actions.
```

### 66. Frame Place your order; fix the 404 page

31 commits, `d1010c624c18`..`9e1eb82fc971`.

```
Empties the cart and session mail on reset, frames the contact box,
makes date-bound blocks follow the staging clock, renames the cart's
button Check out and frames the last section as Place your order.
Matches the privacy page to the log scrub, fixes the 404 page and
joins the news pages into one list.
```

### 67. Land the final copy and daily Square check

10 commits, `7e6560dff0be`..`14f05cc77599`.

```
Adds the approved home ways lines and policy wording, rings the
sign-in field, renames the footer sign-up past ad blockers, runs
cloud lanes on Opus, fits the picked town's outline, adds the daily
Square-versus-orders check and tunes the customer emails' words.
```

### 68. Rewrite the site's copy for launch

13 commits, `09a9e42fc42a`..`d68af8b1b146`. The last unit: what lands
on `staging` before the freeze joins it unless it earns its own unit.

```
Rewrites the copy on home, sign-in, account, contact and the news
pages, says "pickup days" on the order page, rewords two account
errors, names what was tried in every rate-limit message, gives the
packing slip the serial comma and the gate label, clarifies the
privacy and delivery policies and uses James's wording in the Shop
band. Sends contact-us links to sales@, runs the whole e2e suite on
staging on demand and bumps fast-uri to 3.1.9, its cooldown waived.
```
