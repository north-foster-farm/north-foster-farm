LEASE: 2026-08-27T14:35:09Z run-258
# RELAY STATE — cloud agent ledger

inbox-processed: 5
status: working

## Last run

2026-08-27T13:35Z — Run 257. INBOX is still `sequence: 5`, but status
was `working` rather than `waiting-on-james`, so the guard did not fire
and I went looking for work instead of exiting. **PR #90 is unchanged
and still green** — head `5894d48`, `mergeable_state: clean`, the only
comment on it is Netlify's bot. Nothing for me to push there; it still
wants your merge click.

With the queue blocked I went back to `project-audit.md` and found one
unstruck item whose precondition had quietly cleared: **A4's Lighthouse
baseline**, gated on the dead-`Collapse` decision because the JS payload
it measures was about to change. Q7 answered that and it landed in
`7074887`, so the gate has been open and nobody noticed. I ran it.

Running it turned up two real accessibility defects, both mechanical,
both fixed in **PR #91**:

- `baseof.html:2` hardcoded `lang="en_US"`. BCP 47 wants a hyphen, so
  that is not a valid language tag at all — assistive tech could not
  resolve the page language on **any** page. Now derived from
  `site.Language.LanguageCode`, which reads the `locale = "en-us"`
  already in the config, so it cannot drift again.
- The social-media partial wraps an inline SVG in a bare anchor, so the
  links have no accessible name. It renders twice per page, header and
  footer: **four unnamed links in the tab order on every page**. Added a
  `label` to `data/socialMedia.yaml` and applied it as `aria-label`.
  No visual change.

Accessibility went **91 → 100**, with no failed audits left in that
category. Verified the same way as last run: lint green, real
`hugo --environment production --gc` at the pinned versions, built CSS
and JS **byte-identical** to `main`, and the only differences anywhere
in the build output are the `lang` attribute and the four `aria-label`s
across four HTML pages. Netlify's deploy preview on #91 is already
green.

**The thing you will actually care about**, and the reason I am not
burying it: the home page is **7.26 MB**, and `/images/chickens.jpg` is
**6.6 MB of that — 91% of the page**. It is a 2923x1692 baseline JPEG
still carrying its iPhone 13 Pro Max EXIF block, used as the hero
background. Because it sits in `static/` instead of `assets/` it
bypasses Hugo's image pipeline completely — no resize, no WebP, none of
the `[imaging]` quality settings apply. Every other image on the site is
Hugo-processed and lands between 169 KB and 222 KB. It is the mobile LCP
cost, and it is worth far more than the entire Tailwind migration is to
that number. It is design-shaped, so it is **Q17** below rather than
something I fixed on my own judgement.

For scale, and it is a useful corrective to how the migration is being
sized: the CSS and JS that Tailwind actually touches are **26 KB of that
7.26 MB page**, a third of a percent. The script is down to 2.31 KB from
the 24.5 KB gzipped the inventory measured, so Q7 did exactly what it
was meant to.

Baseline recorded in a new `docs/perf-baseline.md` rather than in
`project-audit.md`, deliberately: #90 is still in flight and edits that
file, and I did not want a conflict between my own two PRs.

One thing I checked and it was fine, recorded so a later run does not
re-flag it: `layouts/partials/header/menu.html` and
`layouts/partials/footer/menu.html` both still exist after Q7's
deletions. Neither is dead — the header one renders the logo and the
social row, and the footer one really does emit the privacy and
accessibility links. Not a leftover.

## Roadmap position

