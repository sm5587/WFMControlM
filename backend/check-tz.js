const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  try {
    // 1. Client vs AppServer timezone mismatches
    const clients = await p.client.findMany({
      where: { isActive: true },
      include: { appServers: { where: { environment: 'Prod', isActive: true }, select: { timezone: true, dns: true } } }
    });

    const mismatches = [];
    const chicagoNoDetect = [];
    const tzCount = {};

    for (const c of clients) {
      const tz = c.timezone || 'NULL';
      tzCount[tz] = (tzCount[tz] || 0) + 1;
      const serverTz = c.appServers[0]?.timezone;
      if (serverTz && c.timezone !== serverTz) {
        mismatches.push({ client: c.clientId, clientTz: c.timezone, serverTz });
      }
      if (c.timezone === 'America/Chicago' && !serverTz) {
        chicagoNoDetect.push({ client: c.clientId, server: c.appServers[0]?.dns || 'none' });
      }
    }

    console.log('=== TIMEZONE AUDIT REPORT ===\n');

    if (mismatches.length === 0) {
      console.log('Client vs AppServer mismatches: NONE (all match)');
    } else {
      console.log(`Client vs AppServer mismatches: ${mismatches.length}`);
      mismatches.forEach(m => console.log(`  ${m.client} | client: ${m.clientTz} | server: ${m.serverTz}`));
    }

    // 2. Job vs serverTimezone mismatches
    const jobs = await p.job.findMany({
      where: { deleteStatus: null },
      select: { name: true, timezone: true, serverTimezone: true, client: { select: { clientId: true } } }
    });
    const badJobs = jobs.filter(j => j.serverTimezone && j.timezone !== j.serverTimezone);
    if (badJobs.length === 0) {
      console.log('Job vs serverTimezone mismatches: NONE (all match)');
    } else {
      console.log(`\nJob vs serverTimezone mismatches: ${badJobs.length}`);
      badJobs.forEach(j => console.log(`  ${j.client?.clientId} | ${j.name} | tz: ${j.timezone} | serverTz: ${j.serverTimezone}`));
    }

    // 3. Clients with America/Chicago but appserver TZ not yet detected
    console.log(`\n--- ${chicagoNoDetect.length} clients with America/Chicago (server TZ NOT YET DETECTED) ---`);
    console.log('These may be WRONG if the actual server is not in US/Central:');
    chicagoNoDetect.forEach(c => console.log(`  ${c.client} | ${c.server}`));

    // 4. Timezone distribution
    console.log('\n--- Client timezone distribution ---');
    Object.entries(tzCount).sort((a,b) => b[1] - a[1]).forEach(([tz, count]) => console.log(`  ${tz}: ${count} clients`));

    console.log(`\nTotal active clients: ${clients.length}`);
    console.log(`Total active jobs: ${jobs.length}`);
  } catch(e) {
    console.error('Error:', e.message);
  } finally {
    await p.$disconnect();
  }
}
main();
