LEASE: 2026-07-31T00:03:48Z hourly-1785456228
# RELAY STATE — cloud agent ledger

inbox-processed: 3
status: waiting-on-james

## Last run

2026-07-30T23:34Z — Applied INBOX sequence 3. Q4 became PR #79 (the
combined eslint 10 bump) and Q6 became PR #80 (the Tailwind migration
inventory, docs only). Both build clean against real Hugo
0.164.0-extended, and #80's deploy preview is green. The inventory
turned up three things I did not expect and did not act on
unilaterally, all queued below as Q7–Q9; the biggest is that the site
ships 24.5 KB gzipped of Bootstrap JS bound to absolutely nothing. One
correction to my own Q4 note: I expected eslint 10 to have dropped the
deprecated formatting rules this config leans on, so I checked against
a deliberately-bad file rather than trusting a clean pass on clean
sources — it hasn't, `quotes`/`semi`/`indent`/`max-len` all still
resolve and still error, so `eslint.config.js` needed no edits at all.

Note on #79's shape: it is **stacked on #76**, base
`agent/wip-npm-migration` rather than `main`. A version bump has to
touch a lockfile and #76 deletes `yarn.lock`, so building it against
main would have been a guaranteed delete/modify conflict plus throwaway
work. GitHub retargets it to main automatically once #76 merges. The
side effect is that Netlify had not attached a deploy preview to #79 as
of this write-up — previews normally only fire for PRs against the
production branch — so for #79 the build proof is my local production
build rather than a preview. It should get one once #76 lands and it
retargets.

## Roadmap position

`project-audit.md` is done; `docs/tailwind-inventory.md` (new, in #80)
is now the forward-looking document. Resume point: nothing is both
unblocked and unclaimed. The next real work is Tailwind prep proper,
and the inventory says the honest first step is not CSS at all — it is
Q7, because whether the header nav is coming back decides whether the
Bootstrap JS bundle can be deleted, and that in turn decides whether
the Q5 PageSpeed baseline is worth taking yet. Q5 is still open and
still not blocking anything else.

Merge order when you get to it: **#76 → #79** (#79 is stacked on it),
then **#78** (written against npm), with **#77** and **#80** free to go
any time. After #79 lands, close #73, #74 and #75 as superseded.

## Open PRs

- #76 https://github.com/north-foster-farm/north-foster-farm/pull/76 —
  yarn → npm. Preview green. **Merge first.**
- #77 https://github.com/north-foster-farm/north-foster-farm/pull/77 —
  docs only, records the Q1/Q3 answers. Preview green.
- #78 https://github.com/north-foster-farm/north-foster-farm/pull/78 —
  README rewrite. Preview green. Wants #76 first; no file conflict.
- #79 https://github.com/north-foster-farm/north-foster-farm/pull/79 —
  eslint 10.8.0 + @eslint/js 10.0.1 + globals 17.8.0, one PR as you
  asked. Lint green, production build green, build output byte-identical
  to the pre-bump baseline across all of `public/`. `npm audit` 9 → 5
  (both sides measured); all 5 remaining are the purgecss → glob →
  minimatch chain that dies with Tailwind, and `--omit=dev` is 0 before
  and after. Stacked on #76, see above.
- #80 https://github.com/north-foster-farm/north-foster-farm/pull/80 —
  Tailwind migration inventory. Docs only, no behaviour change. Preview
  green.

Nothing pushed to main, nothing self-merged, no LGTM labels applied by
me. Dependabot's #73/#74/#75 untouched.

## QUESTIONS

Q7: Is the header nav coming back, or is that scaffolding dead? Right
    now `layouts/partials/header.html` calls `header/menu.html`, but
    there is no `[menu]` configured anywhere in `config/` — so the range
    is empty and the rendered header is just the logo and social icons.
    The knock-on is the real cost: `main.js` imports Bootstrap's
    `Collapse`, never calls it (that is what the
    `// eslint-disable-next-line` is silencing), and there are zero
    `data-bs-*` attributes in any template or in the built HTML of all
    six pages — so the data-API has nothing to bind either. The site
    ships 83 KB raw / **24.5 KB gzipped** of Bootstrap ESM + Popper to
    do nothing. Largest payload item on the site, one line to remove.
  Recommendation: tell me the nav is not coming and I will delete the
    import, the two menu partials and the `.nav-link` /
    `.navbar-flex-group` rules — JS drops to ~0.5 KB gzipped. If the nav
    IS coming, say so and I will leave every bit of it alone, because
    `Collapse` becomes load-bearing the moment a `navbar-toggler`
    appears. I have not guessed either way; a half-built nav is exactly
    the thing I should not quietly delete.

Q8: Drop `'unsafe-inline'` from `style-src` now, rather than parking it
    until Tailwind? I measured what actually needs it: exactly one
    inline style, `style="--bs-breadcrumb-divider: '・';"`, repeated 12
    times from `footer/menu.html:1` and `social-media.html:1`. There are
    no `<style>` blocks anywhere on the site. Move that custom property
    into a class and `style-src` becomes plain `'self'`.
  Recommendation: yes, and it is nearly free — the property is `--bs-*`,
    so the Tailwind migration rewrites it regardless; doing it now just
    tightens the CSP a few weeks earlier. `script-src` is a separate and
    larger job (six inline JSON-LD blocks, needing either a hash-based
    policy or emitting the schema as a file) — I would leave that one
    parked.

Q9: Keep or delete `.waves` / `.parallax`? It is ~41 lines in
    `components/_waves.scss` — an animated SVG wave with four nth-child
    delay variants — and **no template references it at all**. It is not
    dormant like the snow (which `ctas/winter.html` still renders); it
    is genuinely unreferenced. It is also the single largest block of
    real custom CSS in the repo, so it is the one piece of dead code
    where deleting it might lose something you actually want.
  Recommendation: delete it, but I am asking rather than doing because I
    cannot see the site and this reads like a design element that was
    built and shelved rather than abandoned. If you want it kept, it is
    ~41 lines to hand-port to Tailwind later and worth knowing now. If
    you would rather look at it before deciding, say so and I will wire
    it onto a throwaway branch with a deploy preview.
