# RELAY STATE — cloud agent ledger

inbox-processed: 5
status: waiting-on-james

## Last run

2026-08-27T14:35Z — Run 258. No new INBOX (still `sequence: 5`), and
**both my PRs are unchanged and still green**: #90 head `5894d48`, #91
head `cb03946`, both `mergeable_state: clean`, the only comment on each
is Netlify's bot. Nothing to push on either; they want your merge click.

I re-confirmed the one thing worth re-confirming: `npm audit` on `main`
**still reports the `nanoid` high-severity advisory**. #90 is still the
only open thing that closes it.

With no unblocked build work left, I spent the run getting *hard data*
instead of guessing, and it materially changed one of the questions
already on your list. I ran the production build with
`--printUnusedTemplates --printPathWarnings`, which is a step the audit
suggested in A1 and nobody had actually run. No path warnings — no
duplicate output targets. But Hugo names **six** unused templates, not
the three Q13 asked about:

    _default/single.html      _default/list.html
    _default/section.html     partials/image.html
    partials/ctas/winter.html partials/debug/template.html

Tracing the references, they are not six separate judgement calls —
they are **one closed cluster plus one stray**, which is why Q13 below
is rewritten rather than just extended:

- The three `_default/` templates are the *only* callers of
  `partials/image.html` and `partials/debug/template.html`. Those two
  die automatically with them; they are not separate decisions.
- They are also the only consumers of the `[params.defaults.
  featuredImage]` block in `config/_default/hugo.toml:60-67`, which
  goes with them.
- `ctas/winter.html` is the stray, and it is **not merely unused — it
  is broken.** It opens with `.Site.Params.defaults.ctas.winter`, and
  that config key **does not exist**; the config has only `default`
  and `simple`. Its config was removed at some point and the template
  was left behind. If `footer/cta.html` ever selected it, it would
  fail on the first line. It is the sole user of
  `components/_snow.scss` (`.snowflake`).

So the SCSS the answer actually decides is not the four classes I
quoted last run. It is four whole files/blocks: `components/_snow.scss`
and `_debug.scss` entirely, `components/_circle.scss` entirely, plus
`.page-content` in `components/_page.scss` and `.list-group-img` /
`.img-supporting` in `_global.scss`. `.btn-cta` **stays** either way —
`ctas/simple.html` uses it and that one does render.

One thing I could not do, recorded so a later run does not retry it:
**the A4 "grep content for dead absolute URLs" check cannot complete in
this container.** There are no `http://` URLs anywhere, which is the
half I *can* answer statically, but the nine external `https://` targets
(the two farmers' markets, Tilted Barn, getrealchicken, Wikipedia,
Instagram, Venmo, admin, order-form) are unreachable from here — the
environment's network policy answers 403 to CONNECT for every host
outside its allowlist. That check needs to run on your machine, or be
dropped. `data/socialMedia.yaml` still carries a placeholder Facebook
URL (`https://facebook.com/#`), but it is `hide: true` and does not
render, so it is not a live defect.

Everything else verified clean this run: `npm run lint` green, real
`hugo --environment production --gc` at the pinned versions (Hugo
0.164.0 extended, Dart Sass 1.79.5) builds 6 pages, working tree clean.
The only build warnings are Dart Sass deprecations from inside
Bootstrap's own SCSS, which the audit explicitly says not to invest in
since the migration deletes that stack.

Not repeating one item: the stale README bullet in `project-audit.md`
is already struck by #90, so it is handled, not outstanding.

## Roadmap position

**The audit's unblocked work is exhausted.** Every remaining item in
`project-audit.md` is now either waiting on an answer below, waiting on
your merge click, or needs the Netlify UI. I made no code change this
run and I want to be plain about that rather than manufacture one —
there was nothing left that I could decide on my own.

Resume point, in order: (1) merge **#90** — it is the only open item
closing a security advisory, and the advisory is still live on `main`;
(2) merge **#91**; (3) once #90 merges, strike the A4 bullet in
`project-audit.md` and point it at `docs/perf-baseline.md` — held out
of #91 on purpose to avoid a conflict between my own two PRs; (4) if
Q17 comes back approved, build the hero-image PR behind a deploy
preview so you can compare it against production side by side.

The Tailwind migration is still the next arc and I still will not start
it unprompted. **Q15** remains the single answer that unblocks the most;
**Q13** is the one that decides how much dead weight the migration
carries.

