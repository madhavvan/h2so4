# Off-site database backups

`server/src/backup.js` takes a daily `VACUUM INTO` SQLite snapshot and keeps 7
days. By default those snapshots sit on the **same Railway volume** as the live
database — so a volume delete/detach/corruption loses the backups too. That is
the single largest unrecoverable risk in the system.

`server/src/backupOffsite.js` uploads each snapshot to an off-site
S3-compatible bucket (AWS S3 / Cloudflare R2 / Backblaze B2). It is
**dependency-free** (AWS SigV4 via Node `crypto` + global `fetch`) and **off by
default** — no `BACKUP_S3_*` env vars means it is a complete no-op.

## Enable

Set these on Railway and redeploy:

| Var | Required | Notes |
|-----|----------|-------|
| `BACKUP_S3_BUCKET` | yes | bucket name |
| `BACKUP_S3_ACCESS_KEY_ID` | yes | |
| `BACKUP_S3_SECRET_ACCESS_KEY` | yes | |
| `BACKUP_S3_REGION` | no | `auto` for R2; your region for AWS S3 |
| `BACKUP_S3_ENDPOINT` | R2/B2 | e.g. `https://<acct-id>.r2.cloudflarestorage.com`; **omit** for AWS S3 (virtual-hosted URL is derived) |
| `BACKUP_S3_PREFIX` | no | key prefix, default `minicaai-db-backups` |
| `BACKUP_ENCRYPTION_KEY` | no | 64 hex chars (32 bytes) → client-side AES-256-GCM **before** upload, so the bucket holder never sees plaintext PII |

### Cloudflare R2 (recommended — no egress fees)
1. Create a bucket.
2. Create an R2 API token with **Object Read & Write** → it gives an Access Key ID + Secret Access Key.
3. `BACKUP_S3_ENDPOINT = https://<account-id>.r2.cloudflarestorage.com`, `BACKUP_S3_REGION = auto`.

## Verify — do NOT trust it blind

On boot the server runs a **self-test** (probe upload → readback → compare → delete). Watch the logs:

- ✅ `off-site self-test PASSED — credentials + bucket reachable`
- ❌ `off-site self-test FAILED — backups are NOT going off-site: <reason>`

Then do a **restore drill** at least once (and quarterly):

```bash
# download the latest snapshot object from your bucket, then:
sqlite3 minicaai-YYYY-MM-DD.db "SELECT COUNT(*) FROM users; SELECT COUNT(*) FROM licenses;"
```

If `BACKUP_ENCRYPTION_KEY` is set, decrypt first. Layout is
`[12-byte IV][16-byte GCM tag][ciphertext]`, AES-256-GCM.

## Restore
1. Stop the server (or point `DATABASE_PATH` at a fresh file).
2. Download the snapshot; decrypt if encrypted; place it at `DATABASE_PATH`.
3. Start the server.

## Caveat: this signing code has not been run against a live bucket in-repo
The SigV4 implementation is standard, but it was written without a bucket to
test against. **The boot self-test is what proves it works in *your*
environment** — treat a failing self-test as "off-site backups are not working
yet," not as a cosmetic warning.

## Stronger option: Litestream (continuous replication)
For point-in-time / continuous replication (not just daily snapshots), run
[Litestream](https://litestream.io) as a sidecar that streams the SQLite WAL to
the same S3/R2 bucket. It recovers to the last second rather than the last daily
snapshot and is battle-tested. Recommended for the long term; the daily off-site
snapshot here is the immediate safety net.
