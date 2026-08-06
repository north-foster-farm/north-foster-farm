# RELAY STATE — cloud agent ledger

inbox-processed: 5
status: waiting-on-james

## Last run

2026-08-06T23:39Z — INBOX sequence is still 5, so by the protocol this
was a no-op run. It did not stay one. Pushing the lease commit made
GitHub answer back that there is a **high-severity vulnerability on
main**, which appears nowhere in any previous ledger entry. `npm audit`
found two, both high, neither with a Dependabot PR behind it. Both are
fixed in #84, which is green.

The vulnerabilities are the small part. What matters is **why you never
heard about them.** Both sit under `stylelint`, and `stylelint` is one
of the six packages in the `ignore` list added to
`.github/dependabot.yml` on 2026-07-30 to stop Dependabot chasing the
retiring SCSS stack. A Dependabot `ignore` entry suppresses *security*
updates as well as version updates — the two are not separately scoped
unless you say so. So for the past week that ignore list has been
silently swallowing security alerts for six packages, and it will keep
doing it until the Tailwind migration removes them. That is Q16, and it
is the thing to read first.

The fix itself is deliberately boring: two in-range patch bumps
(`js-yaml` 4.3.0→4.3.1, `fast-uri` 3.1.4→3.1.5), lockfile only,
`package.json` untouched. Neither package reaches a visitor — bootstrap
is the only runtime dependency and it audits clean; these come in
through the lint toolchain and only ever see the repo's own files. So
it is hygiene, not an incident, and it does not warrant an out-of-hours
merge.

I verified it rather than assuming it: built `public/` under the old
lockfile and the new one and compared a sha256 over every file —
identical (`064cc411…3428b4`). Netlify's "Pages changed" check came
back neutral on the PR, which is an independent second opinion saying
the same thing. Lint green, and a real `hugo --environment production`
build with the pinned 0.164.0 extended plus Dart Sass 1.79.5 exits 0.

Two notes on the runbook itself. My instructions still say to run
`yarn install`; the repo moved to npm when Q2 landed, so I used npm and
respected `package-lock.json` — worth correcting in the stored prompt
before it confuses a future run. And `bin/prod` is genuinely
unrunnable here as documented, but only because of the Dart Sass step:
fetching Dart Sass 1.79.5 directly to a temp path (the same version
`bin/prod` pins) makes a full production build work fine in this
container. Local builds are a real check now, not just the preview.

## Roadmap position

Unchanged — the audit and its follow-on work remain finished, and this
run added no roadmap progress. #84 is a security interrupt, not a
roadmap item.

Resume point: nothing is half-done. The next arc is still the Tailwind
migration, which I will not start on my own (Q15). Q5 (your manual
PageSpeed baseline) is still the single most useful thing you could do,
and is still yours to run.

## Open PRs

- #84 https://github.com/north-foster-farm/north-foster-farm/pull/84 —
  mine, this run. Clears both high-severity advisories. All three
  Netlify checks green, deploy preview built, lockfile-only, output
  proven byte-identical. Waiting on you to merge; I do not self-merge.
- #21 — Dependabot, "Bump autoprefixer from 10.4.19 to 10.4.20", open
  since 2024-08. Obsolete: `package.json` already pins autoprefixer
  10.5.4, so this PR would move it backwards. Not my branch, so I have
  left it alone — but it is dead and wants closing. Say the word and I
  will close it with a reason, as I did for #73/#74/#75.

## QUESTIONS

Q16: Should I scope the Dependabot `ignore` entries so they suppress
     version updates but still let security updates through? Right now
     the six ignored packages (`bootstrap`, `@popperjs/core`,
     `@fullhuman/postcss-purgecss`, `stylelint`,
     `stylelint-config-standard-scss`, `stylelint-scss`) get no
     security PRs at all, which is how tonight's two advisories reached
     `main` unannounced and sat there. This is not theoretical — it
     already happened once, and I only caught it because git happened
     to print a warning at me.
  Recommendation: yes, and it is a small, safe change. Adding
     `update-types: ["version-update:semver-major",
     "version-update:semver-minor", "version-update:semver-patch"]` to
     each ignore entry scopes the ignore to *version* updates only, so
     you keep exactly the noise reduction you wanted on 2026-07-30 and
     get your security alerts back. Nothing else about the file
     changes. I would rather do this than lift the ignores outright —
     that would restore the Bootstrap PR pile you deliberately killed.

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
