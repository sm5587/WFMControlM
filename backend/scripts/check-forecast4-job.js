const { PrismaClient } = require('@prisma/client');
const cronParser = require('cron-parser');
const path = require('path');

const dbPath = path.resolve(__dirname, '../prisma/dev.db').replace(/\\/g, '/');
process.env.DATABASE_URL = `file:${dbPath}`;
const p = new PrismaClient();

function istToUtc(s) {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})/);
  const [, y, mo, d, h, mi] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h - 5, +mi - 30, 0));
}

function fmt(d, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d);
  const o = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return `${o.year}-${o.month}-${o.day} ${o.hour}:${o.minute}:${o.second}`;
}

async function main() {
  const winStart = istToUtc('2026-07-24 12:00');
  const winEnd = istToUtc('2026-07-24 13:30');
  console.log('Outage IST: 2026-07-24 12:00 → 13:30');
  console.log('Outage UTC:', winStart.toISOString(), '→', winEnd.toISOString());
  console.log('Day of week UTC:', new Date('2026-07-24T12:00:00Z').toUTCString());

  const jobs = await p.job.findMany({
    where: {
      AND: [
        { name: { contains: 'forecast 4' } },
        { name: { contains: 'FS_RX_Stores' } },
      ],
    },
    include: { client: { select: { clientId: true, cluster: true } } },
  });

  for (const j of jobs) {
    const tz = j.serverTimezone || 'America/New_York';
    console.log('\n=== JOB ===');
    console.log('name:', j.name);
    console.log('cron:', j.cronExpression);
    console.log('serverTz:', tz);
    console.log('command:', j.command?.slice(0, 120));

    const interval = cronParser.parseExpression(j.cronExpression, { tz, currentDate: new Date('2026-07-23T00:00:00Z') });
    console.log('\nNext 5 scheduled fires:');
    for (let i = 0; i < 5; i++) {
      const d = interval.next().toDate();
      const inWin = d >= winStart && d <= winEnd;
      console.log(`  ${d.toISOString()} | server ${fmt(d, tz)} | IST ${fmt(d, 'Asia/Kolkata')} | IN WINDOW: ${inWin}`);
    }

    // Fire on July 24 specifically?
    const dayStart = new Date('2026-07-24T00:00:00Z');
    const dayEnd = new Date('2026-07-25T00:00:00Z');
    const iv2 = cronParser.parseExpression(j.cronExpression, { tz, currentDate: dayStart });
    console.log('\nFires on 2026-07-24 (any time):');
    let found = false;
    for (let i = 0; i < 20; i++) {
      const d = iv2.next().toDate();
      if (d >= dayEnd) break;
      found = true;
      const inWin = d >= winStart && d <= winEnd;
      console.log(`  ${d.toISOString()} | IST ${fmt(d, 'Asia/Kolkata')} | IN OUTAGE: ${inWin}`);
    }
    if (!found) console.log('  (none on July 24)');
  }

  const all = await p.job.findMany({
    where: { name: { contains: 'FS_RX_Stores' }, deleteStatus: null },
    select: { name: true, cronExpression: true },
    orderBy: { name: 'asc' },
  });
  console.log('\n=== All FS_RX_Stores jobs ===');
  for (const j of all) console.log(j.cronExpression.padEnd(20), j.name);

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
