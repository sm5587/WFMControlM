const { PrismaClient } = require('@prisma/client');
const path = require('path');
const cronParser = require('cron-parser');

const dbPath = path.resolve(__dirname, '../prisma/dev.db').replace(/\\/g, '/');
process.env.DATABASE_URL = `file:${dbPath}`;
const p = new PrismaClient();

async function main() {
  const clients = await p.client.findMany({
    where: { cluster: 'CL20', isActive: true },
    select: { id: true, clientId: true, name: true, cluster: true, timezone: true },
  });
  console.log('=== CL20 Clients ===');
  console.log(JSON.stringify(clients, null, 2));

  for (const c of clients) {
    const servers = await p.appServer.findMany({
      where: { clientId: c.id },
      select: { environment: true, serverNum: true, dns: true, timezone: true, lastCronFetchAt: true },
    });
    console.log(`\n=== AppServers: ${c.clientId} ===`);
    console.log(JSON.stringify(servers, null, 2));

    const jobs = await p.job.findMany({
      where: { clientId: c.id, deleteStatus: null, category: 'client-cron' },
      select: { name: true, cronExpression: true, timezone: true, serverTimezone: true },
    });
    console.log(`\n=== Jobs: ${c.clientId} (${jobs.length}) ===`);
    for (const j of jobs) {
      const tz = j.serverTimezone || c.timezone || j.timezone || 'UTC';
      console.log(JSON.stringify({ ...j, effectiveTz: tz }));
      if (j.cronExpression) {
        try {
          const interval = cronParser.parseExpression(j.cronExpression, { tz, currentDate: new Date('2026-07-24T06:30:00Z') });
          const next = interval.next().toDate();
          console.log('  next fire after 06:30 UTC:', next.toISOString());
          console.log('  in IST:', new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', hour12: false, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' }).format(next));
          console.log('  in server TZ:', new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour12: false, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' }).format(next));
        } catch (e) {
          console.log('  parse error:', e.message);
        }
      }
    }
  }

  const cvsdc = await p.client.findFirst({ where: { clientId: 'CVSDC' }, select: { clientId: true, cluster: true, timezone: true } });
  console.log('\n=== CVSDC client record ===');
  console.log(JSON.stringify(cvsdc, null, 2));

  const cvsdcJobs = await p.job.findMany({
    where: { name: { contains: 'CVSDC' }, deleteStatus: null },
    include: { client: { select: { clientId: true, cluster: true, timezone: true } } },
  });
  console.log('\n=== CVSDC jobs ===');
  for (const j of cvsdcJobs) {
    console.log(JSON.stringify({
      name: j.name,
      cluster: j.client?.cluster,
      clientTz: j.client?.timezone,
      serverTimezone: j.serverTimezone,
      cronExpression: j.cronExpression,
    }));
  }

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
