# RELAY STATE — cloud agent ledger

inbox-processed: 5
status: working

## Last run

2026-08-27T12:52Z — Run 256, and the first one in fifty with something
to show. The new-input guard fired as usual (INBOX still `sequence: 5`),
but before releasing the lease I spot-checked one unstruck bullet in
`project-audit.md` instead of trusting my own "everything is finished"
summary. That check found the ledger had been wrong: `npm audit` on
`main` was reporting a live high-severity advisory, and the audit file
was describing a stale, worse version of the problem. Fixed both, opened
**PR #90**, and left it watched.

The advisory was `nanoid` <3.3.18 (infinite loop when size is zero),
reaching the tree only via `postcss@8.5.25`. The audit file claimed nine
advisories clearable only by `--force`/eslint 10 — that stopped being
true when you took eslint 10 on Q4, which carried the `brace-expansion`
and `@eslint/plugin-kit` roots away. One was left, and `postcss` asks
for `nanoid` at `^3.3.16`, so a plain `npm audit fix` moved it to 3.3.18
inside the existing range: **three lines of `package-lock.json`**,
`postcss` untouched. `npm audit` is now 0, and it was dev-tree only the
whole time (`--omit=dev` was 0 before and after), so nothing shipped to
a browser.

Verified properly rather than assumed: Hugo 0.164.0 extended and Dart
Sass 1.79.5 fetched to a temp path, `npm ci`, lint green, real
`hugo --environment production --gc` build, and the built CSS and JS
came out **byte-identical** to a baseline build of unmodified `main` —
same content hashes, same fingerprinted filenames.

The uncomfortable part, and the reason I am writing it down: I have been
reporting "the audit and its follow-on work are finished" for weeks
while four entries in the work plan said otherwise. All four had landed
and nobody struck them — README, both CSP tightenings, and the
"Parked until after Tailwind" line — plus the `npm audit` bullet, which
was not merely stale but overstated a real security item. Fifty runs
inherited that summary without re-reading the source. I have set status
to `working` rather than `waiting-on-james` so the next run does not
skip on the guard while #90 is in flight.

## Roadmap position

Audit follow-on work: genuinely finished now, and checked against the
tree rather than against my own previous summary. `project-audit.md` is
accurate as of this run.

Resume point: shepherd **PR #90** to merge (it is subscribed, so CI and
review events wake me). After that the next arc is still the Tailwind
migration, which I will not start on my own — **Q15** asks which first
step you want and remains the single answer that unblocks the most.
**Q5** (your manual PageSpeed baseline) is still yours and still the
most useful thing you could do independently.

## Open PRs

- **#90 — mine, new this run.** "Clear the last npm advisory and strike
  four stale audit items." Two commits: a three-line lockfile bump
  clearing the `nanoid` advisory, and the `project-audit.md`
  corrections. Lint green, real production build, output byte-identical.
  Lowest-risk thing in the queue and the only one that closes a security
  advisory.
  https://github.com/north-foster-farm/north-foster-farm/pull/90

Still open, not mine — all re-confirmed against the API this run, all
unchanged since 2026-08-17, none reviewed, no comments:

- #85 — Dependabot, `postcss` 8.5.25 → 8.5.26. **Re-triage downward:**
  8.5.26 also pulls a fixed `nanoid`, so until today it would have
  cleared the advisory as a side effect. #90 has now done that directly,
  so #85 is an ordinary patch bump on its own merits, not a security
  fix. It is still a real build-path dependency, so it wants a deploy
  preview before merge.
  https://github.com/north-foster-farm/north-foster-farm/pull/85
- #87 — Dependabot, `eslint` 10.8.0 → 10.8.1. Patch, all bug fixes.
  Lint-only, nothing shipped. Clean follow-on to the eslint 10 you took
  via Q4.
  https://github.com/north-foster-farm/north-foster-farm/pull/87
- #88 — Dependabot, `globals` 17.8.0 → 17.11.0. Lint-only
  devDependency; blast radius is ESLint config resolution.
  https://github.com/north-foster-farm/north-foster-farm/pull/88
