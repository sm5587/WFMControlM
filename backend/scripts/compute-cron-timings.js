/**
 * Compute scheduled cron fire times from stored expressions (no execution history).
 * Uses the same cron-parser logic as maintenance affected-jobs.
 *
 * Usage (from backend/):
 *   node scripts/compute-cron-timings.js [--days=7] [--forward] [--cluster=US] [--client=ABC]
 *
 * Output: CSV to stdout + summary JSON file in reports/
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
  const upper = tz.toUpperCase();
  return IANA_MAP[upper] ?? tz;
}

/** All fire times in [start, end] for expr evaluated in server TZ */
function getFireTimesInWindow(expr, tz, start, end, maxFires = 500) {
  const iana = resolveTz(tz);
  const fireTimes = [];
  try {
    const interval = cronParser.parseExpression(expr, {
      tz: iana,
      currentDate: new Date(start.getTime() - 1000),
    });
    for (let i = 0; i < maxFires; i++) {
      const next = interval.next();
      const d = next.toDate();
      if (d > end) break;
      fireTimes.push(d);
    }
  } catch (err) {
    return { fireTimes: [], error: err.message };
  }
  return { fireTimes, error: null };
}

function fmtLocal(d, tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: resolveTz(tz),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(d).replace(',', '');
  } catch {
    return d.toISOString();
  }
}

function parseArgs() {
  const args = { days: 7, forward: false, cluster: null, client: null };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--days=')) args.days = parseInt(a.split('=')[1], 10) || 7;
    else if (a === '--forward') args.forward = true;
    else if (a.startsWith('--cluster=')) args.cluster = a.split('=')[1];
    else if (a.startsWith('--client=')) args.client = a.split('=')[1];
  }
  return args;
}

async function main() {
  const opts = parseArgs();
  const prisma = new PrismaClient();

  const now = new Date();
  const ms = opts.days * 24 * 60 * 60 * 1000;
  const start = opts.forward ? now : new Date(now.getTime() - ms);
  const end = opts.forward ? new Date(now.getTime() + ms) : now;

  const where = {
    deleteStatus: null,
    isActive: true,
    cronExpression: { not: null },
    category: 'client-cron',
  };

  const jobs = await prisma.job.findMany({
    where,
    include: {
      client: { select: { clientId: true, name: true, cluster: true, timezone: true } },
    },
    orderBy: [{ client: { clientId: 'asc' } }, { name: 'asc' }],
  });

  let filtered = jobs;
  if (opts.cluster) {
    filtered = filtered.filter(j => j.client?.cluster === opts.cluster);
  }
  if (opts.client) {
    filtered = filtered.filter(j => j.client?.clientId === opts.client);
  }

  const rows = [];
  const summary = {
    generatedAt: now.toISOString(),
    windowStartUtc: start.toISOString(),
    windowEndUtc: end.toISOString(),
    days: opts.days,
    direction: opts.forward ? 'forward' : 'backward',
    jobCount: filtered.length,
    totalFireTimes: 0,
    parseErrors: [],
  };

  for (const job of filtered) {
    const serverTz = job.serverTimezone || job.client?.timezone || job.timezone || 'UTC';
    const displayTz = job.client?.timezone || serverTz;
    const { fireTimes, error } = getFireTimesInWindow(
      job.cronExpression,
      serverTz,
      start,
      end,
    );

    if (error) {
      summary.parseErrors.push({ job: job.name, cron: job.cronExpression, error });
      continue;
    }

    summary.totalFireTimes += fireTimes.length;

    for (const ft of fireTimes) {
      rows.push({
        clientId: job.client?.clientId ?? '',
        clientName: job.client?.name ?? '',
        cluster: job.client?.cluster ?? '',
        jobName: job.name,
        cronExpression: job.cronExpression,
        serverTimezone: serverTz,
        fireTimeUtc: ft.toISOString(),
        fireTimeLocal: fmtLocal(ft, displayTz),
        fireTimeServer: fmtLocal(ft, serverTz),
        command: (job.command || '').slice(0, 120),
      });
    }
  }

  rows.sort((a, b) => a.fireTimeUtc.localeCompare(b.fireTimeUtc));

  const header = [
    'clientId', 'cluster', 'jobName', 'cronExpression', 'serverTimezone',
    'fireTimeUtc', 'fireTimeLocal', 'fireTimeServer', 'command',
  ];
  console.log(header.join(','));
  for (const r of rows) {
    console.log(header.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(','));
  }

  const reportsDir = path.resolve(__dirname, '../../reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = now.toISOString().slice(0, 10);
  const dirLabel = opts.forward ? 'forward' : 'past';
  const outFile = path.join(reportsDir, `cron-timings-${dirLabel}-${opts.days}d-${stamp}.csv`);
  const csv = [header.join(',')].concat(
    rows.map(r => header.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(',')),
  ).join('\n');
  fs.writeFileSync(outFile, csv, 'utf8');

  const summaryFile = path.join(reportsDir, `cron-timings-${dirLabel}-${opts.days}d-${stamp}.json`);
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2), 'utf8');

  console.error(`\n--- Summary ---`);
  console.error(`Jobs: ${summary.jobCount}, Fire times: ${summary.totalFireTimes}`);
  console.error(`Window UTC: ${summary.windowStartUtc} → ${summary.windowEndUtc}`);
  console.error(`CSV: ${outFile}`);
  if (summary.parseErrors.length) {
    console.error(`Parse errors: ${summary.parseErrors.length}`);
  }

  await prisma.$disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
