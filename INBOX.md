# RELAY INBOX — James → cloud agent

sequence: 5

## Answers

Q10: Yes, remove @popperjs/core once #81 merges — its own commit,
     not bundled into #81.

Q11: Yes, finish the CSP via the external fingerprinted file
     route for the JSON-LD schema blocks, not SHA-256 hashes.

Q12: Yes, close Dependabot's #73, #74 and #75 once #82 merges,
     with a one-line reason on each.

Q7: The nav is not coming back — that scaffolding is dead. Delete
    the Bootstrap Collapse import, the two menu partials, and the
    .nav-link / .navbar-flex-group rules. Go ahead and drop the
    JS bundle down to ~0.5 KB gzipped.

Q8: Yes, drop 'unsafe-inline' from style-src now rather than
    waiting for Tailwind. Move the --bs-breadcrumb-divider custom
    property into a class in footer/menu.html and
    social-media.html.

Q9: Yes, delete .waves / .parallax in
    components/_waves.scss — it's unreferenced by any template.
    No need for a throwaway preview branch first.

Q4: Yes, take eslint 10 — build it as your own combined PR
    bumping eslint to 10.8.0 and @eslint/js to 10.0.1 together
    (plus globals to 17 if you're bundling #75 in). Leave the
    separate Dependabot PRs #73/#74 unmerged/closed once your
    combined PR lands, since merging them individually is exactly
    the mismatched-majors problem you flagged.

Q5: Tried to pull PageSpeed Insights scores myself so you
    wouldn't have to, but Google's public API rate-limited the
    anonymous request (no API key configured on this machine).
    Still open — I'll run it manually and send scores through a
    later INBOX update. Don't block other work on it.

Q6: Yes — build the read-only Tailwind migration inventory next
    (Bootstrap component/utility usage map, genuine-custom vs.
    override SCSS, CSP style-src needs). No code changes.

Q1: Confirmed — admin.northfosterfarm.com is HTTPS-only, no
    plain-HTTP page linked anywhere. Do NOT raise HSTS max-age
    yet, though. Add "raise HSTS max-age to 31536000
    (includeSubDomains, confirmed HTTPS-only)" to project-audit.md
    as a slated future item, not an immediate commit.

Q2: npm. Proceed with the yarn -> npm switch as recommended
    (delete yarn.lock, add package-lock.json, update netlify.toml
    command lines and CLAUDE.md), before the Tailwind migration.

Q3: /order-form.pdf is a deliberate temporary solution for not
    having e-commerce yet. Leave it as-is — do not link it and do
    not delete it. It will be superseded and removed when e-comm
    rolls out; note that in project-audit.md so a future run
    doesn't re-flag it as an orphaned leftover.

## Redirects

(none — free-form steering goes here, e.g. "skip A3, do A4 next")
