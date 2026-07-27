/**
 * Compute cron jobs scheduled to fire during an outage window.
 *
 * Conversion pipeline (explicit):
 *   1. Parse cron expression in SERVER timezone → UTC instant (via cron-parser)
 *   2. Convert outage window from IST → UTC
 *   3. Filter: keep fires where fireTimeUtc is within [windowStartUtc, windowEndUtc]
 *   4. Report times in server TZ, UTC, and IST
 *
 * Usage:
 *   node scripts/compute-outage-impacted-crons.js --start="2026-07-24 12:00" --end="2026-07-24 13:30" --cluster=CL20
 *   node scripts/compute-outage-impacted-crons.js --start="2026-07-24 12:00" --end="2026-07-24 13:30" --no-retry-today
 */

const fs = require('fs');
const path = require('path');
const cronParser = require('cron-parser');
const { PrismaClient } = require('@prisma/client');

const dbPath = path.resolve(__dirname, '../prisma/dev.db').replace(/\\/g, '/');
process.env.DATABASE_URL = process.env.DATABASE_URL || `file:${dbPath}`;

const IANA_MAP = {
  IST: 'Asia/Kolkata',
  EDT: 'America/New_York',
  EST: 'America/New_York',
  CST: 'America/Chicago',
  CDT: 'America/Chicago',
  MST: 'America/Denver',
  MDT: 'America/Denver',
  PST: 'America/Los_Angeles',
  PDT: 'America/Los_Angeles',
  UTC: 'UTC',
};

function resolveTz(tz) {
  if (!tz) return 'UTC';
  return IANA_MAP[tz.toUpperCase()] ?? tz;
}

/** IST local "YYYY-MM-DD HH:mm[:ss]" → UTC Date. IST is always UTC+5:30 (no DST). */
function istToUtc(dateTimeStr) {
  const m = dateTimeStr.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw new Error(`Invalid IST datetime: ${dateTimeStr}`);
  const [, y, mo, d, h, mi, s = '0'] = m;
  // UTC = IST − 5h 30m
  return new Date(Date.UTC(+y, +mo - 1, +d, +h - 5, +mi - 30, +s));
}

/** UTC Date → IST display string */
function utcToIst(d) {
  return fmtInTz(d, 'Asia/Kolkata');
}

function fmtInTz(d, tz) {
  const iana = resolveTz(tz);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: iana,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const p = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/**
 * Step 1: Expand cron in server timezone → array of UTC Date instants
 * Step 3: Keep only those within [windowStartUtc, windowEndUtc]
 */
function getFireTimesUtcInWindow(expr, serverTz, windowStartUtc, windowEndUtc) {
  const iana = resolveTz(serverTz);
  const fireTimesUtc = [];
  try {
    const interval = cronParser.parseExpression(expr, {
      tz: iana,
      currentDate: new Date(windowStartUtc.getTime() - 1000),
    });
    for (let i = 0; i < 500; i++) {
      const fireUtc = interval.next().toDate(); // cron-parser returns UTC instant
      if (fireUtc > windowEndUtc) break;
      if (fireUtc >= windowStartUtc) fireTimesUtc.push(fireUtc);
    }
  } catch (err) {
    return { fireTimesUtc: [], error: err.message };
  }
  return { fireTimesUtc, error: null };
}

/** Any scheduled fire strictly after `afterUtc` through end of IST calendar day? */
function hasFireLaterToday(expr, serverTz, afterUtc, istDate) {
  const endOfDayUtc = istToUtc(`${istDate} 23:59:59`);
  const { fireTimesUtc } = getFireTimesUtcInWindow(expr, serverTz, new Date(afterUtc.getTime() + 1), endOfDayUtc);
  return fireTimesUtc.length > 0;
}

function istDateFromStart(startStr) {
  return startStr.match(/^(\d{4}-\d{2}-\d{2})/)[1];
}

function parseArgs() {
  const args = {
    start: '2026-07-24 12:00',
    end: '2026-07-24 13:30',
    cluster: null,
    client: null,
    noRetryToday: false,
  };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--start=')) args.start = a.slice(8);
    else if (a.startsWith('--end=')) args.end = a.slice(6);
    else if (a.startsWith('--cluster=')) args.cluster = a.slice(10);
    else if (a.startsWith('--client=')) args.client = a.slice(9);
    else if (a === '--no-retry-today') args.noRetryToday = true;
  }
  return args;
}

