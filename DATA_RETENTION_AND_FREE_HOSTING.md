# Data retention, compression, backups, and Render free service

## Recommended policy for a 100–300 student madrasa

Do not automatically erase all data every six months. Use an archive-and-verify cycle:

1. Export human-readable reports for the six-month period (CSV/XLSX/PDF).
2. Create a full compressed MongoDB backup with `scripts/backup-mongodb.sh`.
3. Copy the backup and checksum to two controlled locations (for example, a school-controlled computer plus an encrypted external drive or approved private cloud storage).
4. Verify the checksum and perform a restore into a separate test database. Confirm student, class, attendance, user, and audit record counts.
5. Only then decide whether old attendance can be archived/removed under the madrasa's written retention policy.
6. Never automatically delete active student profiles, account records, or the only copy of attendance history. Keep records as long as required by school policy and applicable law.

## MongoDB storage and compression

Atlas Free has a hard 512 MB / 0.5 GB storage limit for data plus indexes. MongoDB's storage engine already compresses data internally. Do not store full classroom images or generated report files in MongoDB documents. Store only small metadata and photo URLs; consider storing biometric descriptors only where consent and access controls permit.

Compressed `mongodump --gzip` backups reduce archive size, but **do not reduce the live Atlas database size**. Removing old records only reduces live storage; it should happen after a verified independent archive and policy approval.

## Run a backup

Install MongoDB Database Tools, set `MONGODB_URI` in your shell, and run:

```bash
export MONGODB_URI='your MongoDB connection string'
bash scripts/backup-mongodb.sh
```

Keep the connection string private. Do not commit `.env`, database URIs, student photos, or backup files to GitHub.

Restore into a separate test database first:

```bash
export MONGODB_URI='mongodb+srv://.../madrasa_restore_test'
bash scripts/restore-mongodb.sh backups/madrasa-mongodb-YYYYMMDDTHHMMSSZ.archive.gz
```

The restore script intentionally does not use `--drop`. Review the target database carefully before restoring into any live database.

## Render health ping

The optional `.github/workflows/render-health-ping.yml` calls `/api/health` every 10 minutes. To enable it:

1. Push this project to a GitHub repository.
2. Open repository Settings → Secrets and variables → Actions → Variables.
3. Add `RENDER_HEALTH_URL` with the full URL, e.g. `https://your-api.onrender.com/api/health`.
4. Enable Actions for the repository and run the workflow once manually.

Important:
- This ping is best-effort and may wake the free service, reducing cold starts if it runs regularly.
- GitHub scheduled workflows may be delayed, disabled, or skipped, so it cannot guarantee that Render stays awake continuously.
- Render free web services can restart or spin down; they have ephemeral local storage. Store persistent data in MongoDB / a proper object-storage service, not in the Render filesystem.
- Use Render's own health-check path setting for deploy/readiness checks. A health endpoint is not a backup and does not guarantee database health unless it explicitly checks MongoDB.
- If the madrasa requires reliable always-on attendance, consider a paid always-on service or another provider's suitable free allowance rather than relying on a keep-alive workaround.
