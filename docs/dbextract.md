# DDL / DML Extraction

This project keeps SQL bootstrap and snapshot files under `database/`:

| File | Purpose |
|------|---------|
| `database/first-time-deployment-ddl.sql` | Schema — apply on a **fresh** database only |
| `database/first-time-deployment-dml.sql` | Reference/seed data — apply **once** after DDL on first deploy |
| `database/snapshots/ddl-YYYYMMDD.sql` | Dated DDL export (reference backup, not used on deploy) |
| `database/snapshots/dml-YYYYMMDD.sql` | Dated DML export (reference backup, not used on deploy) |
| `database/sql-export-manifest.json` | Defines which tables are exported into DML |

Apply scripts (reverse direction):

```bash
npm run db:bootstrap:ddl   # apply first-time-deployment-ddl.sql
npm run db:bootstrap:dml   # apply first-time-deployment-dml.sql
npm run db:bootstrap       # both + clients
```

---

## Quick extract (dated snapshot)

From the **project root**:

```bash
npm run db:extract
```

This writes dated files under `database/snapshots/` (e.g. `dml-20260913.sql`). It does **not** overwrite the first-time deployment files.

---

## Refresh first-time bootstrap files (rare)

Only when you intentionally update the committed bootstrap scripts:

```bash
npm run db:extract:first-time
```

This updates `database/first-time-deployment-ddl.sql` and `database/first-time-deployment-dml.sql`.

To update both bootstrap files **and** write a dated snapshot:

```bash
cd backend && node scripts/extract-sql.js --update-first-time
```

---

## Recommended workflow (after schema or seed changes)

```bash
npm run db:migrate          # apply Prisma schema changes to dev DB
npm run db:seed             # optional: reload reference/seed data in DB
npm run db:extract          # dated snapshot only
```

Verify on a clean database:

```bash
npm run db:bootstrap        # applies first-time-deployment-*.sql
```

One-liner after a schema change:

```bash
npm run db:migrate && npm run db:seed && npm run db:extract
```

---

## Extract options

```bash
npm run db:extract -- --ddl       # DDL snapshot only
npm run db:extract -- --dml       # DML snapshot only
npm run db:extract -- --stdout    # print to console (no files written)
npm run db:extract -- --dry-run   # show paths that would be written
npm run db:extract:first-time     # refresh first-time-deployment-*.sql only
```

---

## Production note

- **First-time deploy:** `database/first-time-deployment-*.sql` or `./scripts/deploy-prod.sh` with `FIRST_TIME_DEPLOY=true`
- **Routine deploy:** `./scripts/deploy-prod.sh` only — never re-run first-time DML on live production
- **Dated snapshots:** for audit/reference; stored in `database/snapshots/` (gitignored)

---

## Related files

| File | Role |
|------|------|
| `backend/scripts/extract-sql.js` | CLI entry point |
| `backend/scripts/lib/sql-export-core.js` | Shared export logic |
| `backend/scripts/apply-sql.js` | Applies SQL files to the DB |
| `backend/src/services/sql-export-service.ts` | Admin API SQL export |

- **Client / AppServer inventory** is environment-specific and is **not** included in first-time DML — load via `database/clients-dml.sql`, import scripts, or Admin APIs.
