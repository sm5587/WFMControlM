const { PrismaClient } = require('@prisma/client');
const path = require('path');
const dbPath = path.resolve(__dirname, '../prisma/dev.db').replace(/\\/g, '/');
process.env.DATABASE_URL = `file:${dbPath}`;
const p = new PrismaClient();

async function main() {
  for (const id of ['CVSH', 'CVSDC']) {
    const c = await p.client.findFirst({
      where: { clientId: id },
      include: { appServers: { select: { dns: true, environment: true, timezone: true, lastCronFetchAt: true } } },
    });
    console.log(JSON.stringify(c, null, 2));
  }
  await p.$disconnect();
}
main();