async function main() {
  const opts = parseArgs();

  // Step 2: Outage window provided in IST → convert to UTC for comparison
  const windowStartUtc = istToUtc(opts.start);
  const windowEndUtc = istToUtc(opts.end);
  if (windowEndUtc <= windowStartUtc) throw new Error('End must be after start');

  const prisma = new PrismaClient();
  const jobs = await prisma.job.findMany({
    where: {
      deleteStatus: null,
      isActive: true,
      cronExpression: { not: null },
      category: 'client-cron',
    },
    include: {
      client: { select: { clientId: true, name: true, cluster: true, timezone: true } },
    },
    orderBy: [{ client: { clientId: 'asc' } }, { name: 'asc' }],
  });

  let filtered = jobs;
  if (opts.cluster) filtered = filtered.filter(j => j.client?.cluster === opts.cluster);
  if (opts.client) filtered = filtered.filter(j => j.client?.clientId === opts.client);

  const impacted = [];

  for (const job of filtered) {
    const serverTz = job.serverTimezone || job.client?.timezone || job.timezone || 'UTC';
    const { fireTimesUtc, error } = getFireTimesUtcInWindow(
      job.cronExpression,
      serverTz,
      windowStartUtc,
      windowEndUtc,
    );
    if (error || fireTimesUtc.length === 0) continue;

    for (const fireUtc of fireTimesUtc) {
      impacted.push({
        clientId: job.client?.clientId ?? '',
        cluster: job.client?.cluster ?? '',
        jobName: job.name,
        cronExpression: job.cronExpression,
        serverTimezone: serverTz,
        fireTimeServer: fmtInTz(fireUtc, serverTz),
        fireTimeUtc: fireUtc.toISOString(),
        fireTimeIst: utcToIst(fireUtc),
        command: (job.command || '').slice(0, 100),
      });
    }
  }

  impacted.sort((a, b) => a.fireTimeUtc.localeCompare(b.fireTimeUtc));

  let output = impacted;
  if (opts.noRetryToday) {
    const istDate = istDateFromStart(opts.start);
    const byJob = new Map();
    for (const row of impacted) {
      const key = row.jobName;
      if (!byJob.has(key)) byJob.set(key, { ...row, firesInWindowIst: [] });
      byJob.get(key).firesInWindowIst.push(row.fireTimeIst);
    }

    output = [];
    for (const [, row] of byJob) {
      const retryLater = hasFireLaterToday(row.cronExpression, row.serverTimezone, windowEndUtc, istDate);
      if (retryLater) continue;
      output.push({
        ...row,
        firesInWindowIst: row.firesInWindowIst.join('; '),
        willRetryToday: 'No',
      });
    }
    output.sort((a, b) => a.fireTimeUtc.localeCompare(b.fireTimeUtc));
  }

  const header = opts.noRetryToday
    ? [
        'clientId', 'cluster', 'jobName', 'cronExpression', 'serverTimezone',
        'firesInWindowIst', 'fireTimeServer', 'fireTimeUtc', 'willRetryToday', 'command',
      ]
    : [
        'clientId', 'cluster', 'jobName', 'cronExpression', 'serverTimezone',
        'fireTimeServer', 'fireTimeUtc', 'fireTimeIst', 'command',
      ];

  const reportsDir = path.resolve(__dirname, '../../reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const suffix = [
    opts.cluster ? `-${opts.cluster}` : opts.client ? `-${opts.client}` : '',
    opts.noRetryToday ? '-no-retry-today' : '',
  ].join('');
  const outFile = path.join(
    reportsDir,
    `outage-impacted-crons-${opts.start.replace(/[: ]/g, '-')}-to-${opts.end.replace(/[: ]/g, '-')}${suffix}.csv`,
  );
  const csv = [header.join(',')].concat(
    output.map(r => header.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(',')),
  ).join('\n');
  fs.writeFileSync(outFile, csv, 'utf8');

  const uniqueJobs = new Set(output.map(r => r.jobName)).size;
  const summary = {
    conversionPipeline: [
      '1. Parse cron in serverTimezone → UTC instant (cron-parser)',
      '2. Outage window IST → UTC (IST = UTC+5:30, fixed offset)',
      '3. Filter fires where fireTimeUtc ∈ [windowStartUtc, windowEndUtc]',
      ...(opts.noRetryToday
        ? ['4. Exclude jobs with another scheduled fire later today (IST calendar day)']
        : []),
    ],
    outageWindowIst: `${opts.start} → ${opts.end} IST`,
    outageWindowUtc: `${windowStartUtc.toISOString()} → ${windowEndUtc.toISOString()}`,
    noRetryToday: opts.noRetryToday,
    uniqueJobs,
    totalFireTimes: opts.noRetryToday ? output.length : impacted.length,
    excludedRetryToday: opts.noRetryToday ? new Set(impacted.map(r => r.jobName)).size - uniqueJobs : 0,
    csv: outFile,
  };

  console.log(JSON.stringify(summary, null, 2));
  console.error(`\nImpacted: ${uniqueJobs} jobs${opts.noRetryToday ? ' (no retry today)' : ''}, ${output.length} rows`);
  console.error(`Window UTC: ${windowStartUtc.toISOString()} → ${windowEndUtc.toISOString()}`);
  console.error(`CSV: ${outFile}`);

  for (const r of output) {
    const times = opts.noRetryToday ? r.firesInWindowIst : r.fireTimeIst;
    console.error(`  ${times} IST | ${r.clientId} | ${r.jobName}`);
  }

  await prisma.$disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
