# SVGs

Every tracked `.svg` is stored exactly as `npm run svg:clean` writes
it, and `npm run check:svg` fails on one that is not (#295). The check
runs in CI's `lint-and-test` job and in the pre-commit hook, on the
SVGs a commit stages.

## Adding an icon or any other SVG

1. Record where it came from in `docs/media-provenance.md` before you
   commit to it. Lucide icons need no new notice; `NOTICE` covers the
   set.
2. Save it under `assets/images/` (icons in `icons/`), `git add` it,
   and run `npm run svg:clean`. It rewrites the new file and leaves
   the clean ones alone.
3. Include it with `partials/svg.html` (below) and check that it
   renders as before, at the size the site uses.

If the clean-up stops on a class or an id, see "Overrides" below.

## In markup: always through `partials/svg.html`

No template or content file writes an `<svg>` by hand. Every SVG in
markup is a file under `assets/images/`, inlined by the partial:

```go-html-template
{{ partial "svg.html" "icons/search" }}
{{ partial "svg.html" (dict "src" "icons/play"
  "class" "video-toggle-play" "aria-hidden" "true") }}
{{ partial "svg.html" (dict "use" "avatar-hen-brown"
  "class" "account-avatar") }}
```

A dict adds attributes to the file's root `<svg>`; an empty value
writes one bare (`hidden`, a `data-` hook). `use` in place of `src`
draws a symbol from the avatar sprite, which `partials/avatars.html`
puts on every page once.

The partial refuses a file with ids unless the dict sets `sprite`:
an SVG inlined twice on a page (the egg spinner, once per busy
button) would repeat its ids, which is invalid HTML and sends every
`url(#id)` to the first copy. Only the sprite keeps ids.

`check:svg` and `test/svg.test.mjs` fail on an `<svg>` element in a
template or content file. `INLINE_ALLOWED` in `bin/svg/clean.mjs`
names the two exceptions and why: the partial itself, and the map,
which Hugo builds from `data/map.json`, the delivery tiers and the
market schedule on every build.

## What the clean-up does

It runs SVGO with James's SVGOMG settings, which `~/.bin/svgomg`
holds. `svgo.config.mjs` copies them as data: multipass, number and
transform precision 10, pretty-printed with a 2-space indent and a
final newline, and SVGOMG's features in its order, with "Remove xmlns",
"Style to attributes", "Remove viewBox" and "Replace xlink" off.
`test/svg.test.mjs` holds the reference list and fails when the config
drifts from it. When James changes his settings, change both.

SVGO is pinned in `package-lock.json`. A new version passes
`check:supply` before it lands.

## Classes and ids

After SVGOMG's settings, the clean-up drops every class the project
does not use. Most are Lucide's (`lucide`, `lucide-copy`), which every
icon copied from lucide.dev carries. SVGO also drops or renames ids
nothing inside the file refers to.

Before writing a file, the clean-up looks for each class or id it
would lose in the project's stylesheets, scripts, templates, content
and tests: a selector (`.name`, `#name`, `[class~=name]`) or the name
as a quoted string. A hit stops the run and names the file that uses
it. Then give the file an override, or style it through a class that
stays.

## Overrides

`OVERRIDES` in `svgo.config.mjs` lets one file differ from the
settings, each difference with its reason: `off` turns any of the
SVGOMG features off for that file, and `classes` names the classes it
keeps. The clean-up and `check:svg` run those files with their
overrides, like any other. Today:

- `logo.svg` and `logo-mark.svg` keep `black`: the header colors
  them through it.
- `icons/egg-spinner.svg` keeps its two classes, and runs without
  `reusePaths`, which would draw both strokes from one path with an
  id and drop the classes and `pathLength` the animation needs.
- `avatars.svg`, the sprite, keeps its symbols' ids (`cleanupIds`,
  `removeHiddenElems` and `reusePaths` off): scripts point `<use>` at
  them.

`test/svg.test.mjs` fails on an override nothing needs any longer: a
kept class nothing uses, or a feature turned off that would change
nothing if it were on.

## What it leaves alone

`bin/logos/originals/`, James's original vectors, kept as he supplied
them: they are the record of what he gave, nothing serves them, and
`bin/logos/build.mjs` reads their ids and their Inkscape bounds.
Every file built from them is cleaned.

## Generated SVGs

The scripts that write SVGs pass them through the clean-up, so a
rebuild leaves `check:svg` green:

- `bin/logos/build.mjs` writes the logos, the hen and the lockup.
- `bin/favicons/build` writes `static/favicons/*.svg`.
- `bin/gate-logo.mjs` copies the cleaned logo and mark into
  `netlify/functions/lib/gate-logo.mjs` for the gate's sign-in page.
  Run it after either logo changes; `test/gate-page.test.mjs` fails
  until you do.
