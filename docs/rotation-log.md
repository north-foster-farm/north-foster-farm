# Rotation log

One line per rotation of a secret (`docs/secrets.md`): name, date,
environment, reason, who. Names and dates only, never a value. The
yearly reminder (`netlify/functions/lib/rotation.mjs`) reads this file:
in the Dec 1 to Jan 1 window it lists every secret whose latest line is
dated before Dec 1, so a secret with no line here is never reminded.

Reason is `seed`, `schedule`, `leak`, `lost device` or `access ended`.
A `seed` line stands for a secret whose last change is not recorded; it
counts as due in the first window.

name | date | environment | reason | who
--- | --- | --- | --- | ---
SQUARE_ACCESS_TOKEN | 2026-10-18 | production | seed | prod agent
SQUARE_ACCESS_TOKEN | 2026-10-18 | staging | seed | prod agent
SQUARE_WEBHOOK_SIGNATURE_KEY | 2026-10-18 | production | seed | prod agent
SQUARE_WEBHOOK_SIGNATURE_KEY | 2026-10-18 | staging | seed | prod agent
PAYPAL_CLIENT_SECRET | 2026-10-18 | production | seed | prod agent
PAYPAL_CLIENT_SECRET | 2026-10-18 | staging | seed | prod agent
RESEND_API_KEY | 2026-10-18 | production | seed | prod agent
RESEND_AUDIENCE_KEY | 2026-10-18 | production | seed | prod agent
RESEND_WEBHOOK_SECRET | 2026-10-18 | production | seed | prod agent
AXIOM_TOKEN | 2026-10-18 | production | seed | prod agent
AXIOM_TOKEN | 2026-10-18 | staging | seed | prod agent
BACKUP_R2_ACCESS_KEY_ID | 2026-10-18 | production | seed | checkout agent
BACKUP_R2_SECRET_ACCESS_KEY | 2026-10-18 | production | seed | prod agent
HEALTHCHECKS_JOBS_URL | 2026-10-18 | production | seed | checkout agent
HEALTHCHECKS_JOBS_URL | 2026-10-18 | staging | seed | checkout agent
HEALTHCHECKS_ALERT_URL | 2026-10-18 | production | seed | checkout agent
HEALTHCHECKS_ALERT_URL | 2026-10-18 | staging | seed | checkout agent
HEALTHCHECKS_BACKUP_URL | 2026-10-18 | production | seed | checkout agent
ntfy topic | 2026-10-18 | production | seed | checkout agent
PICKUP_SCHEDULE_HOOK | 2026-10-18 | production | seed | checkout agent
STAGING_REVIEWER_TOKEN | 2026-10-18 | staging | seed | checkout agent
age private key | 2026-10-18 | production | seed | prod agent
STAGING_TOKEN | 2026-10-18 | staging | seed | prod agent
E2E_STAGING_TOKEN | 2026-10-18 | staging | seed | prod agent
MAINTENANCE_SECRET | 2026-10-18 | production | seed | prod agent
MAINTENANCE_SECRET | 2026-10-18 | staging | seed | prod agent
NETLIFY_AUTH_TOKEN | 2026-10-18 | all | seed | prod agent
netlify CLI login | 2026-10-18 | all | seed | prod agent
