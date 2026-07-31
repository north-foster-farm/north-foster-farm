# Tailwind migration inventory (measured 2026-07-30)

What the site actually uses of Bootstrap 5.3.3 today, so the migration
to Tailwind can be estimated instead of guessed at. Read-only survey —
nothing here changes behaviour.

Method: every number below was measured against a real production build
(Hugo 0.164.0-extended, Dart Sass 1.79.5), not read off the source. The
class list is `hugo_stats.json` from that build, which is the same file
PurgeCSS uses, so it is exactly the set of classes that survive into
production CSS. Where a class is declared in SCSS but absent from that
list, it was then grepped against `layouts/` and `content/` to tell
"nobody references it" apart from "referenced by a template that no
current page renders". That distinction matters and is kept throughout.

## The headline

The site is much smaller than the framework carrying it.

| | |
|---|---|
| Built CSS | 23,159 B raw / **5,957 B gzipped** |
| Built JS | 83,049 B raw / **24,556 B gzipped** |
| Custom SCSS | **742 lines** across 24 files |
| Distinct classes rendered site-wide | **107** |
| Class selectors declared in custom SCSS | 39 |
| Pages | 6 |

PurgeCSS is doing real work: Bootstrap's full stylesheet is ~280 KB and
what ships is 23 KB. The JS is the opposite story — see below.

> **Status: findings 1, 3 and 5 are now acted on.** The `Collapse`
> import is gone (JS 24,556 B → **837 B** gzipped), `style-src` no
> longer carries `'unsafe-inline'`, and the dead selectors are deleted.
> Finding 2 was partly wrong and is corrected in place below. The
> measurements are kept as the pre-migration baseline.

## Finding 1 — the JS bundle is 24.5 KB gzipped of nothing

`assets/scripts/main.js` imports Bootstrap's `Collapse`:

```js
// eslint-disable-next-line
import { Collapse } from "bootstrap/dist/js/bootstrap.esm.min.js";
```

That import is never called, which is why it needs the
`eslint-disable-next-line` to get past `no-unused-vars`. It would still
be load-bearing if anything used Bootstrap's data-API, because importing
the ESM build registers the `data-bs-toggle` document handlers. Nothing
does: there are **zero `data-bs-*` attributes** in `layouts/`, in
`content/`, or in the built HTML of all six pages.

The reason is Finding 2. The upshot is that ~74 KB of Bootstrap ESM plus
Popper is bundled, fingerprinted, integrity-hashed and served on every
page to do nothing. Dropping the import leaves roughly 0.5 KB gzipped of
genuinely-used JS (`Extensions`, `Copyright`, `Touchable`).

This is the single largest payload item on the site and it costs one
line to remove. It is raised as a question rather than done, because
Finding 2 suggests a nav may be half-built.

## Finding 2 — the header has no nav (corrected)

**This section was wrong when first written and is corrected here.** The
original text said `header/menu.html` ranges over a Hugo menu that is
never configured, and that both header menu partials were therefore
dead. That is not right, and acting on it would have deleted a live
partial.

What is actually true:

- `layouts/partials/header.html:2` calls `header/menu.html`, but that
  partial does **not** range over anything. Despite the name it is the
  header itself — the `navbar-brand` logo plus the social-media strip.
  It is live on every page and must not be touched.
- `header/menu-item.html` **is** orphaned: nothing calls it. It is the
  leftover of a header nav that no longer exists, and it is the only
  reason `nav-link` / `nav-item` appear anywhere in the source.
- Menus are not absent from the site — they are declared in **content
  front matter**, not `config/`. `content/accessibility.md` and
  `content/privacy.md` both carry `menu: footer:`, so `.Site.Menus.footer`
  is populated and `footer/menu.html` + `footer/menu-item.html` are both
  live. The original "no `[menu]` is configured anywhere" was literally
  true of `config/` and misleading about the site.

What survives from the original finding is the part that mattered: the
rendered header contains no nav, so `navbar-toggler` / `collapse` /
`data-bs-*` appear on no page, which is why `Collapse` had nothing to
bind to. `header/menu-item.html` and the `.nav-link` /
`.navbar-flex-group` rules in `components/_header.scss` are dead and
have been removed; `header/menu.html` has not been.

## Finding 3 — CSP `unsafe-inline` is nearly droppable

Both `script-src` and `style-src` carry `'unsafe-inline'`
(`netlify.toml`). Measured against the built HTML, here is what actually
needs it:

- **`style-src`** — exactly one inline style, repeated 12 times:
  `style="--bs-breadcrumb-divider: '・';"`, from
  `layouts/partials/footer/menu.html:1` and
  `layouts/partials/social-media.html:1`. There are no `<style>` blocks
  anywhere. Move that custom property into a class and `style-src` can
  become plain `'self'` — and note the property is `--bs-*`, so the
  Tailwind migration deletes the need for it regardless.
- **`script-src`** — six `<script type="application/ld+json">` schema
  blocks. The one real `<script>` is external, with `src` + `integrity`,
  so `'self'` already covers it. CSP does apply `script-src` to JSON-LD,
  so those six are the only thing keeping `'unsafe-inline'` alive.
  Options are a hash-based policy or emitting the schema as a file.

So `style-src` is a cheap win available today, and `script-src` is a
slightly larger one; neither has to wait for Tailwind. This supersedes
the "parked until after Tailwind" note in `project-audit.md` to the
extent that the *measurement* is now done.

## Finding 4 — what is genuinely custom vs. an override

