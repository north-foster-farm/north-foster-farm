# <img src="./assets/images/logo-mark.svg" alt="" height="28"> North Foster Farm

The website for North Foster Farm — [northfosterfarm.com][site]. A
static site built with [Hugo][hugo], styled with Bootstrap 5 and SCSS,
and hosted on [Netlify][netlify].

> [!WARNING]
> **Pushing to `main` deploys the live public site**, with no manual
> approval. Work lands on `next`, which does not build; `staging` is
> fast-forwarded from it for review on its branch deploy
> (`docs/staging.md`), and `main` only after that.

## Prerequisites

- **Hugo 0.164.0, extended.** The extended build is the one that can
  compile SCSS; the standard build cannot. Pinned in `netlify.toml`,
  floored in `config/_default/hugo.toml`.
- **Node 24.22.1.** Pinned in `.nvmrc`, the only pin, which GitHub
  Actions and Netlify read. `npm install` refuses any other Node. On a
  Mac whose system Node differs, mise gives the repo its own (see
  `CLAUDE.md`, Node).
- **npm.** `package-lock.json` is the lockfile. Netlify picks its
  package manager from whichever lockfile it finds, so do not add a
  `yarn.lock`.

Keep Hugo where the pin is. On Homebrew that means `brew pin hugo`
after installing, so a routine `brew upgrade` cannot quietly move local
builds off the version Netlify uses — that gap is what the audit
existed to close.

## Getting started

```bash
npm install
npm start
```

`npm start` runs `bin/dev`, which serves the site at
<http://localhost:1313> with live reload and builds draft, future, and
expired content so unpublished pages are visible.

To reach the dev server from another device on the network — a phone,
mostly — use `npm run start:bind`. It binds to this machine's LAN IP
and expects `northfosterfarm.local` and `www.northfosterfarm.local` in
`/etc/hosts`; it prints the exact lines to add if they are missing.

### Environment files

Each environment has a tracked sample that names its keys:
`.env.development.sample`, `.env.staging.sample` and
`.env.production.sample`. Keep three ignored copies with values, each
complete against its sample: `.env.development`, `.env.staging` and
`.env.production`. There is no `.env.preview`. Link `.env` to the one
you work in, normally development:

```bash
ln -sf .env.development .env
```

`bin/nff` reads `.env` and acts on the `dev-` stores. `bin/nff
--production` and `bin/nff --staging` read their own file and never
`.env`, so reaching production takes the flag, not a relink. `bin/nff
--preview` reaches the deploy previews' stores with `.env.staging`,
since previews use staging's sandbox.

Development needs no `PICKUP_SCHEDULE`: `bin/nff`, `npm test` and
`npm run start:functions` make one up when `.env` has none: weekday
on-farm windows and a `pickup` line for every occurrence of every live
series (`docs/order-form.md`, scheduled pickup). A real one has a line
for each: `<date> <code> pickup|attend|skip [HH:MM-HH:MM]`.

Development needs no payment account: with `SITE_CONTEXT=dev`,
`SQUARE_ENV=fake` and `PAYPAL_ENV=fake`, `npm run start:functions`
takes card and Venmo orders against fake drivers and stub SDKs, and
nothing reaches Square or PayPal. A fake is refused on every other
context. `docs/order-form.md`, "Local development", has the details
and how to opt into a real sandbox instead.

Netlify's variables come from the tracked samples
(`.env.production.sample`, `.env.staging.sample`) and the filled-in
file beside each:

```bash
bin/nff env push --staging    # one env:set per key; never deletes
bin/nff env check --staging   # sample, file and Netlify agree, by name
bin/nff env filled --staging  # offline: the file fills every sample key
```

`filled` needs no Netlify token. It reads the sample and the env file
(`--development`, `--staging` or `--production`; development when none
is given) and fails on a key that is missing or empty. It lists every
such key, missing ones apart from empty ones, each with the sample's
own comment on what it is, and never prints a value. A key whose
comment says `Optional:` may stay empty or out of the file.

With `--append` and the environment named (`bin/nff env filled
--staging --append`), it first adds each *missing* key to the end of
that env file as `KEY=`, under its sample comment and a header like
`# Added by bin/nff env filled --append, 2026-10-26`. It writes no
value, changes no line already there, and leaves empty keys alone. Fill
the values in yourself, then run it again.

`push` sets every key the sample lists except those marked
`# Local only:`, a key left empty in the sample as a secret, and reads
the rest back. `NETLIFY_SITE_ID` is never pushed, and `NETLIFY_AUTH_TOKEN` is in
no env file: it lives in the macOS Keychain. `push` refuses, with nothing
set, when a sample secret is a plain variable on Netlify: `env:set`
can't convert it, so mark it secret in the Netlify UI or unset it
first. `check` also fails on a value attached to `all` or to every
branch deploy, or kept out of the builds scope, and prints names
only. Every Netlify build runs `npm run check:env`, which fails when a
key the context's sample lists is missing; a layout slip in the
sample only warns.

### Tab completion

`bin/nff` completes its commands, actions, flags and file arguments
(a CSV, a schedule file, `--file`, `--out`) in zsh and bash, as
`bin/nff`, `./bin/nff` or `nff`. The script is built from the usage text
`bin/nff` prints, so a command added there is completed with nothing
more to do. One line in `~/.zshrc`, after `compinit`, with the path to
your checkout:

