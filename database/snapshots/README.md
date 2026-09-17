# SQL export snapshots

Dated DDL/DML exports from `npm run db:extract` land here, for example:

- `ddl-20260913.sql`
- `dml-20260913.sql`

These are **reference backups** of schema/seed content at a point in time. They are not applied during routine production deploys.

**First-time deployment only** (fresh empty database):

- `../first-time-deployment-ddl.sql`
- `../first-time-deployment-dml.sql`

Refresh those bootstrap files intentionally with:

```bash
npm run db:extract:first-time
```
