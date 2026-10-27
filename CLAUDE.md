# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

North Foster Farm website - a static site built with Hugo (v0.164.0) and hosted on Netlify. The site uses Bootstrap 5.3.3, custom SCSS styling, and vanilla JavaScript with ES modules.

## Working rules for agents (James, 2026-10-25)

These apply to every lane, cloud run and the coordinator. They come from
decisions James made on GitHub. The issue numbers point to the source.

- **Fix stale notes on sight.** When James corrects something, or the
  code, a tool or production contradicts a note (a CLAUDE.md, a doc,
  an issue body, a handoff, a rotation log), fix the note then and
  there: rewrite or delete the stale line, date the change, and say in
  one sentence what changed. Never work around stale information.
  Older notes still called the release a draft after it shipped on
  2026-10-26 (#494).
- **Do small work, don't file it.** If a fix can be done, checked and
  landed in about 15 minutes, do it in the change you're making, or
  batch it with others in the same area. Don't open an issue for a
  follow-up smaller than the fix itself. #372 is the example of what not
  to do.
- **Keep the open issues honest.** Close what is done or superseded as
  soon as you notice it. Steps only James can take go on #237, his
  checklist, not into issues of their own. #303 is the one ordered
  queue.
- **Work has landed when it is on `next`.** Approved PRs are squashed
  onto `next` and closed, so GitHub shows them as "closed", not
  "merged". Check `next`'s history before calling anything stalled.
- **e2e:** Claude cloud runs (`.github/workflows/claude.yml`) have no
  browser, so never ask one to run Playwright. The suite runs in GitHub
  Actions through `e2e.yml` and `e2e-run.yml` (a local build with fake
  payments), or on James's Mac. Specs that need real staging or a real
  phone are hands-on checks for James (#449).
- **Customer copy follows the #400 house rules:**
  - no semicolons and no em dashes in prose;
  - no internal model names in customer text ("Pickup days", not
    "scheduled pickup");
  - "email address" when it means the address;
  - drop sites are plural and unnamed unless the line is about one site;
  - every rate-limit message names what was tried;
  - an approved wording applies everywhere the same text appears;
  - step-by-step instructions only for what the reader may not know
    how to do, never for the obvious ("choose, say how you want it,
    pay") just to fill space (#303, 2026-10-26).
- **Contact links go to sales@** (`company.email`). info@ is
  deliberately less public (#410).
- **Fakes return recorded responses.** A fake or stub for a network
  service returns a fixture recorded from a real request (the sandbox
  will do), with secrets scrubbed but the real shape kept. Never a
  hand-written response object. Note the source and date with it
  (James, 2026-10-26).
- **Confirm dates before production.** Any change to a news post, or to
  a page with a "Last updated" line, has its date confirmed before it
  ships. The right date is often not the commit date.
- **Log every production change** (#497, 2026-10-27; the full rule is
  in `docs/security.md`):
  - **Log:** every change to a production record made by a person or
    the CLI. Each line records the time, who acted (CLI, farm, host or
    customer), the action, the target, and the values before and
    after. Money and membership changes are always logged.
  - **Don't log:** reads, `--dry-run` and previews, scheduled jobs that
    changed nothing, and anything on staging or development unless
    it's needed for debugging.
  - **Never in a log:** secrets or tokens, payment details, or a full
    email address, phone number or street address. Mask addresses as
    in #496, keeping the first three and last three characters of
    each part.
  - **Log records are append-only** and follow the retention rules for
    customer data.
  - Any new command or action that changes production records ships
    with its log line and a test, as part of the definition of done.
- **This repo and its branches are public.** No customer data, no
  credentials, and no full names of James's family members in code,
  issues, comments or screenshots.

## Development Commands

Env files: `.env.development.sample`, `.env.staging.sample` and
`.env.production.sample` (tracked) name each environment's keys.
`.env.development`, `.env.staging` and `.env.production` (ignored)
each hold all of their sample's keys; `.env` is a symlink to
`.env.development`. `bin/nff` reads `.env`; `--production` and
`--staging` read their own file only, and `--preview` reads
`.env.staging` (there is no `.env.preview`). Never read, print or copy
any of the ignored ones.

```bash
# Install dependencies (npm, not yarn -- package-lock.json is the
# lockfile and Netlify picks its package manager from it)
npm install

# Start local development server (default)
npm start
# or: bin/dev

# Start server bound to local IP (requires /etc/hosts configuration)
npm run start:bind

# Run linters
npm run lint                # All linters
npm run lint:scripts        # ESLint for JS files
npm run lint:styles         # Stylelint for SCSS

# Lint and the unit tests; CI runs the same as `lint-and-test`, and
# the pre-commit hook in .githooks/ (set up by `npm install`) runs it
# before every commit
npm run check

# Production build. NETLIFY ONLY -- do not run this locally.
# bin/prod installs Dart Sass into /opt/build/repo, a path that only
# exists on the Netlify build image, so this fails on a dev machine.
# Netlify runs it via `bin/prod && hugo --gc`; it runs no tests.
bin/prod
```

To check a production build locally, run the linters and then
`hugo --environment production` directly, skipping `bin/prod`.

### Screenshots in issues and comments

`gh` can't attach images, so `bin/gh-shot [--issue N] FILE...` uploads
them to the `screenshots` branch (no shared history with `main`, never
merged or deployed) and prints a markdown line for each to paste into
`gh issue comment --body` or a body file. `--repo
north-foster-farm/nff-dashboard` posts to the dashboard's branch. The
branch is public and permanent: mockups and development or staging
screens only, never customer data or production.

### Development Server Modes

The `bin/dev` script supports two modes via environment variables:
- **Default**: Standard Hugo server on localhost:1313, or on
  `HUGO_PORT`. `npm run start:functions -- --port <port>` picks a free
  one, so one can run per worktree (`docs/order-form.md`)
- **`HUGO_BIND_TO_IP=true`**: Binds to local network IP (requires /etc/hosts entries for `northfosterfarm.local`)

## Architecture

### Hugo Configuration

Configuration is environment-specific using Hugo's layered config system:
- `config/_default/hugo.toml` - Base configuration
- `config/development/hugo.toml` - Dev overrides (title prefix)
- `config/production/hugo.toml` - Production settings (baseURL)

Key Hugo settings:
- Uses Hugo Pipes for asset processing
- Mounts `hugo_stats.json` to assets for PurgeCSS
- Requires extended Hugo >= 0.164.0
- Timezone: America/New_York

### Directory Structure

```
assets/
  images/          # Image assets processed by Hugo
  scripts/         # JavaScript modules (ES6+)
    main.js        # Entry point (imports Bootstrap, Extensions, Copyright, Touchable)
    extensions/    # Custom JS extensions
    copyright/     # Auto-update copyright year
    touchable/     # Touch event handling
    utils/         # Utility functions
  styles/          # SCSS source files
    main.scss      # Entry point (imports Bootstrap + custom styles)
    components/    # Component-specific styles
    mixins/        # SCSS mixins
    utilities/     # Utility classes

config/            # Hugo configuration (layered by environment)
content/           # Markdown content files
  _index.md        # Homepage content
  accessibility.md # Accessibility statement
  privacy.md       # Privacy policy
  news/            # Past updates, one post each; see layouts/news/

data/              # YAML data files
  company.yaml     # Company info (name, address, phone, email)
  socialMedia.yaml # Social media links

layouts/           # Hugo templates
  _default/        # Base templates (baseof, list, single)
  partials/        # Reusable template partials
    home/          # Homepage-specific partials (copy.html, contact.html)
    footer/        # Footer components
    head/          # Head tag components
    header/        # Header/navigation
    ctas/          # Call-to-action components
  index.html       # Homepage template

static/            # Static files (copied as-is to output)

bin/
  dev              # Development server wrapper script
  prod             # Production build script (installs Dart Sass)
```

### Build Process

**Development** (`bin/dev`):
- Hugo server runs with live reload
- Builds drafts, expired, and future content
- Disables fast render and HTTP cache for accurate previews
- Template metrics and debug output enabled

**Production** (`bin/prod` + `hugo --gc`):
1. Installs Dart Sass v1.79.5 to `node_modules/.bin` (all `bin/prod`
   does; lint and tests run in GitHub Actions)
2. Hugo processes SCSS via Dart Sass Embedded
3. PostCSS runs autoprefixer and PurgeCSS
4. JavaScript bundled via Hugo Pipes
5. Output to `public/` directory

### Styling Architecture

Bootstrap 5.3.3 forms the foundation with extensive customization:
- Custom variables in `_variables.scss` override Bootstrap defaults
- Component styles organized by feature in `components/`
- Utility classes extend Bootstrap utilities
- PurgeCSS removes unused CSS in production using `hugo_stats.json`

Import order in `main.scss`:
1. Custom fonts
2. Bootstrap functions → custom variables → Bootstrap variables/maps/mixins
3. Utilities (custom → Bootstrap)
4. Custom mixins
5. Global styles
6. Component styles

### JavaScript Architecture

ES6 modules with explicit imports:
- Bootstrap components imported individually (`Collapse` in `main.js`)
- Custom modules: Extensions (prototype methods), Copyright (year updater), Touchable (touch events)
- No build step - uses native ES modules in browser

## Netlify Configuration

Deployment configured in `netlify.toml`:
- Build command: `npm run check:env && npm run check:schedule &&
  npm run check:events && bin/prod && HUGO_BUILD_SHA=$COMMIT_REF
  hugo --gc && npm run
  build:orphans && npm run check:grid`. `build:orphans` keeps the
  last two words of every paragraph, heading and list item on one
  line (see `bin/orphans/wrap.mjs`); `hugo server` skips it.
  `check:grid` holds the built HTML to Bootstrap's grid
  rules (see `bin/grid/check.mjs`), and `check:schema` the built
  JSON-LD to schema.org's types and Google's required properties
  (`bin/schema/check.mjs`), and `check:fresh` the sitemap, llms.txt
  and web app manifest to the pages beside them (`bin/fresh/check.mjs`;
  Hugo writes all three in the render, so none is a step to skip). The local build plugin
  `plugins/source-maps` then moves the source maps out of `public/`
  into Blobs (`docs/monitoring.md`). The build runs
  no lint or tests: those run in GitHub Actions (`lint-and-test`,
  `.github/workflows/ci.yml`), which `staging` and `main` require.
  CI's `build` job repeats the Hugo build, `check:grid`, `check:schema`,
  `check:fresh` and `check:news` on every push, so a template error shows on the commit
- Hugo version: 0.164.0 (pinned; Node 26 via NODE_VERSION and .nvmrc)
- Deploy previews build drafts/future/expired content
- Custom redirects (e.g., `/venmo` → Venmo profile)
- Security headers: CSP, HSTS, nosniff, etc.

## Data Management

Site data stored in YAML files under `data/`:
- Access in templates via `hugo.Data.company` or `hugo.Data.socialMedia`
- Company info includes phone (display + plain formats), email, address
- Centralized data avoids hardcoding in templates

## Important Notes

- **Sass**: Production builds require Dart Sass (auto-installed by `bin/prod`)
- **Images**: Use Hugo's image processing in templates; originals go in `assets/images/`
- **Content**: Markdown files in `content/` are processed by Hugo
- **Linting**: Must pass ESLint (JS) and Stylelint (SCSS) before deployment
- **Bootstrap**: Customizations made via variables, not direct Bootstrap file edits
- **Templates**: Partials are heavily reused; check `layouts/partials/` before creating new ones
