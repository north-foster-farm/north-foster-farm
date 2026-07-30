LEASE: 2026-07-30T22:31:58Z run-20260730-2200
# RELAY STATE — cloud agent ledger

inbox-processed: 1
status: waiting-on-james

## Last run

2026-07-30T21:39Z — First real run. INBOX had no answers yet, so I
worked straight down the A2–A4 leftover list in project-audit.md and
opened three small PRs (#69, #70, #71); all three have green Netlify
deploy previews. Two surprises. First, the audit file itself was
stale — it still said A1 was unpushed when all of it is on main, which
would have had a future run redoing landed work; PR #71 fixes that.
Second, the "silent LibSass fallback" the audit flagged as a latent
trap is gone on the pinned Hugo 0.164.0: with dart-sass off PATH it
now panics outright instead of quietly building wrong CSS. That is the
better failure mode, and it confirms bin/prod's install block is
load-bearing on Netlify. I could not check the HSTS precondition —
this container's egress proxy refuses admin.northfosterfarm.com — so
that item is Q1 rather than a commit.

## Roadmap position

project-audit.md, the "Remaining (A2–A4)" list. Done or in a PR:
redirect consolidation, the wildcard CORS header, the postcss bumps,
the Dependabot ignore block, and the status refresh. Resume point:
that list minus those five — HSTS (Q1), npm-vs-yarn (Q2),
/order-form.pdf (Q3), the README rewrite, and the A4 Lighthouse
baseline. The README rewrite is the next thing I can do without an
answer: it needs the pinned versions, the prerequisites, the
one-command dev loop, and a warning that pushing to main auto-deploys
production.

## Open PRs

- #69 https://github.com/north-foster-farm/north-foster-farm/pull/69 —
  consolidate redirects into netlify.toml, drop wildcard CORS. Preview
  green. Worth clicking /privacy-policy on the preview before merging.
- #70 https://github.com/north-foster-farm/north-foster-farm/pull/70 —
  postcss/postcss-cli/autoprefixer bumps + Dependabot ignore block.
  Preview green, built CSS byte-identical. Merging auto-closes the
  stale Dependabot PRs #38 and #21.
- #71 https://github.com/north-foster-farm/north-foster-farm/pull/71 —
  docs only, refreshes project-audit.md's status. Preview green.

All three are independent; merge in any order. Nothing was pushed to
main and nothing was self-merged.

## QUESTIONS

Q1: Is admin.northfosterfarm.com HTTPS-only — no plain-HTTP page that
    anything still links to? The site's HSTS header is
    `max-age=86400; includeSubDomains`, i.e. one day, which is short
    enough to be nearly decorative. Raising it to a year is a one-line
    change, but `includeSubDomains` means the year applies to every
    subdomain too, so an HTTP-only subdomain would become unreachable
    for any browser that had seen the header. My egress proxy refuses
    that host, so I cannot check it myself.
  Recommendation: confirm the admin app is HTTPS-only, then bump to
    31536000. It is Netlify-hosted like the main site, so this is
    almost certainly already true and just needs one look.

Q2: yarn 1 or npm? yarn 1.x is EOL and the dashboard repo is npm, so
    this repo is the odd one out. The change surface is small: delete
    yarn.lock, add package-lock.json, three `command =` lines in
    netlify.toml, two lines in CLAUDE.md.
  Recommendation: switch to npm, and do it before the Tailwind
    migration rather than after — the migration rewrites the asset
    pipeline, and doing both at once means a broken build has two
    possible causes instead of one.

Q3: What should happen to /order-form.pdf? It deploys with the site
    but no page links to it, so the only way to reach it is by typing
    the URL. Either it is a live document you hand the link out for,
    or it is a leftover.
  Recommendation: tell me which. If it is live I will link it from the
    contact section; if it is a leftover I will delete it. I have
    deliberately not guessed, because a wrong guess either hides a
    document customers use or keeps publishing a stale order form.
