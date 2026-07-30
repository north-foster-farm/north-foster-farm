# north-foster-farm — project audit guide (drafted 2026-07-30)

The public Hugo site's version of the dashboard's housekeeping arc,
scaled way down. One or two sessions, not six phases. The center of
gravity is different too: this repo's risk is not cruft or data
safety — it is **toolchain drift** between the machine, the repo's
pins, and the Netlify build image. The audit's job is to measure
that drift, close it, and leave both configs pinned and matching.

**Follow-up on deck:** once the audit lands and the site builds
clean on a current, matched toolchain, the next arc is a migration
from Bootstrap 5 + SCSS to **Tailwind** (aligning the site with the
dashboard's stack and the shared design language). The audit should
therefore prefer fixes that make that migration easier and skip any
deep investment in the SCSS pipeline beyond keeping it working.

## Facts measured 2026-07-30 (verify before acting — drift is the
## whole point of this audit)

- **Hugo: local 0.162.0-extended (Homebrew) vs Netlify pinned
  `HUGO_VERSION = "0.135.0"`** (netlify.toml). 27 minor versions of
  drift — local dev and prod builds are not running the same
  renderer. `config/_default/hugo.toml` sets only a floor
  (`module.hugoVersion.min = "0.126.0"`, extended).
- **Node: local v26.4.0; Netlify has NO Node pin at all** — no
  `NODE_VERSION` in netlify.toml, no `.nvmrc` / `.node-version`
  file. Prod builds run whatever the Netlify image defaults to.
- **Package manager: yarn 1.x classic** (`yarn.lock`, yarn 1.22.22
  local; build command is `yarn deploy && hugo --gc`).
- **netlify.toml declares `[functions] directory = "lambdas"` but
  no `lambdas/` directory exists** in the repo — dead config from a
  removed serverless experiment (`start:serverless` script and
  `node-fetch`/`sanitize-html` deps look like the same era).
- Working tree: 5 untracked images (2 icons, 3 `_med.jpg` photos) —
  either wire them into content and commit, or delete.
- Hygiene that is already right: `public/`, `resources/`,
  `node_modules/`, `*.bak` are gitignored; lint (eslint 9 flat +
  stylelint SCSS) is wired into `yarn deploy`; CSP and cache
  headers exist in netlify.toml.

## Ground rules

- Same session pattern as the dashboard arc: end every chunk by
  overwriting a `RESUME`-style note (this repo can use a short
  `## Status` section at the bottom of this file instead of a
  separate untracked file).
- Commits are small, one concern each; ask before pushing — the
  repo auto-deploys northfosterfarm.com on push to main.
- **Verify each claimed version live** (`hugo version`,
  `node --version`, the Netlify UI's build image + env) before
  changing a pin. The numbers above are a snapshot, not gospel.
- Prod is a static site: the blast radius of a bad build is a
  failed deploy, not data loss. No backup protocol needed. Deploy
  previews are the safety net — use a branch + preview for the
  toolchain bumps.

## A1 — toolchain parity (the main event)

Goal: local and Netlify build the site with the SAME Hugo and Node,
both current, both pinned in exactly one place each.

1. Pick the target Hugo: current local (0.162.0-extended) or newer
   stable if Homebrew has moved. Read the Hugo release notes for
   breaking changes between 0.135.0 and the target — 27 minors WILL
   contain deprecations (likely suspects: template functions,
   image processing defaults, Goldmark config).
2. Build locally at the target (`bin/dev` / `bin/prod`), fix every
   warning and error. `hugo --printPathWarnings --printUnusedTemplates`
   is worth a run while at it.
3. Update the pins together, one commit:
   - `netlify.toml` → `HUGO_VERSION = "<target>"`
   - `config/_default/hugo.toml` → raise `module.hugoVersion.min`
     to the target (the floor should mean something)
   - Add a `NODE_VERSION` under `[build.environment]` AND a
     `.nvmrc` with the same value. Target the current LTS Netlify
     supports — do NOT assume local v26 is buildable there; check
     Netlify's supported-versions doc first. Local can stay newer
     than the pin only if the build is proven on the pinned one
     (`nvm use` before `bin/prod` to prove it).
4. Verify via deploy preview (branch push), then land on main and
   confirm the production deploy log shows the pinned versions.
5. System side: note the Homebrew story for THIS machine — how hugo
   updates (`brew upgrade hugo` is unpinned; decide whether that is
   fine given the netlify.toml pin is authoritative, or whether to
   `brew pin hugo`). Record the decision here.

## A2 — Netlify host config review

Walk netlify.toml AND the Netlify UI settings (the UI can override
or supplement the file — check both):

- Delete the dead `[functions] directory = "lambdas"` block (and
  decide the fate of `start:serverless`, `node-fetch`,
  `sanitize-html` — if the lambdas experiment is dead, the no-legacy
  rule says all of it goes).
- Redirects: confirm each target is still live (admin/dashboard →
  admin.northfosterfarm.com, venmo). Add any missing ones.
- Headers: sanity-check the CSP against what the site actually
  loads today (YouTube frame, inline scripts/styles). Note that the
  Tailwind migration will need `style-src` revisited.
- Confirm build command, publish dir, and deploy contexts still
  describe reality; confirm no orphaned env vars in the UI.
- Check the deploy notification / build-hook settings while in the
  UI (nothing in-repo covers them).

## A3 — dependencies & repo hygiene (small)

- `yarn outdated` (or migrate to npm while at it — one lockfile
  world, and the dashboard repo is npm; decide, don't drift). Only
  chase majors that block the Tailwind migration or carry
  advisories; Bootstrap/@popperjs are scheduled for deletion in the
  migration, so do NOT invest in bumping them.
- eslint/stylelint: bump within-range, keep green. The stylelint
  SCSS stack also retires with the migration — patch, don't polish.
- Resolve the 5 untracked images (commit into content or delete).
- Check `bin/dev` / `bin/prod` for hardcoded paths or flags that
  fight the new Hugo version.
- README: one pass to make sure setup instructions state the pinned
  versions and the one-command dev loop.

## A4 — build & content sanity (quick pass)

- Full clean build: delete `public/` + `resources/`, run `bin/prod`,
  eyeball the diff-able output size and the build time.
- Grep content for dead absolute URLs (old domains, http://).
- Lighthouse or PageSpeed once, recorded here as the pre-Tailwind
  baseline — the migration should not regress it.

## Exit criteria

- One Hugo version, one Node version, each pinned in netlify.toml
  (+ `.nvmrc`), matching what the local machine actually runs, with
  a green production deploy proving it.
- Dead config gone (lambdas block, serverless remnants) or a
  recorded decision to keep it.
- Clean `git status`, lint green, this file's `## Status` section
  says "audit complete — ready for the Tailwind migration".

## Status

**Survey complete, no changes made yet (2026-07-30).** All "Facts
measured" re-verified as accurate. Toolchain target decided; awaiting
go-ahead to start committing.

### Verified this session

- Local: hugo 0.162.0+extended (Homebrew), node v26.4.0 (Homebrew),
  yarn 1.22.22, npm 11.17.0. **No node version manager installed**
  (no nvm/fnm/volta/n) — so "nvm use before bin/prod" is not
  available without adding one.
- Netlify build image is Ubuntu 24.04, Node default 24; any Node
  version nvm can install is pinnable. Hugo pinnable to any release.
- `lambdas/` confirmed absent. 5 untracked images confirmed
  referenced by nothing.
- Latest Hugo release is **0.164.0**. Homebrew is one behind at
  0.162.0.

### The renderer-drift experiment (the key safety result)

Built the *unmodified* working tree with three throwaway Hugo
binaries in a scratch dir — **nothing installed to the machine** —
and diffed the output:

| Compared | Result |
|---|---|
| CSS (`styles/main.*.css`) | **byte-identical** 0.135 vs 0.162 vs 0.164 |
| HTML | identical except the `generator` meta tag and image filenames |
| JS bundle | +222 bytes (82827 → 83049); esbuild minifier revision only, same source |
| WebP images | re-encoded by libwebp 1.6.0, ±1% size; filename hash scheme changed in 0.142 |
| sitemap.xml | **0.162 emits a leading blank line before `<?xml`** (invalid XML). 0.164 does not — 0.164's sitemap is byte-identical to 0.135's |

Conclusion: the 27-minor jump is very nearly a no-op for this site,
and the SCSS pipeline in particular is provably unaffected.

### Decisions

- **Hugo target: 0.164.0**, not 0.162.0 — 0.162 has the sitemap
  regression above; 0.164 fixes it. Requires `brew upgrade hugo`
  locally (0.162 → 0.164), then `brew pin hugo` so a future
  `brew upgrade` cannot move it out from under the netlify.toml pin.
- **Node target: 26** (`NODE_VERSION` + `.nvmrc`), matching local
  Homebrew node exactly. Netlify installs it via nvm. Node 26
  becomes Active LTS in Oct 2026.
- **Do NOT touch the Dart Sass pin** (`bin/prod:15`, 1.79.5) or any
  SCSS/Bootstrap dependency. The whole SCSS stack is deleted by the
  Tailwind migration; the CSS output is already proven identical.

### Two real deprecation warnings at the target (both WARN, not fatal)

1. `config/_default/hugo.toml:5` — `languageCode` → `locale`
   (deprecated v0.158.0).
2. `.Site.Data` → `hugo.Data` (deprecated v0.156.0), 9 call sites:
   `layouts/index.html:3`, `partials/phone.html:1-2`,
   `partials/contact-card.html:12`, `partials/home/contact.html:1`,
   `partials/address.html:1-4`, `partials/head/schema.html:9`,
   `partials/social-media.html:3`, `partials/home/copy.html:56`.
   Adopting `hugo.Data` forces `module.hugoVersion.min >= 0.156.0`.

Also: `disableKinds = ["RSS", ...]` at `hugo.toml:2` should be
lowercased to `"rss"`.

### Latent trap found (worth fixing regardless)

If `dart-sass` is missing from PATH, Hugo **silently falls back to
LibSass** — no warning at all — despite
`layouts/partials/head/styles.html:2` asking for `dartsass`. Proven
by building with a stripped PATH: build succeeded, `hugo env` then
reported only `libsass`, and all Dart Sass deprecation warnings
vanished. LibSass is deprecated as of Hugo v0.153.0 and will be
removed, at which point this silent fallback becomes a hard build
failure. `bin/prod`'s Dart Sass install block is therefore load-
bearing on Netlify and must stay.

### Highest-severity findings from the sub-audits

- **`bin/prod` cannot run on this Mac.** `bin/prod:14` hardcodes
  `BIN_DIR=/opt/build/repo/node_modules/.bin` (a Netlify-only path)
  and `:18` downloads a **linux-x64** Sass tarball with no OS
  detection. `npm run deploy` dies at `mkdir` with permission
  denied. Needs a `$NETLIFY` guard.
- **`@eslint/js` is used by `eslint.config.js:1` but is not in
  `package.json`.** It resolves only via yarn 1 hoisting. Any
  hoisting change breaks `yarn lint`, and lint gates the deploy.
- **HTML is cached 24h** (`netlify.toml:43-46` applies
  `max-age=86400` to `/*`). Content updates can take a day to reach
  a returning visitor. Fingerprinted assets are simultaneously
  *under*-cached. Needs a split.
- HSTS `max-age` is 86400 (one day) — near-useless.
- `Access-Control-Allow-Origin = "*"` on `/*` with nothing needing
  CORS.
- Dead: `[functions]` block, `start:serverless`, `bin/dev:65-82`,
  `node-fetch`, `sanitize-html`, `@popperjs/core` (Collapse needs no
  Popper), `layouts/partials/contact-form.html` (referenced by
  nothing, no JS submits it), the unused YouTube vars at
  `partials/home/copy.html:1,50-55` and the `frame-src` CSP grant
  they justify.
- `content/privacy.md:20` describes web-form collection that no
  longer happens once the orphaned form partial goes.
- Redirects live in **two** places: `netlify.toml` and
  `static/_redirects` (`/privacy-policy` → `/privacy`). All four
  targets verified live.
- `.claude/settings.local.json` is tracked and should not be.
- `public.bak/` + `public-20241109.bak/` = 14.6 MB of stale output.

### Work landed so far — branch `audit/toolchain-parity`

Five commits, none pushed. All verified against the **currently
pinned Hugo 0.135**, so every one of them is safe to deploy before
the version bump:

1. `Declare @eslint/js as an explicit devDependency`
2. `Make bin/prod runnable outside Netlify`
3. `Remove the dead Netlify Functions experiment`
4. `Remove dead YouTube embed references`
5. `Stop tracking personal Claude Code settings`

Build output vs. the pre-audit 0.135 baseline differs in exactly two
places, both intended: two blank lines gone from `index.html` (the
deleted YouTube vars) and the rewritten privacy paragraph. CSS and
JS are byte-identical. Lint clean.

Also deleted (untracked, reproducible): the 5 unused images,
`public.bak/` and `public-20241109.bak/` (14.6 MB).

### Corrections to the sub-audit findings

- **`@popperjs/core` is NOT dead — do not remove it.** An audit pass
  called it unused because nothing imports it directly, but
  `node_modules/bootstrap/dist/js/bootstrap.esm.min.js` begins with
  `import * as Popper from "@popperjs/core"`, so esbuild resolves and
  bundles it. Removing it breaks `js.Build`. (Confirmed by finding
  Popper's `applyStyles`/`arrow`/`basePlacements` in the built
  bundle.) Only `node-fetch` and `sanitize-html` were genuinely dead.
- **Step ordering had to change.** The plan put the Hugo deprecation
  fixes before the pin bump. They cannot go first: `hugo.Data` does
  not exist until 0.156 and hard-errors on 0.135 (`can't evaluate
  field Data in type interface {}`), and `locale` is not read until
  0.158. Both fixes must land **with or after** the pin bump, in the
  same commit or later.

### A1 — toolchain parity: DONE locally, not yet pushed

`Pin Hugo 0.164.0 and Node 26 across local and Netlify` +
`Update CLAUDE.md for the pinned toolchain`.

- Homebrew hugo upgraded 0.162.0 → **0.164.0** and **`brew pin`ned**,
  so a routine `brew upgrade` can no longer drift off the pin. Undo
  with `brew unpin hugo` if that ever becomes annoying.
- `netlify.toml`: `HUGO_VERSION = "0.164.0"`, `NODE_VERSION = "26"`.
- `.nvmrc`: `26`. Node 26 matches local Homebrew node exactly.
- `config/_default/hugo.toml`: `hugoVersion.min = "0.164.0"`.

Deprecations cleared (all required the newer Hugo, which is why they
could not land before the bump): `.Site.Data` → `hugo.Data` ×9,
`languageCode` → `locale`, `disableKinds` lowercased,
`imaging.quality` → per-format `imaging.{jpeg,webp,avif}.quality`.

**Left deliberately:** `resources.PostProcess` → `templates.Defer`
(deprecated v0.164.0, INFO level). It drives the PurgeCSS pass, which
the Tailwind migration deletes outright. Revisit only if it reaches
WARN before that migration lands.

Verification: same tree built on 0.135 and 0.164, then diffed.
**CSS byte-identical. sitemap.xml byte-identical. All four HTML pages
identical** once the generator string and content hashes are
normalised. Only the JS bundle (+222 B, newer esbuild minifier) and
the WebP files (libwebp 1.6.0 re-encode) differ. The
`imaging.quality` split changes image *filenames* (cache key) but the
image *bytes* are unchanged. `npm run deploy && hugo --gc` succeeds
from an empty `public/` and `resources/`. Lint clean.

### Next step — awaiting go-ahead to push

Push `audit/toolchain-parity`, confirm the deploy preview is green
and its build log reports Hugo 0.164.0 and Node 26, then squash as
needed, rebase, fast-forward main, and delete the branch. Nothing has
been pushed yet.

### Scope decision (2026-07-30) — audit cut short on purpose

The Tailwind migration is the next thing to happen to this repo, and
most of the remaining audit backlog churns again the moment it lands.
So the audit stops here rather than running A2–A4 to completion. What
was kept is what makes the migration *safer or simpler*; everything
else is parked.

**Reverted: the `bin/prod` rewrite.** `bin/prod` exists to install
Dart Sass on the Netlify image. It was never meant to run on a
developer machine, and it never broke production. More to the point,
Tailwind v4 does not use Dart Sass, so the whole install block —
version pin, LibSass fallback check and all — gets deleted by the
migration. Investing in it was exactly the "deep investment in the
SCSS pipeline" this guide said to skip. The commit was dropped from
the branch; `bin/prod` is untouched.

The real defect there was a docs mismatch, not a script bug:
`CLAUDE.md` listed `npm run deploy` under Development Commands even
though it cannot work locally. Fixed in the docs instead, which is
the cheaper end to fix.

**Why the pin bump was still worth doing first.** The migration
rewrites the asset pipeline — `css.Sass` out, a Tailwind step in,
PurgeCSS and the `hugo_stats.json` mount deleted. That is precisely
where a renderer gap between local and prod would surface. Closing
it beforehand means any breakage during the surgery has one cause
rather than two, and the byte-level baseline above was captured
while the pipeline was still known-good — which is not something
that can be recovered once cutting starts.

**Parked until after Tailwind:** README rewrite, npm-vs-yarn,
dependency bumps, and the `script-src` / `style-src` tightening. All
of them get redone post-migration.

### Remaining (A2–A4)

- ~~`Cache-Control` split~~ **DONE.** HTML was served with
  `max-age=86400`, so a content update could take a full day to
  reach a returning visitor. Now `max-age=0, must-revalidate` on
  `/*` (Netlify sends strong ETags, so this is a 304, not a
  re-download); `/styles/*` and `/scripts/*` are content-hashed by
  Hugo and go to a year `immutable`; `/fonts/*`, `/images/*` and
  `/favicons/*` get a week, revalidatable, because they are NOT
  fingerprinted (`/images/` mixes Hugo derivatives with
  pass-through originals like `chickens.jpg`).
- Still open: HSTS `max-age` 86400 → 31536000 (confirm
  `admin.northfosterfarm.com` is HTTPS-only first, since
  `includeSubDomains` is set), and drop
  `Access-Control-Allow-Origin = "*"` — nothing on the site needs
  CORS. Both are one-liners, neither is migration-blocking.
- `script-src` / `style-src` tightening: parked, see above.
- Fold `static/_redirects` (`/privacy-policy` → `/privacy`) into
  `netlify.toml` so redirects live in one file.
- `/order-form.pdf` is deployed but linked from nowhere — wire it up
  or drop it.
- npm-vs-yarn decision (dashboard repo is npm; this is yarn 1, which
  is EOL). Change surface is small: `yarn.lock`, three `command =`
  lines in `netlify.toml`, two lines in `CLAUDE.md`.
- Dependency bumps worth taking: `postcss` 8.4.47 → 8.5.25,
  `postcss-cli` 11.0.0 → 11.0.1, `autoprefixer` 10.4.20 → 10.5.4.
  Deliberately NOT bumping bootstrap / stylelint* / purgecss — all
  retire with the Tailwind migration.
- Dependabot is opening PRs nobody merges; add an `ignore:` block for
  the retiring packages or set `open-pull-requests-limit: 0`.
- README rewrite — it is a 3-line stub with no versions, no
  prerequisites, no commands, and no mention that pushing to main
  auto-deploys production.
- A4 — Lighthouse/PageSpeed baseline, recorded here pre-Tailwind.
- **Netlify UI checklist (needs you, nothing in-repo covers it):**
  orphaned env vars from the lambdas era, build image / any UI-set
  Node version, leftover Functions or Forms state, build hooks,
  deploy notifications, and confirming `admin.northfosterfarm.com` is
  HTTPS-only before extending HSTS `includeSubDomains` to a year.
