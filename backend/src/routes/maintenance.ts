// ============================================================
// Maintenance Windows API Routes
// Planned & unscheduled cluster/client outage windows.
// Affected-jobs endpoint computes cron fire times inside the window.
// ============================================================

import { Router, Request, Response } from 'express';
import { prisma } from '../database/prisma';
import { requirePermission } from '../middleware';
import { createServiceLogger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import cronParser from 'cron-parser';

const router = Router();
const logger = createServiceLogger('MaintenanceAPI');

// ------------------------------------------------------------------ Timezone utils

/** Map of shorthand TZ labels → IANA names (for display) and UTC offset minutes */
const TZ_OFFSETS: Record<string, { iana: string; offsetMin: number }> = {
  IST:  { iana: 'Asia/Kolkata',      offsetMin:  330 },  // UTC+5:30
  EDT:  { iana: 'America/New_York',  offsetMin: -240 },  // UTC-4
  EST:  { iana: 'America/New_York',  offsetMin: -300 },  // UTC-5
  CST:  { iana: 'America/Chicago',   offsetMin: -360 },  // UTC-6
  CDT:  { iana: 'America/Chicago',   offsetMin: -300 },  // UTC-5
  UTC:  { iana: 'UTC',               offsetMin:    0 },
  UK:   { iana: 'Europe/London',     offsetMin:    0 },  // GMT (simplified)
  GMT:  { iana: 'Europe/London',     offsetMin:    0 },
};

/** Parse a local datetime string + TZ label into a UTC Date.
 *  Accepts: "2026-04-20 09:00", "2026-04-20T09:00", "20/04/2026 09:00"
 */
function localToUtc(localStr: string, tzLabel: string): Date {
  const tz = TZ_OFFSETS[tzLabel.toUpperCase()];
  if (!tz) throw new Error(`Unknown timezone label "${tzLabel}". Use IST, EDT, EST, CST, CDT or UTC.`);

  // Normalise separators
  const normalised = localStr.replace('T', ' ').replace(/\//g, '-');
  // Expect "YYYY-MM-DD HH:MM" or "DD-MM-YYYY HH:MM"
  let parts: RegExpMatchArray | null;

  parts = normalised.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (!parts) {
    parts = normalised.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})/);
    if (parts) {
      // DD-MM-YYYY → swap to YYYY-MM-DD
      parts = [parts[0], parts[3], parts[2], parts[1], parts[4], parts[5]];
    }
  }
  if (!parts) throw new Error(`Cannot parse date "${localStr}". Use YYYY-MM-DD HH:MM or DD/MM/YYYY HH:MM`);

  const [, yr, mo, dy, hr, mn] = parts;
  // Build UTC ms: local time = UTC + offsetMin  →  UTC = local - offsetMin
  const localMs = Date.UTC(Number(yr), Number(mo) - 1, Number(dy), Number(hr), Number(mn));
  return new Date(localMs - tz.offsetMin * 60_000);
}

/** Format a UTC date in the given TZ label for display */
function utcToLocal(utc: Date, tzLabel: string): string {
  const tz = TZ_OFFSETS[tzLabel.toUpperCase()] ?? TZ_OFFSETS.IST;
  const local = new Date(utc.getTime() + tz.offsetMin * 60_000);
  const d = local.toISOString().replace('T', ' ').slice(0, 16);
  return `${d} ${tzLabel.toUpperCase()}`;
}

// ------------------------------------------------------------------ Validation schema

const WindowSchema = z.object({
  scope:         z.enum(['CLUSTER', 'CLIENT']),
  cluster:       z.string().optional(),
  clientDbId:    z.string().optional(),
  clientCode:    z.string().optional(),
  title:         z.string().min(1).max(200),
  reason:        z.string().optional(),
  type:          z.enum(['PLANNED', 'UNSCHEDULED']).default('PLANNED'),
  inputTimezone: z.string().default('IST'),
  startLocal:    z.string(),   // local datetime string entered by user
  endLocal:      z.string(),   // local datetime string entered by user
  source:        z.string().default('manual'),
  importBatchId: z.string().optional(),
  createdBy:     z.string().optional(),
});

// ------------------------------------------------------------------ Calendar entry → Window shape helpers

/** Parse "12:15 AM" or "03:15 AM" or "10.15 PM UK Time" or "next day 01:15 AM UK Time"
 *  → { h, m } in 24-hour format. Strips leading text ("next day"), TZ suffixes, and handles `.` as `:`. */
