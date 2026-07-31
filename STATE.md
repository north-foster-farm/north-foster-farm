LEASE: 2026-07-31T02:35Z hourly-roadmap
# RELAY STATE — cloud agent ledger

inbox-processed: 5
status: waiting-on-james

## Last run

2026-07-31T00:21Z — Applied INBOX sequence 5. Q10 and Q11 became PR #83
(now merged), and Q12 is done: #73, #74 and #75 are closed with a
one-line reason on each. **You approved the wrong thing on Q11 and I did
not build it.** You said "external fingerprinted file, not hashes" —
because I told you the six inline JSON-LD blocks were holding
`script-src 'unsafe-inline'` in place. They were not.
`application/ld+json` is a *data block*: the browser never executes it,
so CSP never evaluates it. Nothing was holding `'unsafe-inline'`, so I
deleted it outright. That matters beyond tidiness — the route I
recommended would have been actively harmful, since JSON-LD is not
fetched via `src` and Google's structured-data crawler wants it inline,
so it would have cost a real SEO signal to buy nothing.

I measured it rather than arguing it, in the container's headless
Chromium: a probe page under `script-src 'self'` carrying both an inline
JSON-LD block and an inline executable script reports exactly one
violation — the executable one — and the control script demonstrably did
not run. Then the real built site under the exact production policy:
zero violations across `/`, `/privacy/`, `/accessibility/` and
`/404.html`, with a `script-src 'none'` negative control confirming the
harness detects violations when they exist. `docs/tailwind-inventory.md`
is corrected; it had asserted the opposite.

Q10 landed with an honest caveat rather than a headline: removing
`@popperjs/core` from `dependencies` does **not** shrink `node_modules`,
because bootstrap 5.3.3 declares it as a `peerDependency` and npm still
installs it. It is a declaration fix, and it disappears for real when
bootstrap does.

## Roadmap position

**The audit and all of its follow-on work are finished.** `main` now
carries: Hugo 0.164.0 / Node 26 pinned and matched, npm, eslint 10,
the cache-control split, no dead Bootstrap JS, no dead SCSS, and a CSP
whose `script-src` and `style-src` are both plain `'self'`. The JS
bundle is 837 bytes gzipped, down from 24,556.

Resume point: nothing is in flight and nothing is half-done. The next
arc is the Tailwind migration itself, which I have a standing
instruction not to start on my own — hence Q15. Q5 (PageSpeed) is now
not just unblocked but *meaningful*: the site is finally in its
pre-migration final shape, so a baseline taken now is the one worth
keeping. It is the single most useful thing you could do next.

## Open PRs

(none)

Merged this run: #83. Closed this run: #73, #74, #75 (Q12, with reasons
posted). Merged earlier tonight: #76, #77, #78, #80, #81, #82. Nothing
pushed to main, nothing self-merged, no LGTM labels applied by me.

## QUESTIONS

Q13: Are `layouts/_default/single.html`, `section.html` and `list.html`
     leftovers, or is content coming for them? All three currently
     render on **no page** — `content/` holds exactly three files, and
     they are served by `index.html` (home), `policy/single.html`
     (accessibility, privacy) and `404.html`. This is not idle
     curiosity: those three templates are the only thing referencing
     `.page-content`, `.circle`, `.inner`, `.list-group-img` and
     `.img-supporting`, so your answer decides whether ~5 dormant SCSS
     blocks get hand-ported to Tailwind or deleted before the migration
     starts.
  Recommendation: tell me what is coming. If a shop/products section is
     planned, they stay and get ported; if they are scaffolding from an
     earlier shape of the site, I would delete them and their SCSS now,
     while the inventory is fresh — porting dead templates is the most
     wasteful thing the migration could do.

Q14: Ready to take HSTS `max-age` to 31536000 now? You slated it rather
     than committing it back on Q1, having confirmed
     `admin.northfosterfarm.com` is HTTPS-only. It is still at 86400,
     which is short enough to be close to decorative. Everything that
     was uncertain then is settled now, and the rest of the header block
     is as tight as it is going to get before Tailwind.
  Recommendation: yes, take it — one line in `netlify.toml`. The only
     real risk with a long `includeSubDomains` max-age is a subdomain
     that needs plain HTTP later, and you have already ruled that out.
     If you would rather stage it, say so and I will go to 2592000 (30
     days) as a checkpoint instead of the full year.

Q15: What is the first Tailwind step you actually want? The prep work is
     genuinely done and I am told not to start the framework rewrite, so
     I will not pick this myself.
  Recommendation: a single-page spike on a throwaway branch — convert
     `/privacy` or `/404` only, leave Bootstrap in place for everything
     else, and put it behind a deploy preview you can look at. It costs
     little, it is fully reversible, and it puts a real number on the
     one thing the inventory could not: how much work the 10 `@extend`
     sites and the `tint-color`/`shade-color` calls actually are in
     practice. That is the difference between an estimable migration and
     an open-ended one, and it is not the rewrite itself.