Of the 742 lines of SCSS, very little is design that Tailwind would not
express directly.

**Genuinely custom, must be ported by hand (~150 lines):**

- `components/_snow.scss` — a 200-iteration Sass `@for` loop generating
  per-snowflake CSS custom properties with `random()`, plus a
  `snowfall` keyframe. Tailwind has no equivalent; this stays as plain
  CSS. Dormant (winter CTA only) but real.
- `components/_waves.scss` — `parallax` keyframe animation over SVG
  `<use>` children, four nth-child delay variants.
- `mixins/_bg_cover.scss` + `mixins/_bg_opacity.scss` — two small
  mixins, used once each by `components/_home.scss`. Become utility
  classes or arbitrary values.
- `_fonts.scss` — 59 lines of self-hosted Aller `@font-face`. Carries
  over essentially unchanged.
- `components/_home.scss` — the APPPA logo SVG fills and the
  `photo-frame` colour are hard-coded hex, not theme colours.

**Bootstrap overrides that evaporate with Bootstrap (~590 lines):**

- `_variables.scss` (188 lines) is *entirely* Bootstrap variable
  overrides — the colour system, `$spacers`, `$theme-colors`, button and
  navbar variables. This becomes a Tailwind `@theme` block and shrinks
  hard: most of it exists to reshape Bootstrap defaults the site then
  barely uses.
- `utilities/_fixed-max-width.scss`, `_font-size.scss`, `_z-index.scss`
  are all `map-merge` into Bootstrap's `$utilities` map to generate
  responsive utilities. Tailwind generates all three natively —
  `fmw-575` is `max-w-[575px]`, `fs-sm-2` is a responsive text size,
  `zi-*` is `z-*`. **These three files are deleted, not ported.**
- `components/buttons/_white.scss` sets nine `--bs-btn-*` custom
  properties. Pure Bootstrap API; rewritten from scratch.

**Bootstrap coupling points that will break loudly** (useful, because
they fail at build time rather than silently):

- **`@extend` × 10** — `_global.scss:6-7` (`.d-flex`, `.flex-column`),
  `_circle.scss:2-3` (`.ratio`, `.ratio-1x1`), `_page.scss:4,13`,
  `_policy.scss:3-4,8-9`. Tailwind v4 has no `@extend`; each becomes
  `@apply` or literal CSS. These are the migration's tripwires.
- `@include media-breakpoint-up(...)` × 4 → Tailwind media variants.
- Bootstrap Sass colour functions: `tint-color` × 10, `shade-color` × 5.
  No Tailwind equivalent — precompute the values or use `color-mix()`.

## Finding 5 — dead SCSS not worth porting

19 of the 39 declared class selectors appear on no rendered page. Split
by whether any template references them at all:

**Referenced nowhere — delete rather than port (10):**
`.ls-outside`, `.text-gray`, `.text-light-gray`, `.text-shadow`,
`.img-cover`, `.img-contain`, `.navbar-flex-group`, `.btn-white`,
`.waves`, `.parallax`.

Note `.waves` and `.parallax` are ~41 lines of animation with no markup
behind them — that is the biggest single block of genuinely custom CSS
in the repo and it may be worth keeping deliberately rather than losing
by accident. Worth a decision, not a silent delete.

**Dormant — template exists, no current page renders it (9):**
`.list-group`, `.list-group-img`, `.img-supporting`, `.page-content`,
`.circle`, `.inner`, `.nav-link`, `.snowflake`, `.debug`. These live in
`_default/single.html`, `_default/section.html`, `ctas/winter.html` and
the debug partial. They are not dead — they light up when a section gets
content or when winter turns on. Port them.

## Finding 6 — what the build pipeline loses

The migration deletes more infrastructure than it adds:

- `postcss.config.js` — the whole PurgeCSS block goes; Tailwind does its
  own content scanning. Autoprefixer likely goes too (Tailwind v4 has
  Lightning CSS built in).
- `config/_default/hugo.toml` — the `hugo_stats.json` mount and
  `[build.buildStats] enable = true` exist only to feed PurgeCSS.
- `layouts/partials/head/styles.html` — `css.Sass` with the `dartsass`
  transpiler goes; so does `resources.PostProcess`, which resolves the
  `templates.Defer` deprecation recorded in `project-audit.md` for free.
- `bin/prod` — its entire reason for existing is installing Dart Sass on
  the Netlify image. Tailwind v4 needs no Dart Sass, so the script
  reduces to `npm run lint` or disappears.
- Dependencies deleted: `bootstrap`, `@popperjs/core`,
  `@fullhuman/postcss-purgecss`, `stylelint-config-standard-scss`,
  `stylelint-scss`, and probably `autoprefixer` / `postcss-cli`. That is
  also the whole of the `ignore:` block added to Dependabot, and all 5
  remaining `npm audit` advisories, which live in
  `purgecss → glob → minimatch`.

## Sizing

Small. 6 pages, 107 classes, ~150 lines of genuinely custom CSS, and 10
`@extend` sites that fail loudly if missed. The risks are not in the
CSS — they are the two behaviour-shaped questions above (the dead JS
import, the unbuilt nav) and the fact that nobody can see the rendered
result from CI. A deploy preview per page is the check that matters.

The pre-migration byte baseline is recorded at the top of this file.
The PageSpeed baseline is still outstanding — and note Finding 1 will
move it substantially, so it is worth deciding the `Collapse` question
*before* taking that measurement, or the baseline measures a payload
that is about to vanish.