## Open PRs

- **#90 — mine. GREEN AND MERGEABLE — wants your merge.** Unchanged,
  head `5894d48`, `mergeable_state: clean`, no review comments. "Clear
  the last npm advisory and strike four stale audit items." I re-ran
  `npm audit` on `main` this run: the `nanoid` high is **still there**,
  so this is still the only open item that closes it.
  https://github.com/north-foster-farm/north-foster-farm/pull/90
- **#91 — mine. GREEN AND MERGEABLE — wants your merge.** Unchanged,
  head `cb03946`, `mergeable_state: clean`, deploy preview green. "Fix
  two accessibility defects and record the pre-Tailwind performance
  baseline." Accessibility 91 → 100; CSS and JS byte-identical to
  `main`. Preview:
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
  2024-08. Obsolete — `package.json` already pins 10.5.4. Now **Q18**
  below rather than buried in this list, because it has been sitting
  here unanswered for three runs.

Housekeeping: `agent/wip-eslint-10` is still on the remote at
`5744535`, its commits in `main` by content but not by SHA. Now **Q19**
below, for the same reason.

Runbook corrections still outstanding in the stored prompt, unchanged
from last run: it says `yarn install`, but the repo moved to npm when
Q2 landed (I use npm and respect `package-lock.json`); `bin/prod` is
genuinely unrunnable here, but fetching Hugo 0.164.0 extended and Dart
Sass 1.79.5 to a temp path makes a full production build work; and
Lighthouse runs here too, against a local production build using the
pre-installed Chromium. Adding a fourth this run: **outbound HTTPS is
allowlisted**, so any step that means "check this external URL is still
live" cannot be done from this container at all.

## QUESTIONS

Q13: **(rewritten — Hugo says the dead cluster is twice what I told you
     last run.)** Are these six templates leftovers, or is content
     coming for them? `hugo --printUnusedTemplates` on a real
     production build names all six as rendering on **no page**:
     `_default/single.html`, `_default/list.html`,
     `_default/section.html`, `partials/image.html`,
     `partials/debug/template.html`, `partials/ctas/winter.html`.
     It is really two decisions, not six. **(a)** The three `_default/`
     templates, and with them `image.html` and `debug/template.html`
     (nothing else calls those two) and the `[params.defaults.
     featuredImage]` config block (nothing else reads it). **(b)**
     `ctas/winter.html`, which is separate — and note it is **already
     broken**: it reads `.Site.Params.defaults.ctas.winter`, and that
     config key no longer exists, so it would error on line 1 if it
     were ever selected.
     The SCSS held hostage: `components/_snow.scss` and `_debug.scss`
     entirely, `components/_circle.scss` entirely, `.page-content` in
     `components/_page.scss`, and `.list-group-img` / `.img-supporting`
     in `_global.scss`. (`.btn-cta` survives either way —
     `ctas/simple.html` uses it and that one renders.)
  Recommendation: delete both (a) and (b), now, before the migration.
     For (b) I am confident enough that I would call it settled unless
     you say otherwise — a template whose config was deleted out from
     under it is not scaffolding waiting for content, it is a
     half-finished removal, and if you want a winter CTA back it is
     easier to rewrite in Tailwind than to port dead Bootstrap. For (a)
     I want your word rather than my inference, because it hinges on
     something only you know: `image.html` is a complete, working
     responsive-`<picture>` partial built on Hugo's image pipeline. If
     a shop or products section is coming, that partial is the thing
     you would want and porting it is worth it. If those three
     templates are scaffolding from an earlier shape of the site, all
     of it goes and the migration carries four fewer SCSS files.

Q14: Ready to take HSTS `max-age` to 31536000 now? It is still at 86400
     in `netlify.toml`. You slated it rather than committing it back on
     Q1, having confirmed `admin.northfosterfarm.com` is HTTPS-only.
     86400 is short enough to be close to decorative.
  Recommendation: yes, take it — one line in `netlify.toml`. The only
     real risk with a long `includeSubDomains` max-age is a subdomain
     that needs plain HTTP later, and you have already ruled that out.
     If you would rather stage it, say so and I will go to 2592000
     (30 days) as a checkpoint instead of the full year.

