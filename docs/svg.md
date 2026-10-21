# SVGs

Every tracked `.svg` is stored exactly as `npm run svg:clean` writes
it, and `npm run check:svg` fails on one that is not (#295). The check
runs in CI's `lint-and-test` job and in the pre-commit hook, on the
SVGs a commit stages.

## Adding an icon or any other SVG

1. Record where it came from in `docs/media-provenance.md` before you
   commit to it. Lucide icons need no new notice; `NOTICE` covers the
   set.
2. Save it under `assets/images/` (icons in `icons/`) and run
   `npm run svg:clean`. It rewrites the new file and leaves the clean
   ones alone.
3. Check that it renders as before, at the size the site uses.

If the clean-up stops on a class or an id, see "Classes and ids" below.

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
icon copied from lucide.dev carries. `KEEP` in `bin/svg/strip.mjs`
names the classes that stay and why: today `black` (the header's logo)
and `background` (the APPPA logo's badge in the footer). A test fails
when nothing uses a `KEEP` class any longer.

SVGO also drops or renames ids nothing inside the file refers to.
Before writing a file, the clean-up looks for each class or id it
would lose in the project's stylesheets, scripts, templates, content
and tests: a selector (`.name`, `#name`, `[class~=name]`) or the name
as a quoted string. A hit stops the run and names the file that uses
it. Then either add the class to `KEEP` with the reason, or style the
SVG through a class that stays. An id cannot be kept: refer to the
element another way.

## What it leaves alone

- `bin/logos/originals/`: James's original vectors, kept as he
  supplied them. Nothing serves them, and `bin/logos/build.mjs` reads
  their ids and their Inkscape bounds.
- SVG written inline in templates (the busy button's egg, the video
  toggles, the order form's check mark, the avatars, the map). The
  stylesheets and scripts drive them through classes, `pathLength`,
  ids and data attributes that SVGO would remove, and some are built by
  Hugo. Their paths are already as short as SVGO writes them; keep
  new ones that way, or put the drawing in a file and include it with
  `partials/svg.html`.

## Generated SVGs

The scripts that write SVGs pass them through the clean-up, so a
rebuild leaves `check:svg` green:

- `bin/logos/build.mjs` writes the logos, the hen and the lockup.
- `bin/favicons/build` writes `static/favicons/*.svg`.
- `bin/gate-logo.mjs` copies the cleaned logo and mark into
  `netlify/functions/lib/gate-logo.mjs` for the gate's sign-in page.
  Run it after either logo changes; `test/gate-page.test.mjs` fails
  until you do.
