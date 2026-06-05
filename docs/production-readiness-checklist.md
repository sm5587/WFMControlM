# WFM Control-M Production Readiness Checklist

## Config ownership
- Runtime config is DB-backed after startup: `configService.load()` reads `AppConfig`, and `applyDbConfig()` patches the in-memory config object.
- Runtime defaults were removed from the backend config call sites, so the DB seed is now the source of truth for application tunables.
- `.env` is bootstrap-only — see `.env.example`. Required: `DATABASE_URL`, `CONFIG_ENCRYPTION_KEY`. Optional: Keeper paths, `ADMIN_*` for one-time seed.
- Tune SMTP, JWT, CORS, thresholds, polling, SSH, and engine settings in **Admin → Config** (or `AppConfig` rows), not in `.env`.

## Database
- Apply Prisma migrations in production using `prisma migrate deploy`.
- Run the config bootstrap DDL and DML files in `database/ddl.sql` and `database/dml.sql` if you are preparing the config database manually.
- The DML file now includes the full AppConfig bootstrap set, including the missing `polling.punchCacheTtlMins` key.
- If you stay on SQLite, put the DB on persistent storage and verify backup and restore.
- If you move to PostgreSQL later, update Prisma datasource, connection config, and deployment docs together.

## Secrets and identity
- Set `CONFIG_ENCRYPTION_KEY` in `.env` before first run (stable across restarts).
- Replace all placeholder secrets in `AppConfig` before go-live (`secrets.jwtSecret`, `secrets.smtp*`, etc.).
- Verify JWT expiry (`secrets.jwtExpiresIn`) in Admin → Config.
- Populate SMTP credentials, alert sender address, DB2 credentials, SSH credentials, and Keeper settings as required.
- Create and validate the break-glass master account only if your security model allows it.

## Runtime and deployment
- Run the backend behind HTTPS and a reverse proxy.
- Update CORS origins to production hostnames only.
- Keep the backend health endpoint on an internal or protected path for monitoring.
- Verify frontend proxy settings for the chosen deployment model: Docker Compose, Kubernetes ingress, or bare metal Nginx.
- Confirm the backend starts cleanly after restart and that migrations do not block startup.

## Scriptable startup
- Prepare everything non-interactively: npm run startup:prepare
- Prepare and start both services: npm run startup:up
- Run startup script directly with controls:
	- powershell -ExecutionPolicy Bypass -File .\start.ps1 prepare -Build
	- powershell -ExecutionPolicy Bypass -File .\start.ps1 up
	- powershell -ExecutionPolicy Bypass -File .\start.ps1 prepare -SkipInstall -SkipDb
- Database-only path for automation:
	- npm run db:deploy
	- npm run db:bootstrap

## Security hardening
- Keep Helmet enabled and add rate limiting if public access is possible.
- Restrict admin routes and validate RBAC mappings after seed/import.
- Store logs outside the application image and restrict access to the log directory.
- Review any plaintext credential paths and replace them with Keeper or a secrets manager.

## Operational readiness
- Set up monitoring for API health, job execution failures, queue backlog, and DB connectivity.
- Configure alert delivery for SMTP, Slack, or webhook channels and test each path.
- Verify scheduled purge, cron sync, and DB monitor refresh jobs in a non-production window first.
- Establish a rollback plan, including DB snapshot and application image rollback.

## Validation before cutover
- Login with an admin user and confirm RBAC permissions.
- Confirm `AppConfig` loads from the DB and overrides the startup defaults.
- Run a sample job trigger and verify execution history is recorded.
- Test alert generation and delivery.
- Perform one backup and one restore drill before accepting production traffic.