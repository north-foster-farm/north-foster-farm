# ![North Foster Farm](./assets/images/logo-small.png) North Foster Farm

The website for North Foster Farm — [northfosterfarm.com][site]. A
static site built with [Hugo][hugo], styled with Bootstrap 5 and SCSS,
and hosted on [Netlify][netlify].

> [!WARNING]
> **Pushing to `main` deploys the live public site.** There is no
> staging step and no manual approval. Work on a branch, let the
> Netlify deploy preview build, and merge once it is green.

## Prerequisites

- **Hugo 0.164.0, extended.** The extended build is the one that can
  compile SCSS; the standard build cannot. Pinned in `netlify.toml`,
  floored in `config/_default/hugo.toml`.
- **Node 26.** Pinned in `.nvmrc` and as `NODE_VERSION` in
  `netlify.toml`.
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

## Checks

```bash
npm run lint            # both linters
npm run lint:scripts    # ESLint, assets/scripts, netlify, test
npm run lint:styles     # Stylelint, assets/styles
npm test                # node:test, the order form's shared logic
```

Lint and tests gate the deploy — Netlify runs both as part of the
build, so a failure fails the deploy rather than shipping.

## The order form

`/order` is a custom form backed by two Netlify Functions and Square.
`docs/order-form.md` explains the data files, the rules, the recovery
design and what is still needed before launch. Day to day:

```bash
bin/stock                 # flip items in and out of stock, no code edit
npm run start:functions   # netlify dev: Hugo plus /api/* on :8888
```

To check a production build locally:

```bash
npm run lint && hugo --environment production
```

Note what is missing there. **Do not run `npm run deploy` locally** —
it calls `bin/prod`, which installs Dart Sass into `/opt/build/repo`, a
path that exists only on the Netlify build image, so locally it dies at
`mkdir`. Install Dart Sass yourself (`brew install sass/sass/sass`) and
Hugo will find it on `PATH`. If it is absent, Hugo 0.164 stops with
`TOCSS-DART: failed to transform "/styles/main.scss"` instead of
silently falling back to LibSass the way older versions did.

## Layout

```
assets/          SCSS and JS, processed by Hugo Pipes
config/          Hugo config, layered: _default, development, production
content/         Markdown pages
data/            company.yaml, socialMedia.yaml, catalog.json,
                 delivery.json — read via hugo.Data
netlify/         Functions behind /api/* for the order form
test/            node:test suite for the order form's shared logic
layouts/         Templates; partials/ is heavily reused
static/          Copied to the output verbatim
bin/dev          Dev server wrapper
bin/prod         Netlify-only build step (installs Dart Sass)
```

`CLAUDE.md` goes deeper on the architecture — the asset pipeline,
SCSS import order, and where the site's data lives.

## Deployment

Netlify builds `npm run deploy && hugo --gc` and publishes `public/`.
Every pull request gets a deploy preview built the same way production
is, which is the safety net: a bad build fails the preview instead of
the site.

`netlify.toml` holds the build config, redirects, and security headers
(CSP, HSTS, cache policy). It is the source of truth for all three, so
redirects belong there rather than in a `static/_redirects` file.

[site]: https://northfosterfarm.com
[hugo]: https://gohugo.io
[netlify]: https://www.netlify.com
