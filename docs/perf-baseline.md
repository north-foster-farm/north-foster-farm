# Pre-Tailwind performance baseline

Captured 2026-08-27 against `main` at `2f63020`, the last commit
before the Bootstrap-to-Tailwind migration starts. This is the A4
baseline `project-audit.md` asks for: the migration should not
regress these numbers.

It was gated on the dead-`Collapse` decision (see
`docs/tailwind-inventory.md`, Finding 1) because the JS payload it
measures was about to change. That decision landed in `7074887`, so
the numbers below already reflect the slimmed bundle.

## How to reproduce

Lab measurement, not field data. Everything runs against a local
production build, so the numbers are repeatable and isolate the
site's own cost from CDN and network variance:

1. Build with the pinned toolchain — Hugo 0.164.0 extended and Dart
   Sass 1.79.5 on PATH — via `hugo --environment production --gc`.
   Do **not** use `npm run deploy`; `bin/prod` is Netlify-only.
2. Serve `public/` over plain HTTP with the `Cache-Control`, CSP and
   `Referrer-Policy` headers from `netlify.toml` applied, so the
   header-sensitive audits see what production sends.
3. Run Lighthouse 13.4.1 against `http://127.0.0.1:8099/`, three
   times per preset, and take the median.

Known deviations from production, both understood and constant
across any future comparison:

- The local server does not gzip, so the `document` transfer size
  below is uncompressed HTML. Netlify compresses it.
- No CDN, so network timing is optimistic in absolute terms. Only
  the before/after delta is meaningful.

## Scores — home page (`/`)

Median of three runs. Lighthouse 13.4.1, default throttling.

| Category | Mobile | Desktop |
|---|---|---|
| Performance | 84 | 100 |
| Accessibility | 91 | 91 |
| Best practices | 100 | 100 |
| SEO | 100 | 100 |

Mobile performance was not stable across runs (84, 84, 89); treat
anything inside ±5 as noise. Desktop was 100 on all three.

The accessibility 91 is fixed in the same PR that adds this file —
an invalid `lang` attribute and four icon-only links with no
accessible name. Both are corrected, and the re-measured score is
**100**. Record 100 as the number the migration must hold.

## Metrics — home page, mobile

| Metric | Median |
|---|---|
| First Contentful Paint | 2.16 s |
| Largest Contentful Paint | 4.08 s |
| Speed Index | 2.56 s |
| Total Blocking Time | 0 ms |
| Cumulative Layout Shift | 0.0004 |

Desktop for the same run: FCP 0.48 s, LCP 0.70 s, Speed Index
0.48 s, TBT 0 ms.

TBT of 0 and a CLS of effectively 0 are the important ones to hold.
The site ships almost no JavaScript and nothing shifts during load;
a Tailwind migration has no reason to change either, so any
regression there is a bug in the migration, not a cost of it.

## Payload — home page

Eleven requests, **7.26 MB** transferred:

| Type | Requests | Transfer |
|---|---|---|
| Image | 3 | 6.99 MB |
| Document | 1 | 134 KB (uncompressed, see above) |
| Font | 3 | 84.6 KB |
| Stylesheet | 1 | 23.7 KB |
| Other | 2 | 16.6 KB |
| Script | 1 | 2.31 KB |
| Third-party | 0 | 0 |

Two things worth reading off that table.

**The CSS and JS the migration actually touches are 26 KB of a
7.26 MB page** — a third of a percent. Whatever Tailwind does to
the stylesheet, it cannot move the headline number. The 23.7 KB
stylesheet is the honest before-figure for the migration; the
2.31 KB script is what is left after the dead Bootstrap `Collapse`
bundle came out, down from the 24.5 KB gzipped that
`docs/tailwind-inventory.md` measured.

**`/images/chickens.jpg` is 6.6 MB on its own** — 91% of the page.
See below; it is not a migration problem and should not wait for
one.

## The hero image dominates everything else

`static/images/chickens.jpg` is a 2923x1692 baseline JPEG, 6.6 MB,
still carrying its iPhone 13 Pro Max EXIF block. It is pulled in as
a CSS background by `assets/styles/mixins/_bg_cover.scss` via
`assets/styles/components/_home.scss:11`.

Because it lives in `static/` rather than `assets/`, it bypasses
Hugo's image pipeline completely: no resize, no WebP, no responsive
variants, and none of the `[imaging]` quality settings in
`config/_default/hugo.toml` apply to it. Every other image on the
site is Hugo-processed and lands between 169 KB and 222 KB.

It is the LCP cost on mobile. Fixing it is worth more than the
entire Tailwind migration is to this metric, and it is independent
of that migration.

The fix is not purely mechanical, which is why it is queued as a
question rather than done here — see `Q17` in `STATE.md` on the
`agent/relay` branch. The wrinkle is that SCSS cannot call Hugo's
image processing, so moving the file into `assets/` means the
fingerprinted URL has to reach the stylesheet from a template, and
`style-src 'self'` now forbids the inline-style route that would
normally be used.
