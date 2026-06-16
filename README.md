# WFM Control-M

Workforce Management job scheduling, monitoring, and orchestration platform.

**Documentation lives in [`docs/`](docs/).**

| Document | Description |
| -------- | ----------- |
| [docs/README.md](docs/README.md) | Architecture, features, API reference, quick start |
| [docs/WFM_ControlM.md](docs/WFM_ControlM.md) | WFM-specific design (DB2, SSH, clients, data flow) |
| [docs/DEPLOYMENT_UNIX.md](docs/DEPLOYMENT_UNIX.md) | Unix / Linux install and production deployment |
| [docs/dbextract.md](docs/dbextract.md) | Regenerate `database/ddl.sql` and `dml.sql` |
| [docs/production-readiness-checklist.md](docs/production-readiness-checklist.md) | Go-live checklist |
| [docs/WFM_ControlM_Presentation.md](docs/WFM_ControlM_Presentation.md) | Presentation / overview slides (markdown) |

## Quick start

```bash
npm run install:all
cp .env.example .env    # set DATABASE_URL + CONFIG_ENCRYPTION_KEY
npm run db:migrate
npm run db:seed
npm run dev
```

- Backend: http://localhost:4000  
- Frontend: http://localhost:3000  

See [docs/README.md](docs/README.md) and [docs/DEPLOYMENT_UNIX.md](docs/DEPLOYMENT_UNIX.md) for full setup.
