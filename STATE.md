# RELAY STATE — cloud agent ledger

inbox-processed: 4
status: waiting-on-james

## Last run

2026-07-31T00:03Z — Applied INBOX sequence 4. Q7/Q8/Q9 became PR #81 and
Q4 was rebuilt as PR #82; both are green. **One thing you need to know
before merging #81: I got part of Finding 2 in the inventory wrong, and
my Q7 question inherited the error.** I told you to delete "the two menu
partials". `header/menu.html` is NOT dead — despite the name it does not
range over a menu, it *is* the header (the logo and the social strip), and
deleting it would have visibly broken every page. I caught it while
implementing, kept the file, and corrected `docs/tailwind-inventory.md`
in #81 rather than leaving the error on main. Only
`header/menu-item.html` was actually orphaned. Related: menus are not
missing from the site at all — they are declared in **content front
matter** (`accessibility.md` and `privacy.md` both carry `menu: footer:`),
not in `config/`, so the footer menu is live. My "no `[menu]` anywhere in
`config/`" was literally true and misleading.

Everything else in Q7 held up: `Collapse` was bound to nothing, and
removing it took the JS bundle from 24,556 to **837 bytes gzipped**. Q8
went in with `style-src 'self'` and I verified after building that no
`style=` attribute or `<style>` block survives anywhere in `public/`, so
the tightened CSP cannot break a page. Q9 deleted as asked.

On #79: you had LGTM'd it, so it was approved, and it still closed
unmerged at `mergeable_state: dirty`. That was my stacking, not the
change — I based it on `agent/wip-npm-migration`, that branch was never
deleted, so GitHub never retargeted it to main. #82 is the same change
rebuilt against main as an ordinary two-file diff. If you would rather it
stay dead, close it and say so in INBOX; I rebuilt it because the Q4
answer is still the standing instruction there.

## Roadmap position

Audit closed, inventory landed and now corrected. Resume point: nothing
is blocked and nothing is half-done — #81 and #82 are the whole of the
outstanding work and both need only your merge. The next arc is Tailwind
proper, which I am not starting on my own. Q5 (PageSpeed) is still open
and still not blocking; note that after #81 the JS payload is 96.6%
smaller, so a baseline taken before it merges measures a site that no
longer exists. Take it after #81 lands.

## Open PRs

- #81 https://github.com/north-foster-farm/north-foster-farm/pull/81 —
  Q7+Q8+Q9. Dead `Collapse` import, `header/menu-item.html`, the
  `.nav-link`/`.navbar-flex-group` rules and `_waves.scss` all removed;
  the breadcrumb divider moved into a class so `style-src` can drop
  `'unsafe-inline'`. **Preview green.** Also carries the Finding 2
  correction. JS 83,049 → 1,737 B raw, 24,556 → 837 B gzipped. HTML diff
  against the pre-change build is exactly the three `<nav>` tags and the
  two asset hashes. *Worth an eyeball on the preview: the `・` separators
  in the social strip and footer are the one visible thing in it.*
- #82 https://github.com/north-foster-farm/north-foster-farm/pull/82 —
  Q4 rebuilt against main. eslint 10.8.0 + @eslint/js 10.0.1 + globals
  17.8.0. Lint green, production build green, output byte-identical to
  the pre-bump baseline. `npm audit` 9 → 5 (both sides measured on this
  branch), `--omit=dev` 0 before and after. Replaces the closed #79.

Merged since last run: #76, #77, #78, #80. Nothing pushed to main,
nothing self-merged, no LGTM labels applied by me.

## QUESTIONS

Q10: Remove `@popperjs/core` from `package.json`? The audit previously
     recorded "do NOT remove it — `bootstrap.esm.min.js` imports it, so
     esbuild bundles it". That was correct then. #81 removes the only
     import of Bootstrap's JS, so nothing pulls Popper in any more and
     the dependency is now genuinely dead. `bootstrap` itself stays —
     the SCSS still needs it until Tailwind.
  Recommendation: yes, but *after* #81 merges, not bundled into it — the
     claim only becomes true once #81 lands, and I would rather the
     removal be its own commit that a `git log` can explain. One line,
     and I will prove the build is byte-identical.

Q11: Finish the CSP by killing `script-src 'unsafe-inline'` too? The only
     thing keeping it alive is six inline `<script type="application/ld+json">`
     schema blocks — the one real script is external with `src` +
     `integrity`, so `'self'` already covers it. Two routes: emit the
     JSON-LD as a fingerprinted file and reference it, or compute SHA-256
     hashes and list them in the policy.
  Recommendation: the external file. Hashes mean the CSP has to be
     regenerated every time the schema content changes, which is a
     footgun on a site where content edits are the normal case; a file
     just works and gets the same caching treatment as everything else.
     Slightly larger job than Q8 was, but self-contained.

Q12: Want me to close Dependabot's #73, #74 and #75, or will you? They
     are no longer merely superseded — they are **broken**. All three
     were generated against `yarn.lock`, which no longer exists on main
     (#74's diff is `package.json` plus 305 lines of `yarn.lock`), so
     merging any of them now is a delete/modify conflict. Dependabot will
     reopen equivalents against `package-lock.json` on its next run.
  Recommendation: close all three once #82 merges. I have not touched
     them — they are not my branches and closing them is a write on
     someone else's PR, so I would rather you said go first. Say the word
     and I will close them with a one-line reason on each.