```bash
source <(/path/to/north-foster-farm/bin/nff completion zsh)
```

In bash, in `~/.bashrc`:

```bash
source <(/path/to/north-foster-farm/bin/nff completion bash)
```

That runs node once at every shell start, about a tenth of a second. To
skip it, write the script to a file and source the file, and write it
again after the commands change:

```bash
bin/nff completion zsh > ~/.nff-completion.zsh
source ~/.nff-completion.zsh
```

The script prints nothing else, so sourcing it never shows a message.

## Checks

```bash
npm run check           # lint, then the tests
npm run lint            # both linters
npm run lint:scripts    # ESLint, assets/scripts, netlify, test
npm run lint:styles     # Stylelint, assets/styles
npm test                # node:test: functions, CLI and build checks
npm run check:signatures              # registry signatures, as CI
npm run check:record-shape -- origin/next   # trailers since next
```

`npm install` points git at `.githooks/`. Its pre-commit hook runs
`npm run check`; its pre-push hook refuses commits that touch record
shape without a `Record-shape:` trailer (`docs/rollback.md`).
`--no-verify` skips either; CI does not.

GitHub Actions runs lint and the tests as the `lint-and-test` check
(`.github/workflows/ci.yml`) on every pull request, on every push to
`next`, `staging` and `main`, and on demand. Branch protection on
`staging` and `main` requires it, so a branch moves only to a commit
that has already passed. The run holds no secret: each step runs under
`env -i`, and `test/setup.mjs` keeps only an allowlist of variables
and makes fetch, sockets and DNS throw for any host but this machine.
A test that would reach a real service fails.

The Netlify build runs no tests. It checks that the deploy's
environment has every key (`npm run check:env`) and the pickup
schedule (`npm run check:schedule`), builds, and holds the built HTML
to Bootstrap's grid (`npm run check:grid`) and the news posts' titles
and URLs (`npm run check:news`). CI's `build` check runs the same
Hugo build, grid and news checks on every push, as production and as
staging builds, so a template error shows on the commit before a
deploy fails.

Every fact the site repeats (prices, fees, hours, addresses, the
farm's name) has one source in `data/` or site config, and templates
read it through a partial or shortcode. `npm test` runs
`bin/facts/check.mjs`, which fails on a literal copy of a known value
outside its source; `node bin/facts/check.mjs` lists them.

## The order form

`/order` is a custom form backed by Netlify Functions and Square.
`docs/order-form.md` explains the data files, the rules, the recovery
design and what is still needed before launch. Day to day:

```bash
bin/stock                 # flip items in and out of stock, no code edit
npm run start:functions   # netlify dev: Hugo plus /api/* on :8888
```

To run one per worktree at once, give each its own port:
`npm run start:functions -- --port 8891`. `docs/order-form.md`, "Local
development", has the details.

To check a production build locally:

```bash
npm run lint && hugo --environment production
```

Note what is missing there. **Do not run `bin/prod` locally**: it
installs Dart Sass into `/opt/build/repo`, a path that exists only on
the Netlify build image, so locally it dies at `mkdir`. Install Dart
Sass yourself (`brew install sass/sass/sass`) and Hugo will find it on
`PATH`. If it is absent, Hugo 0.164 stops with
`TOCSS-DART: failed to transform "/styles/main.scss"` instead of
silently falling back to LibSass the way older versions did.

## Layout

```
assets/          SCSS and JS, processed by Hugo Pipes
config/          Hugo config, layered: _default, development, production
content/         Markdown pages
data/            One source per fact: company, catalog, delivery,
                 markets, accounts and more — read via hugo.Data
netlify/         Functions behind /api/*: orders, accounts, news
test/            node:test suite for the functions and checks
e2e/             Playwright suite, run against staging
layouts/         Templates; partials/ is heavily reused.
                 index.llms.txt builds /llms.txt from the content
static/          Copied to the output verbatim
bin/dev          Dev server wrapper
bin/nff          The farm's CLI: orders, refunds, customers, jobs
bin/prod         Netlify-only build step (installs Dart Sass)
```

`CLAUDE.md` goes deeper on the architecture — the asset pipeline,
SCSS import order, and where the site's data lives.

## Deployment

Netlify builds `npm run check:env && npm run check:schedule &&
bin/prod && HUGO_BUILD_SHA=$COMMIT_REF hugo --gc && npm run
check:grid` and publishes `public/`, after the local build plugin
`plugins/source-maps` has moved the source maps into Blobs. Branch deploys add
Hugo's draft, future and expired flags.

Work lands on `next`, which does not build. Promotion is a
fast-forward push, never a merge: `staging` moves to a `next` commit
that passed `lint-and-test`, and `main` to a `staging` commit that has
been reviewed (`docs/staging.md`). The `LGTM` label merges only pull
requests into `next`: it waits for the check on the labeled head,
rebase-merges that exact head, then runs `ci.yml` on `next`, since the
rebased commits are new. A pull request into `staging` or `main` is
refused; those branches move only by fast-forward.

`netlify.toml` holds the build config, redirects, and security headers
(CSP, HSTS, cache policy). It is the source of truth for all three, so
redirects belong there rather than in a `static/_redirects` file.

[site]: https://northfosterfarm.com
[hugo]: https://gohugo.io
[netlify]: https://www.netlify.com