function parseWindowTime(t: string): { h: number; m: number } | null {
  // Strip TZ suffixes like "UK Time", "EST", etc.
  let cleaned = t.trim().replace(/\s+(UK\s*Time|EST|EDT|CST|CDT|UTC|GMT)\s*$/i, '').trim();
  // Strip leading words like "next day"
  cleaned = cleaned.replace(/^.*?(\d)/i, '$1');
  // Normalise '.' to ':'  ("10.15 PM" → "10:15 PM")
  cleaned = cleaned.replace(/(\d)\.(\d)/, '$1:$2');
  const m = cleaned.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (m[3].toUpperCase() === 'PM' && h !== 12) h += 12;
  if (m[3].toUpperCase() === 'AM' && h === 12) h = 0;
  return { h, m: min };
}

/** Convert a MaintenanceCalendarEntry into a MaintenanceWindow-compatible plain object */
function calEntryToWindow(entry: any, now: Date): any {
  const tzLabel = ((entry.timezone as string) || 'EST').toUpperCase();
  const safeTz  = tzLabel === 'UK' || tzLabel === 'GMT' ? 'UTC' : tzLabel;
  const tz      = TZ_OFFSETS[safeTz] ?? TZ_OFFSETS.UTC;

  // maintenanceDate stores the calendar date as midnight UTC (e.g. 2026-04-22T00:00Z = April 22).
  // Use the UTC date directly — do NOT shift by tz offset, that would move it to April 21 for EST.
  const yr = entry.maintenanceDate.getUTCFullYear();
  const mo = entry.maintenanceDate.getUTCMonth();
  const dy = entry.maintenanceDate.getUTCDate();

  const st = entry.windowStartTime ? parseWindowTime(entry.windowStartTime) : null;
  const et = entry.windowEndTime   ? parseWindowTime(entry.windowEndTime)   : null;

  const startLocalMs = Date.UTC(yr, mo, dy, st?.h ?? 0,  st?.m ?? 0);
  // If end time is unparseable, default to start + 3 hours (typical window duration)
  const defaultEndH = st ? st.h + 3 : 3;
  let   endLocalMs   = Date.UTC(yr, mo, dy, et?.h ?? defaultEndH, et?.m ?? (st?.m ?? 0));
  if (endLocalMs <= startLocalMs) endLocalMs += 86_400_000; // crosses midnight

  const startUtc = new Date(startLocalMs - tz.offsetMin * 60_000);
  const endUtc   = new Date(endLocalMs   - tz.offsetMin * 60_000);

  let status: string = entry.status; // SCHEDULED | CANCELLED
  if (status === 'SCHEDULED') {
    if (startUtc <= now && endUtc >= now) status = 'ACTIVE';
    else if (endUtc < now)               status = 'COMPLETED';
  }

  const clusters   = (entry.clusters as string).trim();
  const windowText = (entry.maintenanceWindow as string) || '';
  const title      = `CL ${clusters} — ${windowText.slice(0, 80)}`;

  return {
    id:           entry.id,
    scope:        'CLUSTER',
    cluster:      clusters,   // full raw string e.g. "19 & 26"
    clientDbId:   null,
    clientCode:   null,
    title,
    reason:       entry.maintenanceGroup,
    type:         'PLANNED',
    status,
    startTimeUtc: startUtc,
    endTimeUtc:   endUtc,
    inputTimezone: safeTz,
    startLocal:   utcToLocal(startUtc, safeTz),
    endLocal:     utcToLocal(endUtc,   safeTz),
    source:       'calendar',
    importBatchId: entry.calendarId,
    createdBy:    null,
    createdAt:    entry.maintenanceDate,
    updatedAt:    entry.maintenanceDate,
  };
}

// ------------------------------------------------------------------ Routes