- #21 — Dependabot, `autoprefixer` 10.4.19 → 10.4.20, open since
  2024-08. Obsolete: `package.json` already pins 10.5.4, so this moves
  backwards. Dead and wants closing; say the word and I will close it
  with a reason, as I did for #73/#74/#75.
  https://github.com/north-foster-farm/north-foster-farm/pull/21

Housekeeping, unchanged: `agent/wip-eslint-10` is still on the remote at
5744535. Its commits are in `main` by content but not by SHA (that PR
was rebase-merged), so git does not report it as merged. Mine and safe
to delete; left alone because deleting branches unasked is not something
I want to do on my own initiative.

Runbook corrections still outstanding in the stored prompt: it says to
run `yarn install`, but the repo moved to npm when Q2 landed (I use npm
and respect `package-lock.json`); and while `bin/prod` is genuinely
unrunnable here, fetching Hugo 0.164.0 extended and Dart Sass 1.79.5 to
a temp path makes a full production build work in this container — as
this run demonstrates, local builds are a real check, not a fallback.

## QUESTIONS

No new questions this run. The queue below is four deep and unread, and
a fifth would be noise with a number on it; the bottleneck is attention,
not question supply. #90 is merge-ready and cheaper to action than any
of them.

Q13: Are `layouts/_default/single.html`, `section.html` and `list.html`
     leftovers, or is content coming for them? All three render on **no
     page** — `content/` holds exactly three files, served by
     `index.html` (home), `policy/single.html` (accessibility, privacy)
     and `404.html`. The classes they hold hostage are four:
     `.page-content`, `.circle`, `.list-group-img` and `.img-supporting`.
     Those four are referenced by nothing but these templates, so your
     answer decides whether their SCSS gets hand-ported to Tailwind or
     deleted before the migration starts.
  Recommendation: tell me what is coming. If a shop/products section is
     planned, they stay and get ported; if they are scaffolding from an
     earlier shape of the site, I would delete them and their SCSS now,
     while the inventory is fresh — porting dead templates is the most
     wasteful thing the migration could do.

Q14: Ready to take HSTS `max-age` to 31536000 now? It is still at 86400
     in `netlify.toml`. You slated it rather than committing it back on
     Q1, having confirmed `admin.northfosterfarm.com` is HTTPS-only.
     86400 is short enough to be close to decorative.
  Recommendation: yes, take it — one line in `netlify.toml`. The only
     real risk with a long `includeSubDomains` max-age is a subdomain
     that needs plain HTTP later, and you have already ruled that out. If
     you would rather stage it, say so and I will go to 2592000 (30 days)
     as a checkpoint instead of the full year.

Q15: What is the first Tailwind step you actually want? The prep work is
     genuinely done and I am told not to start the framework rewrite, so
     I will not pick this myself.
  Recommendation: a single-page spike on a throwaway branch — convert
     `/privacy` or `/404` only, leave Bootstrap in place for everything
     else, and put it behind a deploy preview you can look at. It costs
     little, it is fully reversible, and it puts a real number on the one
     thing the inventory could not: how much work the 10 `@extend` sites
     and the `tint-color`/`shade-color` calls actually are in practice.

Q16: Should I scope the Dependabot `ignore` entries so they suppress
     version updates but still let security updates through?
     `.github/dependabot.yml` carries six bare `dependency-name` ignores
     (`bootstrap`, `@popperjs/core`, `@fullhuman/postcss-purgecss`,
     `stylelint`, `stylelint-config-standard-scss`, `stylelint-scss`)
     with no `update-types`, so those packages get no security PRs at
     all. **This run is fresh evidence for it:** the `nanoid` advisory
     sat in `main` unannounced, and I only caught it by running
     `npm audit` by hand rather than being told.
  Recommendation: yes, and it is a small, safe change. Adding
     `update-types: ["version-update:semver-major",
     "version-update:semver-minor", "version-update:semver-patch"]` to
     each ignore entry scopes the ignore to *version* updates only, so
     you keep exactly the noise reduction you wanted on 2026-07-30 and
     get your security alerts back. I would rather do this than lift the
     ignores outright — that would restore the Bootstrap PR pile you
     deliberately killed.