A4's Lighthouse/PageSpeed baseline: **done**, in `docs/perf-baseline.md`
(PR #91). That was the last unstruck A2–A4 item that did not need you.
Everything else remaining in the audit is either blocked on a question
below or needs the Netlify UI.

Resume point, in order: (1) shepherd **#90** and **#91** to merge — both
green, both subscribed, so CI and review events wake me; (2) once #90
merges, strike the A4 bullet in `project-audit.md` and point it at
`docs/perf-baseline.md` — deliberately left out of #91 to avoid a
conflict between my own two PRs; (3) if Q17 comes back approved, build
the hero-image PR behind a deploy preview so you can compare it against
production side by side.

The Tailwind migration is still the next arc and I still will not start
it unprompted. **Q15** remains the single answer that unblocks the most.

## Open PRs

- **#90 — mine. GREEN AND MERGEABLE — wants your merge.** Unchanged
  since last run. "Clear the last npm advisory and strike four stale
  audit items." Three-line lockfile bump closing the `nanoid` advisory,
  plus `project-audit.md` corrections. `mergeable_state: clean`, head
  `5894d48`, no review comments. The only open item that closes a
  security advisory.
  https://github.com/north-foster-farm/north-foster-farm/pull/90
- **#91 — mine, new this run. Deploy preview green.** "Fix two
  accessibility defects and record the pre-Tailwind performance
  baseline." Three commits, head `cb03946`. Accessibility 91 → 100;
  CSS and JS byte-identical to `main`. Preview:
  https://deploy-preview-91--north-foster-farm.netlify.app
  https://github.com/north-foster-farm/north-foster-farm/pull/91

Still open, not mine — unchanged, none reviewed, no comments:

- #85 — Dependabot, `postcss` 8.5.25 → 8.5.26. Ordinary patch bump on
  its own merits now that #90 clears the advisory directly. Real
  build-path dependency, so it wants a deploy preview before merge.
- #87 — Dependabot, `eslint` 10.8.0 → 10.8.1. Patch, bug fixes only,
  lint-only. Clean follow-on to the eslint 10 you took on Q4.
- #88 — Dependabot, `globals` 17.8.0 → 17.11.0. Lint-only
  devDependency.
- #21 — Dependabot, `autoprefixer` 10.4.19 → 10.4.20, open since
  2024-08. Obsolete: `package.json` already pins 10.5.4, so this moves
  backwards. Dead and wants closing; say the word and I will close it
  with a reason, as I did for #73/#74/#75.

Housekeeping, unchanged: `agent/wip-eslint-10` is still on the remote at
`5744535`. Its commits are in `main` by content but not by SHA (that PR
was rebase-merged), so git does not report it as merged. Mine and safe
to delete; left alone because deleting branches unasked is not something
I want to do on my own initiative.

Runbook corrections still outstanding in the stored prompt: it says to
run `yarn install`, but the repo moved to npm when Q2 landed (I use npm
and respect `package-lock.json`); and while `bin/prod` is genuinely
unrunnable here, fetching Hugo 0.164.0 extended and Dart Sass 1.79.5 to
a temp path makes a full production build work in this container. This
run adds a third: **Lighthouse runs here too**, against a local
production build using the pre-installed Chromium, so the A4 baseline
never actually needed the PageSpeed API that rate-limited you on Q5.

## QUESTIONS

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
     Worth knowing before you answer: this run measured the CSS and JS
     the migration touches at 26 KB of a 7.26 MB page. Whatever else the
     migration is worth, it is not a performance win — Q17 is where the
     performance is.

Q16: Should I scope the Dependabot `ignore` entries so they suppress
     version updates but still let security updates through?
     `.github/dependabot.yml` carries six bare `dependency-name` ignores
     (`bootstrap`, `@popperjs/core`, `@fullhuman/postcss-purgecss`,
     `stylelint`, `stylelint-config-standard-scss`, `stylelint-scss`)
     with no `update-types`, so those packages get no security PRs at
     all. The `nanoid` advisory that #90 clears sat in `main` unannounced
     and was only caught by running `npm audit` by hand.
  Recommendation: yes, and it is a small, safe change. Adding
     `update-types: ["version-update:semver-major",
     "version-update:semver-minor", "version-update:semver-patch"]` to
     each ignore entry scopes the ignore to *version* updates only, so
     you keep exactly the noise reduction you wanted on 2026-07-30 and
     get your security alerts back. I would rather do this than lift the
     ignores outright — that would restore the Bootstrap PR pile you
     deliberately killed.

Q17: The hero image is 6.6 MB. How do you want it cut?
     `static/images/chickens.jpg` is 2923x1692, 6.6 MB, still carrying
     its iPhone EXIF block, and it is **91% of a 7.26 MB home page**. It
     is the mobile LCP cost. This is design-shaped — it changes how the
     hero looks and I cannot see the rendered site — so I want your eye
     on it rather than my judgement.
  Recommendation: leave it in `static/` and just replace the file with a
     2048px-wide WebP at quality 82, changing the one `bg-cover` argument
     in `assets/styles/components/_home.scss:11` from `.jpg` to `.webp`.
     Expect roughly 150–250 KB — a ~97% cut — for a background that is
     scaled with `background-size: cover` and sits under a 65% grey
     overlay, so the quality loss should be invisible in place. I would
     build it behind a deploy preview and let you compare against
     production before it goes anywhere near main.
     Why not the tidier-looking option: moving the file into `assets/`
     to get Hugo's pipeline and responsive variants sounds better, but
     SCSS cannot call Hugo's image processing, so the fingerprinted URL
     has to reach the stylesheet from a template — and `style-src 'self'`
     now forbids the inline `<style>` route that would normally carry it.
     That means emitting a separate fingerprinted CSS file just for one
     background rule. Real work, and it buys nothing the file swap does
     not, so I would only do it if you want true responsive `image-set`
     variants. Say "assets" if you do.
