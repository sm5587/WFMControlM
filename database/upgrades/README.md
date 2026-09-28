# Version upgrade DDL / DML

From **1.1.0** onward, incremental changes for production-style SQL deploys live here.
Do not fold new schema objects into `../first-time-deployment-ddl.sql` (that file stays the 1.0.0 baseline).

| File | When to apply |
|------|----------------|
| `1.1.0-ddl.sql` | Schema changes when upgrading 1.0.0 → 1.1.0 (or after first-time DDL), including payroll deadline + WFM app version columns |
| `1.1.0-dml.sql` | Seed/reference data for 1.1.0 (profiles, AppConfig keys incl. `engine.wfmVersionSyncSchedule`, permissions) |

**Fresh install to current version:**

1. `first-time-deployment-ddl.sql`
2. `first-time-deployment-dml.sql`
3. Each `upgrades/<version>-ddl.sql` then matching `*-dml.sql` in version order

**Upgrade example (Docker):**

```bash
docker compose exec backend node scripts/apply-sql.js ../database/upgrades/1.1.0-ddl.sql
docker compose exec backend node scripts/apply-sql.js ../database/upgrades/1.1.0-dml.sql
```

Apply each version file **once**, in version order.

**Relation to Prisma migrations**

`prisma migrate deploy` is **not** run on app/container start by default (`RUN_MIGRATIONS=false`).
Use `database/upgrades/*` via `apply-sql.js` for intentional schema/data updates.

| Path | What runs |
|------|-----------|
| Ops `apply-sql.js` upgrades | `database/upgrades/*` — preferred for production-style deploys |
| `RUN_MIGRATIONS=true` (opt-in only) | `backend/prisma/migrations/*` — avoid unless you have reviewed every pending migration for table rebuilds |

When you add a Prisma migration that inserts reference data (profiles, permissions, AppConfig), also add the same statements to `database/upgrades/<version>-dml.sql` (and update `first-time-deployment-dml.sql` for new installs).