Q15: What is the first Tailwind step you actually want? The prep work
     is genuinely done and I am told not to start the framework
     rewrite, so I will not pick this myself.
  Recommendation: a single-page spike on a throwaway branch — convert
     `/privacy` or `/404` only, leave Bootstrap in place for everything
     else, and put it behind a deploy preview you can look at. It costs
     little, it is fully reversible, and it puts a real number on the
     one thing the inventory could not: how much work the 10 `@extend`
     sites and the `tint-color`/`shade-color` calls actually are in
     practice. Worth knowing before you answer: the CSS and JS the
     migration touches are 26 KB of a 7.26 MB page. Whatever else the
     migration is worth, it is not a performance win — Q17 is where the
     performance is. And answer Q13 first if you can: it decides
     whether the spike is sizing a migration of four more SCSS files
     that nothing renders.

Q16: Should I scope the Dependabot `ignore` entries so they suppress
     version updates but still let security updates through?
     `.github/dependabot.yml` carries six bare `dependency-name`
     ignores (`bootstrap`, `@popperjs/core`,
     `@fullhuman/postcss-purgecss`, `stylelint`,
     `stylelint-config-standard-scss`, `stylelint-scss`) with no
     `update-types`, so those packages get no security PRs at all.
  Recommendation: yes, and it is a small, safe change. Adding
     `update-types: ["version-update:semver-major",
     "version-update:semver-minor", "version-update:semver-patch"]` to
     each entry scopes the ignore to *version* updates only, so you
     keep exactly the noise reduction you wanted on 2026-07-30 and get
     your security alerts back. I would rather do this than lift the
     ignores outright — that would restore the Bootstrap PR pile you
     deliberately killed. Sharper case for it this run: the `nanoid`
     advisory is *still* live on `main`, and it was found by running
     `npm audit` by hand, not by anything telling you.

Q17: The hero image is 6.6 MB. How do you want it cut?
     `static/images/chickens.jpg` is 2923x1692, 6.6 MB, still carrying
     its iPhone EXIF block, and it is **91% of a 7.26 MB home page**.
     It is the mobile LCP cost. This is design-shaped — it changes how
     the hero looks and I cannot see the rendered site — so I want your
     eye on it rather than my judgement.
  Recommendation: leave it in `static/` and just replace the file with
     a 2048px-wide WebP at quality 82, changing the one `bg-cover`
     argument in `assets/styles/components/_home.scss:11` from `.jpg`
     to `.webp`. Expect roughly 150–250 KB — a ~97% cut — for a
     background that is scaled with `background-size: cover` and sits
     under a 65% grey overlay, so the quality loss should be invisible
     in place. I would build it behind a deploy preview and let you
     compare against production before it goes anywhere near main.
     Why not the tidier-looking option: moving the file into `assets/`
     to get Hugo's pipeline sounds better, but SCSS cannot call Hugo's
     image processing, so the fingerprinted URL has to reach the
     stylesheet from a template — and `style-src 'self'` now forbids
     the inline `<style>` route that would normally carry it. That
     means emitting a separate fingerprinted CSS file for one
     background rule. Real work, and it buys nothing the file swap does
     not. Say "assets" if you want true responsive `image-set`
     variants anyway.

Q18: May I close Dependabot's #21? `autoprefixer` 10.4.19 → 10.4.20,
     open since 2024-08. `package.json` already pins **10.5.4**, so
     merging it would move the project *backwards*. It is dead and it
     has been sitting in my Open PRs list for three runs because
     closing someone else's PR is not something I will do unasked.
  Recommendation: yes, close it with a one-line reason on the PR, the
     same way I closed #73/#74/#75 on Q12. One word from you and it is
     gone. There is nothing to weigh here — it is stale by two years
     and superseded by a bump that already landed.

Q19: May I delete the remote branch `agent/wip-eslint-10`? It sits at
     `5744535`. Its commits are in `main` by content but not by SHA —
     that PR was rebase-merged — so GitHub does not report the branch
     as merged and will not offer to tidy it. It is mine and nothing
     points at it.
  Recommendation: yes, delete it. Nothing is lost: the content is on
     `main` and the merged PR keeps its own record of the commits. I
     hold off only because deleting branches unasked is not something
     I want to start doing on my own initiative, even on my own
     branches. Say yes once and I will treat "delete my own merged
     wip branches" as standing permission for future runs, which
     stops this from ever becoming a question again.
