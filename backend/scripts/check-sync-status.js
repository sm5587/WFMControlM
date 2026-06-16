const path = require('path');
const { PrismaClient } = require('@prisma/client');

const dbPath = path.resolve(__dirname, '../prisma/dev.db').replace(/\\/g, '/');
process.env.DATABASE_URL = `file:${dbPath}`;

const prisma = new PrismaClient();

async function main() {
  const clients = await prisma.client.findMany({
    where: { isActive: true },
    select: {
      clientId: true,
      lastCronSyncAt: true,
      lastCronAttemptAt: true,
    },
    orderBy: { clientId: 'asc' },
    take: 10,
  });

  console.log('--- Active clients (first 10) ---');
  for (const c of clients) {
    console.log(
      c.clientId,
      'syncAt=', c.lastCronSyncAt?.toISOString() || 'null',
      'attemptAt=', c.lastCronAttemptAt?.toISOString() || 'null',
    );
  }

  const recent = await prisma.syncHistory.findMany({
    orderBy: { createdAt: 'desc' },
    take: 15,
    include: { client: { select: { clientId: true } } },
  });

  console.log('\n--- Recent SyncHistory ---');
  for (const h of recent) {
    const errs = h.errors ? h.errors.slice(0, 120) : '';
    console.log(
      h.createdAt.toISOString(),
      h.client?.clientId || '?',
      h.status,
      h.syncType,
      `disc=${h.jobsDiscovered}`,
      `dur=${h.duration ?? '-'}s`,
      errs ? `err=${errs}` : '',
    );
  }

  const cfg = await prisma.appConfig.findUnique({
    where: { key: 'polling.cronSyncCooldownHrs' },
  });
  console.log('\ncronSyncCooldownHrs =', cfg?.value);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
