# Backup and restore

Every night at 07:00 UTC the `backup` function copies every record in
the orders and customers stores into one JSON document, encrypts it
with [age](https://age-encryption.org) to James's public key and puts
it in a Cloudflare R2 bucket. Subscribers are customer records with
`marketing`, so they travel with the customers. The site holds only
the public key: nothing that runs can read a backup, and a leaked
token yields ciphertext. Only James's private key opens one. Copies
are kept 30 days: that is how long deleted customer details can
remain in them (the privacy page says so).

The code is `netlify/functions/backup.mjs` and
`netlify/functions/lib/backup.mjs`; the alert is `backup.failed` in
`docs/monitoring.md`. A Backblaze B2 second copy, versioned record
shapes and a recovery procedure for every store come after launch
(#267, D-EXPORT).

## Setting it up

1. **The key.** On James's Mac, `age-keygen -o nff-backup.key`. It
   prints the public key (`age1...`). Keep the file off the site and
   out of every repository, with a second copy somewhere offline;
   lose both and every backup is unreadable.
2. **The bucket.** On the business's Cloudflare account: R2 → Create
   bucket, a dedicated one (say `nff-backups`). Backups are kept 30
   days (D-189, 2026-10-17), so two rules, both 30 days: under
   Settings → Object Lock, a lock rule, so nothing can delete or
   overwrite a copy before then; and an object lifecycle rule that
   deletes every object older than 30 days. Every key is unique to the
   second, so the lock never blocks a night's upload. A copy from
   `export --label before-release` goes the same way after 30 days.
3. **The token.** R2 → Manage API tokens → Create: permission *Object
   Read & Write*, applied to that bucket only. R2 offers no write-only
   permission; the lock stops deletes and the encryption makes reads
   worthless. Keep the access key id, the secret and the S3 endpoint
   (`https://<account id>.r2.cloudflarestorage.com`).
4. **The check.** Healthchecks, a *Backup* check: period 1 day, grace
   2 hours, with the phone integration (`docs/monitoring.md`).
5. **The variables**, in `.env.production` and on Netlify's
   production context (`bin/nff env push --production`):

   | Variable | Value |
   |---|---|
   | `BACKUP_AGE_RECIPIENT` | the `age1...` public key |
   | `BACKUP_R2_ENDPOINT` | the S3 endpoint |
   | `BACKUP_R2_BUCKET` | the bucket's name |
   | `BACKUP_R2_ACCESS_KEY_ID` | the token's access key id |
   | `BACKUP_R2_SECRET_ACCESS_KEY` | the token's secret |
   | `HEALTHCHECKS_BACKUP_URL` | the *Backup* check's ping URL |

   Staging and development leave them unset; the nightly run then does
   nothing, and scheduled functions run on production only anyway.
6. **Prove it.** `bin/nff --production export --label setup` puts a
   copy in the bucket and says where. The next night's run turns the
   check green.

## Copies before and after a release

```bash
bin/nff --production export --label before-release
bin/nff --production export --label after-release
```

Each lands in the bucket as
`production/<UTC time>-<label>.json.age`, beside the nightly copies.
`--out <file>` keeps the encrypted copy in that file instead of
uploading it. Neither pings the check, so a manual copy never hides a
missed night.

## Restoring

The rehearsal before launch, and any real restore, start the same
way. James does the decryption; no agent holds the key.

1. **Download.** Cloudflare → R2 → the bucket → the object
   (`production/...-nightly.json.age`) → Download.
2. **Decrypt**, on James's Mac:

   ```bash
   age -d -i nff-backup.key -o backup.json \
     production-2026-10-16T07-00-00Z-nightly.json.age
   ```

   `backup.json` is every customer's name, email and address in the
   clear. Keep it out of the repository, and delete it when done.
3. **Restore into scratch stores.** With development's `.env`:

   ```bash
   bin/nff restore backup.json --scratch
   ```

   `--scratch` keeps development's keys but uses stores of its own
   (`scratch-orders`, `scratch-customers`), and the restore refuses
   stores that already hold anything, so it can touch neither
   production nor development's data. Without `--scratch` it refuses.
4. **Check the counts.** The restore prints what the backup says it
   holds (`expected`) and what the stores hold after it (`found`):
   keys per store, orders, customers and subscribers. It ends
   "every count matches" or exits 1. Compare `orders` with
   `bin/nff --production orders list` taken at about the backup's
   time, and look at a few records with
   `bin/nff --scratch orders show <id>`.
5. **Clear.** `bin/nff restore --clear --scratch` empties the scratch
   stores; then delete `backup.json`.

A real restore into production is not a command. What a backup should
replace is James's decision, made with a developer, and the records go
back from the checked scratch copy by hand; `bin/nff` has no flag for
it.

## Rehearsal record

Before launch, James runs steps 1 to 5 once on a production copy and
notes here the date, the object restored and the counts.

- Not yet run.
