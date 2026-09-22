# Version upgrade DDL

From **1.1.0** onward, new schema changes are maintained **only** in version-specific files here.
Do not fold new objects into `../first-time-deployment-ddl.sql` (that file stays the 1.0.0 baseline).

| File | When to apply |
|------|----------------|
| `1.1.0-ddl.sql` | After first-time DDL/DML, or when upgrading an existing 1.0.0 DB to 1.1.0 |

**Fresh install to current version:**

1. `first-time-deployment-ddl.sql`
2. `first-time-deployment-dml.sql`
3. Each `upgrades/<version>-ddl.sql` in order (`1.1.0`, then later versions)

**Upgrade example (Docker):**

```bash
docker compose exec backend node scripts/apply-sql.js ../database/upgrades/1.1.0-ddl.sql
```

Apply each version file **once**, in version order.

Prisma migrations under `backend/prisma/migrations/` remain the source of truth for local/dev; these SQL files are the ops path for production-style incremental DDL.
