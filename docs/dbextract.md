# DDL / DML Extraction

This project keeps consolidated SQL bootstrap files under `database/`:

| File | Purpose |
|------|---------|
| `database/ddl.sql` | Schema (tables, indexes, constraints) — apply on a **fresh** database |
| `database/dml.sql` | Reference/seed data (RBAC, config, pools, etc.) — apply **after** DDL |
| `database/sql-export-manifest.json` | Defines which tables are exported into DML |

Apply scripts (reverse direction):

```bash
npm run db:bootstrap:ddl   # apply ddl.sql
npm run db:bootstrap:dml   # apply dml.sql
npm run db:bootstrap       # both
```

---

## Quick extract (DDL + DML)

From the **project root**:

```bash
npm run db:extract
```

This regenerates both `database/ddl.sql` and `database/dml.sql`.

---

## Recommended workflow (after schema or seed changes)

```bash
npm run db:migrate          # apply Prisma schema changes to dev DB
npm run db:seed             # optional: reload reference/seed data in DB
npm run db:extract          # regenerate ddl.sql + dml.sql
```

Verify on a clean database:

```bash
npm run db:bootstrap        # applies ddl.sql then dml.sql
```

One-liner after a schema change:

```bash
npm run db:migrate && npm run db:seed && npm run db:extract
```

---

## Extract options

```bash
npm run db:extract -- --ddl       # DDL only
npm run db:extract -- --dml       # DML only
npm run db:extract -- --stdout    # print to console (no files written)
npm run db:extract -- --dry-run   # show what would be written
```

From `backend/` directly:

```bash
cd backend
npm run sql:extract
node scripts/extract-sql.js --help
```

---

## How it works

### DDL

- **Source:** `backend/prisma/schema.prisma`
- **Tool:** `prisma migrate diff --from-empty --to-schema-datamodel`
- **Output:** Idempotent SQL (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`)
- **Fully automatic** — new models/columns in Prisma are picked up on the next extract; no manifest edit needed.

### DML

- **Source:** Live SQLite database (`DATABASE_URL` / `backend/prisma/dev.db`)
- **Config:** `database/sql-export-manifest.json` — table list, insert mode, filters, ordering
- **Secret handling:** `AppConfig` rows with `isSecret = 1` export with an empty `value`
- **Reflects current DB state** — run `npm run db:seed` first if you want seed data exported.

---

## Admin HTTP API

When the backend is running (requires `PERMISSIONS_EDIT`):

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/admin/sql-export?type=ddl\|dml\|all` | Returns SQL in JSON response |
| `POST` | `/api/admin/sql-export/write?type=...` | Writes files under `database/` |

Example:

```http
GET /api/admin/sql-export?type=all
Authorization: Bearer <token>
```

---

## Adding a new reference table to DML export

1. Add the model to `backend/prisma/schema.prisma` and migrate.
2. Seed the table (via `seed.ts`, Admin UI, or manual insert).
3. Add a section to `database/sql-export-manifest.json`:

```json
{
  "title": "MY NEW TABLE",
  "table": "MyTable",
  "insertMode": "ignore",
  "orderBy": ["id"]
}
```

| Field | Values | Notes |
|-------|--------|-------|
| `insertMode` | `ignore` \| `replace` | Maps to `INSERT OR IGNORE` / `INSERT OR REPLACE` |
| `where` | SQL fragment | Optional filter, e.g. `"isSystem = 1"` |
| `orderBy` | column array | Stable row order in output |
| `maskSecretValues` | `true` | Clears `value` when `isSecret` is set (for config-like tables) |
| `notes` | string array | Comment lines written above the INSERT block |

4. Run:

```bash
npm run db:extract -- --dml
```

Place new sections **after** tables they depend on (foreign keys).

---

## Implementation files

| Path | Role |
|------|------|
| `backend/scripts/extract-sql.js` | CLI entry point |
| `backend/scripts/lib/sql-export-core.js` | Shared extraction logic |
| `backend/scripts/apply-sql.js` | Applies ddl.sql / dml.sql to the DB |
| `backend/src/services/sql-export-service.ts` | Used by admin API routes |
| `backend/src/routes/admin.ts` | `/api/admin/sql-export` endpoints |

---

## Notes

- **Client / AppServer inventory** is environment-specific and is **not** included in `dml.sql` — load via import scripts or Admin APIs.
- **Runtime/cache tables** (e.g. `CachedQueueJob`, `JobExecution`) are intentionally excluded from the DML manifest.
- After `db:seed`, profile/user IDs may be UUIDs in exported DML; the hand-maintained bootstrap file used fixed IDs (`SYS_ADMIN_PROFILE`, etc.). Review exported DML before production rollout if stable IDs matter.
