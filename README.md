# virtualCrypto backup upload gate

This repository owns the independent Cloudflare Worker that admits encrypted backups and enforces storage/operation limits. It is public; only repository collaborators may create pull requests. Its GitHub Actions run tests without production credentials.

The Fly runner, container image, and automated deployment belong to [virtualCrypto3/ops/backup](https://github.com/virtualCrypto-discord/virtualCrypto3/tree/main/ops/backup). The vc3 deployment can change future backups but has no authority to deploy this Worker, manage R2 retention, or retrieve the age private key. Migrate vc3 first, then merge this repository's cleanup; the existing scheduled Machine continues running throughout.

## Data path

Scheduled Fly Machine → Fly-private PostgreSQL using a SELECT-only role → custom-format gzip PostgreSQL dump → age encryption → authenticated Cloudflare Worker → private R2 Standard bucket. The Machine runs once daily, exits when done, and does not restart on failure. There are no public listeners or dedicated public IPs. A 10-minute process timeout bounds each execution. Plaintext archives exist only in temporary storage during a run.

The age **private key is never given to GitHub, Fly, or Cloudflare**. Preserve it in an independent secure location: losing it makes every backup unusable. The public recipient is embedded in vc3’s `ops/backup/scripts/backup.py`. Encryption framing and checksum checks at ingress detect mistakes; they do not prove that an authorized sender supplied a valid backup. Restore testing remains necessary.

## Limits and cost

- Ciphertext: at most **32 MiB per upload**.
- Admission: at most **3 attempts per UTC day**, including failed attempts. Same-ID successful retries return the existing receipt without writing again.
- Total reserved storage: **1 GiB**, including pending and failed uploads; at most 256 ledger entries.
- Cleanup verification: **128 HEAD operations per UTC day**, persistently reserved before R2 is called, including failed requests.
- Existing data is locked for **30 days**, lifecycle expiry is **35 days**. Quota is released only after day 36 and a successful HEAD confirms deletion. Failed cleanup stops new backups rather than increasing capacity.
- A dump exceeding the size limit fails; limits are never raised automatically.
- Worker and SQLite Durable Objects remain on **Workers Free**. No automatic plan upgrade.

With an otherwise unused R2 Standard free allocation, these limits fit within free usage. At current rates, without a free allocation and with billing-unit rounding, this workload contributes at most approximately **$4.89/month** for R2 (2 GB-month × $0.015 + one Class A million × $4.50 + one Class B million × $0.36), excluding taxes, Fly Machine costs, other workloads, and administrative/restore operations. The daily Fly job adds running-time, stopped-rootfs, and egress charges; it is not covered by the R2 estimate. Keep a single 256 MiB Machine in the database region, no volume, no dedicated IPv4, a 10-minute process timeout, and restart policy `no`. These are application limits, **not a Cloudflare account spending cap**. Administrator credentials, alternate R2 access paths, or a faulty Worker deployment can bypass them. Budget alerts only notify; they do not stop billing.

Pricing: https://developers.cloudflare.com/r2/pricing/

## Credentials

The Worker has `UPLOAD_TOKEN`, `STATUS_TOKEN`, and `DISCORD_WEBHOOK_URL` secrets. The status token is kept locally for freshness checks. Fly holds its own upload token and database credentials, managed by vc3; this repository does not deploy the Fly app.

The Worker R2 binding is broader than the exposed upload API; the 30-day bucket lock is an independent deletion safeguard. Expiry uses R2 lifecycle, so no deletion token is distributed. Worker and R2 management credentials must not be placed in vc3 Actions or the Fly app. GitHub Actions in this repository receives no deployment credentials either; Worker updates currently run from a trusted workstation. The DB disclosure risk through vc3 deployment is accepted; the independent gate protects retained backups and bounds submissions from a compromised runner.

## Operations

- Fly daily scheduling is approximate, not an exact wall-clock time. Inspect Machine exit status and backup freshness; schedule failures need operator intervention.
- `scripts/status.py` checks freshness with the locally held status token and fails after 30 hours without a successful upload. Fly sends a Discord notification if the job fails. Worker checks hourly and sends a stale/capacity alert at most once per UTC day. Discord outages are logged without unbounded retries. The Worker supplies independent monitoring if the Fly job never starts.
- If full, investigate failed uploads or lifecycle configuration. Do not clear the ledger while objects exist. Keep the singleton name `production-v1` and its durable state across deployments. Changing it would reset accounting.
- Restore credentials are held separately from the upload job. Use read-only access to retrieve the receipt's object, decrypt locally with `age -d -i /safe/identity.txt -o backup.dump backup.dump.age`, and restore into an isolated PostgreSQL 18 database using `pg_restore --no-owner --no-acl --exit-on-error`. Never overwrite production as a restore test. Check schema, constraints, table counts, and business data before using a restored database.
- Rotate the Fly-only DB password if the backup environment is compromised. Rotate the upload token separately. Retention protects old objects, but compromised upload credentials can exhaust the daily quota or submit invalid backups.

## Development and deployment

Node.js 24: `npm ci && npm run check`. The local status helper uses the Python standard library. The Fly image and its deployment are maintained in vc3.

Deploy locally with `npx wrangler deploy`, then populate the secrets with `npx wrangler secret bulk` using a protected local input file. R2 bucket, retention lock, and lifecycle are provisioned separately and must be verified before enabling the schedule. Do not enable public bucket access.

## Deployed configuration and verification

The Fly Machine configuration and deployment instructions have moved to vc3. Moving the code does not recreate the Machine, reset the Worker ledger, rotate the age recipient, or alter existing R2 objects or retention settings.

Initial end-to-end verification (2026-10-22 UTC): a 9,122,914-byte age-encrypted archive was created inside Fly, uploaded to R2, downloaded locally, checked against its SHA-256 receipt, decrypted, and restored into an isolated PostgreSQL 18 container. All 28 public tables restored; payment history 496,289 rows, users 32,655 rows, assets 44,577 rows. The temporary restore container, volume, and decrypted restore archive were removed. Worker admission, read-budget, and notification suppression tests pass. Discord delivery failures are bounded and logged; automated retry storms are deliberately avoided.
