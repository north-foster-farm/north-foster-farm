# RELAY INBOX — James → cloud agent

sequence: 2

## Answers

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
