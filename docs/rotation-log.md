# Rotation log

One line per rotation of a secret (`docs/secrets.md`): name, date,
environment, reason, who. Names and dates only, never a value. The
yearly reminder (`netlify/functions/lib/rotation.mjs`) reads this file:
in the Dec 1 to Jan 1 window it lists every secret whose latest line is
dated before Dec 1, so a secret with no line here is never reminded.

Reason is `seed`, `schedule`, `set up` (first made, no earlier
credential), `leak`, `lost device` or `access ended`.
A `seed` line stands for a secret whose last change is not recorded; it
counts as due in the first window.

A secret that is not set up yet has a `planned` line: `planned` in the
date column and `planned, not done` as the reason. The reminder skips
it, the coverage check counts it, and James's confirmation that it
exists replaces it with a dated line. A row stays dated only with
evidence: an Actions secret that exists by name (`gh secret list`) or
James's word on GitHub. The #237 checklist tracks each planned row.

A routine rotation leaves the old credential valid for 31 days
(`docs/secrets.md`, rule 6); the day it is revoked gets a second line,
with reason `revoked`.

name | date | environment | reason | who
--- | --- | --- | --- | ---
SQUARE_ACCESS_TOKEN | planned | production | planned, not done | James
SQUARE_ACCESS_TOKEN | planned | staging | planned, not done | James
SQUARE_WEBHOOK_SIGNATURE_KEY | planned | production | planned, not done | James
SQUARE_WEBHOOK_SIGNATURE_KEY | planned | staging | planned, not done | James
PAYPAL_CLIENT_SECRET | planned | production | planned, not done | James
PAYPAL_CLIENT_SECRET | planned | staging | planned, not done | James
RESEND_API_KEY | planned | production | planned, not done | James
RESEND_AUDIENCE_KEY | planned | production | planned, not done | James
RESEND_WEBHOOK_SECRET | planned | production | planned, not done | James
AXIOM_TOKEN | planned | production | planned, not done | James
AXIOM_TOKEN | planned | staging | planned, not done | James
BACKUP_R2_ACCESS_KEY_ID | planned | production | planned, not done | James
BACKUP_R2_SECRET_ACCESS_KEY | planned | production | planned, not done | James
HEALTHCHECKS_JOBS_URL | planned | production | planned, not done | James
HEALTHCHECKS_JOBS_URL | planned | staging | planned, not done | James
HEALTHCHECKS_ALERT_URL | planned | production | planned, not done | James
HEALTHCHECKS_ALERT_URL | planned | staging | planned, not done | James
HEALTHCHECKS_BACKUP_URL | planned | production | planned, not done | James
HEALTHCHECKS_PACKING_URL | planned | production | planned, not done | James
PICKUP_SCHEDULE_HOOK | planned | production | planned, not done | James
GATE_RESEND_KEY | planned | staging | planned, not done | James
STOCK_SOURCE_TOKEN | planned | staging | planned, not done | James
age private key | planned | production | planned, not done | James
MAINTENANCE_SECRET | planned | production | planned, not done | James
MAINTENANCE_SECRET | planned | staging | planned, not done | James
NETLIFY_AUTH_TOKEN | planned | all | planned, not done | James
netlify CLI login | planned | all | planned, not done | James
STAGING_TOKEN | 2026-10-26 | staging | schedule | James
E2E_STAGING_TOKEN | 2026-10-26 | staging | schedule | James
ntfy topic | 2026-10-26 | production | set up | James
PROD_AUDIT_PING_URL | 2026-10-26 | production | set up | James
E2E_STAGING_PING_URL | 2026-10-26 | staging | set up | James