// GET /api/maintenance - list windows
router.get('/', async (req: Request, res: Response) => {
  try {
    const { cluster, clientDbId, status, type, upcoming } = req.query as Record<string, string>;
    const now = new Date();

    // ── Maintenance Windows ──────────────────────────────────────────────────
    const where: any = {};
    if (cluster) where.cluster = cluster;
    if (clientDbId) where.clientDbId = clientDbId;
    if (status) where.status = status;
    if (type) where.type = type;
    if (upcoming === '1') {
      where.endTimeUtc = { gte: now };
      where.status = { in: ['SCHEDULED', 'ACTIVE'] };
    }

    const windows = await prisma.maintenanceWindow.findMany({
      where,
      orderBy: { startTimeUtc: 'asc' },
    });

    // Auto-update SCHEDULED → ACTIVE / ACTIVE → COMPLETED
    const updates: Promise<any>[] = [];
    for (const w of windows) {
      if (w.status === 'SCHEDULED' && w.startTimeUtc <= now && w.endTimeUtc >= now) {
        updates.push(prisma.maintenanceWindow.update({ where: { id: w.id }, data: { status: 'ACTIVE' } }));
        w.status = 'ACTIVE';
      } else if (w.status === 'ACTIVE' && w.endTimeUtc < now) {
        updates.push(prisma.maintenanceWindow.update({ where: { id: w.id }, data: { status: 'COMPLETED' } }));
        w.status = 'COMPLETED';
      }
    }
    await Promise.all(updates);

    // ── Calendar Entries (merged as window-compatible objects) ───────────────
    // Calendar entries are always PLANNED — skip entirely when filtering UNSCHEDULED
    let calWindows: any[] = [];
    if (!type || type.toUpperCase() !== 'UNSCHEDULED') {
    const calWhere: any = {};
    if (upcoming === '1') {
      // show entries whose maintenance date hasn't fully passed yet
      calWhere.maintenanceDate = { gte: new Date(now.getTime() - 86_400_000) };
      calWhere.status = 'SCHEDULED';
    } else if (status === 'CANCELLED') {
      calWhere.status = 'CANCELLED';
    } else if (status) {
      // SCHEDULED / ACTIVE / COMPLETED are all derived from DB status=SCHEDULED
      calWhere.status = 'SCHEDULED';
    }
    // no type filter for calendar (always PLANNED)
    // no clientDbId filter (calendar entries are cluster-scoped)

    const calEntries = await prisma.maintenanceCalendarEntry.findMany({
      where: calWhere,
      orderBy: { maintenanceDate: 'asc' },
    });

    calWindows = calEntries.map(e => calEntryToWindow(e, now));

    // Apply same status / cluster filters post-conversion
    if (status && status !== 'CANCELLED') {
      calWindows = calWindows.filter((w: any) => w.status === status.toUpperCase());
    }
    if (cluster) {
      // cluster field may be "19 & 26" — match if any token matches
      const clTgt = cluster.replace(/^CL/i, '').trim();
      calWindows = calWindows.filter((w: any) =>
        (w.cluster ?? '').split(/[&,\/]/).map((s: string) => s.trim().replace(/^CL/i, '')).includes(clTgt)
      );
    }
    } // end if (!UNSCHEDULED)

    // ── Merge & sort ────────────────────────────────────────────────────────
    const combined = [...windows, ...calWindows].sort(
      (a: any, b: any) => new Date(a.startTimeUtc).getTime() - new Date(b.startTimeUtc).getTime()
    );

    res.json({ success: true, data: combined });
  } catch (err: any) {
    logger.error(`GET /maintenance: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/maintenance - create a single maintenance window
router.post('/', requirePermission('MAINTENANCE_MANAGE', 'write'), async (req: Request, res: Response) => {
  try {
    const parsed = WindowSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.errors.map(e => e.message).join('; ') });
    }
    const d = parsed.data;

    if (d.scope === 'CLUSTER' && !d.cluster) {
      return res.status(400).json({ success: false, error: 'cluster is required when scope=CLUSTER' });
    }
    if (d.scope === 'CLIENT' && !d.clientDbId) {
      return res.status(400).json({ success: false, error: 'clientDbId is required when scope=CLIENT' });
    }

    const startTimeUtc = localToUtc(d.startLocal, d.inputTimezone);
    const endTimeUtc   = localToUtc(d.endLocal,   d.inputTimezone);

    if (endTimeUtc <= startTimeUtc) {
      return res.status(400).json({ success: false, error: 'End time must be after start time' });
    }

    const win = await prisma.maintenanceWindow.create({
      data: {
        id: uuidv4(),
        scope: d.scope,
        cluster: d.cluster ?? null,
        clientDbId: d.clientDbId ?? null,
        clientCode: d.clientCode ?? null,
        title: d.title,
        reason: d.reason ?? null,
        type: d.type,
        status: startTimeUtc <= new Date() && endTimeUtc >= new Date() ? 'ACTIVE' : 'SCHEDULED',
        startTimeUtc,
        endTimeUtc,
        inputTimezone: d.inputTimezone.toUpperCase(),
        startLocal: utcToLocal(startTimeUtc, d.inputTimezone),
        endLocal:   utcToLocal(endTimeUtc,   d.inputTimezone),
        source: d.source,
        importBatchId: d.importBatchId ?? null,
        createdBy: d.createdBy ?? null,
      },
    });

    logger.info(`Created maintenance window: ${win.title} [${win.scope} ${win.cluster ?? win.clientCode}] ${win.startLocal} → ${win.endLocal}`);
    res.status(201).json({ success: true, data: win });
  } catch (err: any) {
    logger.error(`POST /maintenance: ${err.message}`);
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/maintenance/bulk - create multiple windows (Excel import)
router.post('/bulk', requirePermission('MAINTENANCE_MANAGE', 'write'), async (req: Request, res: Response) => {
  try {
    const { windows, importBatchId } = req.body as {
      windows: z.infer<typeof WindowSchema>[];
      importBatchId?: string;
    };

    if (!Array.isArray(windows) || windows.length === 0) {
      return res.status(400).json({ success: false, error: 'windows array is required' });
    }

    const batchId = importBatchId ?? uuidv4();
    const created = [];
    const errors = [];

    for (let i = 0; i < windows.length; i++) {
      const row = windows[i];
      try {
        const parsed = WindowSchema.safeParse({ ...row, importBatchId: batchId, source: 'excel_import' });
        if (!parsed.success) throw new Error(parsed.error.errors.map(e => e.message).join('; '));
        const d = parsed.data;

        const startTimeUtc = localToUtc(d.startLocal, d.inputTimezone);
        const endTimeUtc   = localToUtc(d.endLocal,   d.inputTimezone);
        if (endTimeUtc <= startTimeUtc) throw new Error('End time must be after start time');

        const win = await prisma.maintenanceWindow.create({
          data: {
            id: uuidv4(),
            scope: d.scope,
            cluster: d.cluster ?? null,
            clientDbId: d.clientDbId ?? null,
            clientCode: d.clientCode ?? null,
            title: d.title,
            reason: d.reason ?? null,
            type: d.type,
            status: startTimeUtc <= new Date() && endTimeUtc >= new Date() ? 'ACTIVE' : 'SCHEDULED',
            startTimeUtc,
            endTimeUtc,
            inputTimezone: d.inputTimezone.toUpperCase(),
            startLocal: utcToLocal(startTimeUtc, d.inputTimezone),
            endLocal:   utcToLocal(endTimeUtc,   d.inputTimezone),
            source: 'excel_import',
            importBatchId: batchId,
            createdBy: d.createdBy ?? null,
          },
        });
        created.push(win);
      } catch (rowErr: any) {
        errors.push({ row: i + 1, error: rowErr.message });
      }
    }

    logger.info(`Bulk import: ${created.length} windows created, ${errors.length} errors (batch ${batchId})`);
    res.status(201).json({ success: true, data: { created: created.length, errors, batchId } });
  } catch (err: any) {
    logger.error(`POST /maintenance/bulk: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/maintenance/:id - update or cancel
router.patch('/:id', requirePermission('MAINTENANCE_MANAGE', 'write'), async (req: Request, res: Response) => {
  try {
    const win = await prisma.maintenanceWindow.findUnique({ where: { id: req.params.id } });
    if (!win) return res.status(404).json({ success: false, error: 'Not found' });

    const { status, title, reason, startLocal, endLocal, inputTimezone } = req.body;
    const update: any = {};

    if (status)  update.status = status;
    if (title)   update.title  = title;
    if (reason !== undefined) update.reason = reason;

    if (startLocal || endLocal) {
      const tz   = inputTimezone ?? win.inputTimezone;
      const sUtc = startLocal ? localToUtc(startLocal, tz) : win.startTimeUtc;
      const eUtc = endLocal   ? localToUtc(endLocal,   tz) : win.endTimeUtc;
      if (eUtc <= sUtc) return res.status(400).json({ success: false, error: 'End time must be after start time' });
      update.startTimeUtc   = sUtc;
      update.endTimeUtc     = eUtc;
      update.inputTimezone  = tz.toUpperCase();
      update.startLocal     = utcToLocal(sUtc, tz);
      update.endLocal       = utcToLocal(eUtc, tz);
    }

    const updated = await prisma.maintenanceWindow.update({ where: { id: req.params.id }, data: update });
    res.json({ success: true, data: updated });
  } catch (err: any) {
    logger.error(`PATCH /maintenance/${req.params.id}: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/maintenance/:id - cancel/delete
router.delete('/:id', requirePermission('MAINTENANCE_MANAGE', 'write'), async (req: Request, res: Response) => {
  try {
    await prisma.maintenanceWindow.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/maintenance/:id/affected-jobs
// Returns all cron jobs whose schedule fires at least once during this window.
// Each job entry includes the fire times (in UTC) and the job's local display TZ.
router.get('/:id/affected-jobs', async (req: Request, res: Response) => {
  try {
    const win = await prisma.maintenanceWindow.findUnique({ where: { id: req.params.id } });
    if (!win) return res.status(404).json({ success: false, error: 'Not found' });

    // Determine which clients are in scope
    let clientDbIds: string[] = [];

    if (win.scope === 'CLUSTER' && win.cluster) {
      const clients = await prisma.client.findMany({
        where: { cluster: win.cluster, isActive: true },
        select: { id: true },
      });
      clientDbIds = clients.map(c => c.id);
    } else if (win.scope === 'CLIENT' && win.clientDbId) {
      clientDbIds = [win.clientDbId];
    }

    if (clientDbIds.length === 0) {
      return res.json({ success: true, data: [] });
    }

    // Fetch all active jobs with cron expressions for those clients
    const jobs = await prisma.job.findMany({
      where: {
        clientId: { in: clientDbIds },
        cronExpression: { not: null },
        isActive: true,
        deleteStatus: null,
      },
      include: {
        client: { select: { clientId: true, name: true, cluster: true, timezone: true } },
      },
    });

    // Also fetch cached cron jobs (might not yet be in Job table)
    const cachedJobs = await prisma.cachedCronJob.findMany({
      where: { clientId: { in: clientDbIds } },
      include: { client: { select: { clientId: true, name: true, cluster: true, timezone: true } } },
    });

    const result: any[] = [];

    // Process Job table entries
    for (const job of jobs) {
      if (!job.cronExpression) continue;
      const fireTimes = getFireTimesInWindow(job.cronExpression, job.serverTimezone ?? job.timezone ?? 'UTC', win.startTimeUtc, win.endTimeUtc);
      if (fireTimes.length === 0) continue;

      const displayTz = win.inputTimezone;
      result.push({
        source: 'job',
        jobId: job.id,
        name: job.name,
        clientId: job.client?.clientId,
        clientName: job.client?.name,
        cluster: job.client?.cluster,
        cronExpression: job.cronExpression,
        serverTimezone: job.serverTimezone,
        command: job.command,
        logPath: job.logPath,
        fireTimesUtc: fireTimes.map(d => d.toISOString()),
        fireTimesLocal: fireTimes.map(d => utcToLocal(d, displayTz)),
        fireCount: fireTimes.length,
      });
    }

    // Process CachedCronJob entries (for clients that haven't synced to Job table yet)
    const seenKeys = new Set(result.map(r => `${r.clientId}::${r.cronExpression}::${r.command}`));
    for (const cc of cachedJobs) {
      const key = `${cc.client?.clientId}::${cc.cronExpression}::${cc.command}`;
      if (seenKeys.has(key)) continue; // Already covered by Job table
      seenKeys.add(key);

      const serverTz = cc.appServer ? undefined : undefined; // AppServer.timezone not included; fallback to client tz
      const tz = cc.client?.timezone ?? 'America/Chicago';
      const fireTimes = getFireTimesInWindow(cc.cronExpression, tz, win.startTimeUtc, win.endTimeUtc);
      if (fireTimes.length === 0) continue;

      const displayTz = win.inputTimezone;
      result.push({
        source: 'cache',
        jobId: cc.id,
        name: `[cached] ${cc.command.split('/').pop()?.split(' ')[0] ?? cc.command.slice(0, 40)}`,
        clientId: cc.client?.clientId,
        clientName: cc.client?.name,
        cluster: cc.client?.cluster,
        cronExpression: cc.cronExpression,
        serverTimezone: tz,
        command: cc.command,
        logPath: cc.logPath,
        fireTimesUtc: fireTimes.map(d => d.toISOString()),
        fireTimesLocal: fireTimes.map(d => utcToLocal(d, displayTz)),
        fireCount: fireTimes.length,
      });
    }

    // Sort by first fire time
    result.sort((a, b) => a.fireTimesUtc[0].localeCompare(b.fireTimesUtc[0]));

    logger.info(`Affected jobs for window "${win.title}": ${result.length} jobs found`);
    res.json({ success: true, data: result, windowInfo: win });
  } catch (err: any) {
    logger.error(`GET /maintenance/${req.params.id}/affected-jobs: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ------------------------------------------------------------------ Helper

/** Use cron-parser to find all fire times in [start, end] for a given cron expression and IANA timezone */
function getFireTimesInWindow(expr: string, tz: string, start: Date, end: Date): Date[] {
  // Map our display TZ labels to IANA if needed
  const ianaMap: Record<string, string> = {
    IST: 'Asia/Kolkata',
    EDT: 'America/New_York',
    EST: 'America/New_York',
    CST: 'America/Chicago',
    CDT: 'America/Chicago',
    UTC: 'UTC',
  };
  const ianaName = ianaMap[tz?.toUpperCase()] ?? tz ?? 'UTC';

  const fireTimes: Date[] = [];
  try {
    const interval = cronParser.parseExpression(expr, {
      tz: ianaName,
      currentDate: new Date(start.getTime() - 1000), // just before window start
    });

    // Safety cap: don't iterate more than 500 fire times
    for (let i = 0; i < 500; i++) {
      const next = interval.next();
      if (next.toDate() > end) break;
      fireTimes.push(next.toDate());
    }
  } catch {
    // Invalid cron expression — skip
  }
  return fireTimes;
}

// ================================================================ Calendar API
// POST /api/maintenance/calendar/import
// Body: { year, fileName, entries: CalendarEntryInput[], importedBy? }
// Each entry: { maintenanceGroup, clusters, maintenanceWindow,
//   windowStartTime?, windowEndTime?, timezone,
//   maintenanceDate (ISO string), month, year, status }
router.post('/calendar/import', requirePermission('MAINTENANCE_MANAGE', 'write'), async (req: Request, res: Response) => {
  try {
    const { year, fileName, importedBy, entries } = req.body as {
      year: number;
      fileName: string;
      importedBy?: string;
      entries: {
        maintenanceGroup: string;
        clusters: string;
        maintenanceWindow: string;
        windowStartTime?: string;
        windowEndTime?: string;
        timezone?: string;
        maintenanceDate: string; // ISO date string
        month: number;
        year: number;
        status: string;
      }[];
    };

    if (!year || !fileName || !Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ success: false, error: 'year, fileName, and entries[] are required' });
    }

    // Delete existing calendar for this year (replace semantics)
    await prisma.maintenanceCalendar.deleteMany({ where: { year } });

    const calendar = await prisma.maintenanceCalendar.create({
      data: {
        year,
        fileName,
        importedBy: importedBy ?? null,
        entryCount: entries.length,
        entries: {
          create: entries.map(e => ({
            maintenanceGroup: e.maintenanceGroup,
            clusters: e.clusters,
            maintenanceWindow: e.maintenanceWindow,
            windowStartTime: e.windowStartTime ?? null,
            windowEndTime: e.windowEndTime ?? null,
            timezone: e.timezone ?? 'EST',
            maintenanceDate: new Date(e.maintenanceDate),
            month: e.month,
            year: e.year,
            status: e.status ?? 'SCHEDULED',
          })),
        },
      },
      include: { entries: false },
    });

    logger.info(`Imported maintenance calendar ${year}: ${entries.length} entries from ${fileName}`);
    res.status(201).json({ success: true, data: { ...calendar, entryCount: entries.length } });
  } catch (err: any) {
    logger.error(`POST /maintenance/calendar/import: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/maintenance/calendar - list all imported calendars
router.get('/calendar', async (_req: Request, res: Response) => {
  try {
    const calendars = await prisma.maintenanceCalendar.findMany({
      orderBy: { year: 'desc' },
    });
    res.json({ success: true, data: calendars });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/maintenance/calendar/:id/entries - entries for a calendar, with optional month filter
router.get('/calendar/:id/entries', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { month, cluster } = req.query as Record<string, string>;

    const where: any = { calendarId: id };
    if (month) where.month = Number(month);
    if (cluster) where.clusters = { contains: cluster };

    const entries = await prisma.maintenanceCalendarEntry.findMany({
      where,
      orderBy: [{ month: 'asc' }, { maintenanceGroup: 'asc' }],
    });
    res.json({ success: true, data: entries });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/maintenance/calendar/:id - remove a calendar and all its entries
router.delete('/calendar/:id', requirePermission('MAINTENANCE_MANAGE', 'write'), async (req: Request, res: Response) => {
  try {
    await prisma.maintenanceCalendar.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
