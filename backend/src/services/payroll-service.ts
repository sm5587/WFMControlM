// ============================================================
// Payroll Service
// Regular vs adjustment from RFX_QUEUE generator jobs.
// Periods from RWS_CALENDAR (current year). Cycle from TA_PAY_FILE_GEN_PROCESS.
// FILE_STATUS = F on TA_UNIT_PAY_STATUS means the pay file was generated.
// Adj outstanding = record-count difference TA_COST_SEG_DIFF vs TA_DIFF_PAY_DETAIL
// for the selected PAY_WEEK_END_DATE (counts only — no pay amounts).
// ============================================================

import { prisma } from '../database/prisma';
import { configService } from './config-service';
import { db2DirectService } from './db2-direct-service';
import {
  PAY_FILE_GENERATED_STATUS,
  PAYROLL_FEATURE_IDS,
  PayScheduleKind,
  PayrollMonitorPhase,
  calendarPeriodsSql,
  classifyMonitorPhase,
  compareMonitorReleaseOrder,
  computeNextCronRunIso,
  computeReleaseDueAtIso,
  defaultPayWeekEnd,
  evaluateStalledGeneration,
  monitorRowKey,
  normalizeFrequency,
  parseFrequencies,
  payJobKind,
  resolveQueueSchedule,
  rfxCompactDateTime,
  sanitizeDistListId,
  sanitizeFrequency,
  sanitizeWeekEnd,
  scheduleKind,
  serializeFrequencies,
  storeMapUnitScopeSql,
  toYyyymmdd,
  weekEndEqualsSql,
} from '../constants/payroll';

export interface PayPeriod {
  weekStartDate: string;
  weekEndDate: string;
  weekNo: string;
  year: string;
  isCurrent: boolean;
  isPrevious: boolean;
}

export interface PayrollRecord {
  unitId: string;
  weekStartDate: string;
  weekEndDate: string;
  fileStatus: string;
  fileId: string;
  generated: boolean;
  generatedAt: string;
  fileName: string;
}

export interface PayrollGenerators {
  regular: { running: boolean; jobType: string | null };
  adjustment: { running: boolean; jobType: string | null };
}

export interface AdjOutstanding {
  costSegCount: number;
  diffPayCount: number;
  outstanding: number;
  error?: string;
}

export interface PayrollSummary {
  totalStores: number;
  generatedCount: number;
  pendingCount: number;
  distinctFileIds: number;
  fileIds: string[];
  generatedAt: string | null;
}

export interface PayFileProcess {
  frequency: string;
  unitGrpId: string;
  fileType: string;
  splitPayfile: string;
  priorPeriodAdjLimit: number;
  reopenForEdits: string;
  payConfigName: string;
}

export interface PayrollResult {
  clientId: string;
  weekEndDate: string;
  frequency: string | null;
  frequencies: string[];
  processes: PayFileProcess[];
  periods: PayPeriod[];
  generators: PayrollGenerators;
  records: PayrollRecord[];
  summary: PayrollSummary;
  adj: AdjOutstanding | null;
  timezone: string;
  executionTimeMs: number;
}

export interface PayrollFeatureSync {
  payrollEnabled: boolean;
  payrollCycle: string;
  payrollFileGen: string;
  priorPeriodEdit: boolean;
  priorPeriodEditLimit: number;
}

export interface PayQueueJobState {
  running: boolean;
  jobType: string | null;
  lastJobTime: string | null;
  jobsPending: number;
}

export interface PayMonitorGenerator {
  queueId: string;
  jobType: string;
  distListId: string;
  execCron: string | null;
  schedule: string;
  scheduleKind: PayScheduleKind;
  releaseDueAt: string | null;
  nextRunAt: string | null;
  lastJobTime: string | null;
  jobsPending: number;
  running: boolean;
}

export interface PayrollMonitorRow {
  rowKey: string;
  clientId: string;
  name: string;
  timezone: string;
  frequencies: string[];
  payrollFileGen: string;
  weekStartDate: string;
  weekEndDate: string;
  distListId: string;
  generator: PayMonitorGenerator;
  units: { total: number; generated: number; pending: number };
  phase: PayrollMonitorPhase;
  stalled: boolean;
  stalledMinutes: number | null;
  error?: string;
}

export interface PayrollMonitorSnapshot {
  fetchedAt: string;
  liveCount: number;
  upcomingCount: number;
  completeCount: number;
  stalledCount: number;
  stalledGraceMins: number;
  rows: PayrollMonitorRow[];
  executionTimeMs: number;
}

export interface PayrollMonitorDetail {
  rowKey: string;
  clientId: string;
  timezone: string;
  weekStartDate: string;
  weekEndDate: string;
  distListId: string;
  generator: PayMonitorGenerator;
  units: { total: number; generated: number; pending: number };
  phase: PayrollMonitorPhase;
  stalled: boolean;
  stalledMinutes: number | null;
  records: PayrollRecord[];
  executionTimeMs: number;
}

const UNIT_STATUS_COLUMNS =
  'u.UNIT_ID, u.WEEK_START_DATE, u.WEEK_END_DATE, u.FILE_STATUS, u.FILE_ID, ' +
  'f.CREATION_TIME, f.LAST_UPDATE_TIME, f.FILE_NAME';

function cell(row: Record<string, string | null> | undefined, key: string): string {
  if (!row) return '';
  const direct = row[key] ?? row[key.toLowerCase()] ?? row[key.toUpperCase()];
  return (direct || '').trim();
}

function parseCount(row: Record<string, string | null> | undefined, key: string): number {
  const n = parseInt(cell(row, key) || '0', 10);
  return Number.isFinite(n) ? n : 0;
}

function generatedAtFromRow(row: Record<string, string | null>): string {
  const ts = cell(row, 'LAST_UPDATE_TIME');
  if (ts) return ts;
  return rfxCompactDateTime(cell(row, 'CREATION_TIME'));
}

function todayYmdUtc(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function emptyQueueJob(): PayQueueJobState {
  return { running: false, jobType: null, lastJobTime: null, jobsPending: 0 };
}

function phaseRank(phase: PayrollMonitorPhase): number {
  if (phase === 'live') return 0;
  if (phase === 'upcoming') return 1;
  if (phase === 'complete') return 2;
  return 3;
}

function stalledRank(stalled: boolean): number {
  return stalled ? 0 : 1;
}

function evaluateRowStalled(
  generator: PayMonitorGenerator,
  weekEndDate: string,
  units: { pending: number },
  graceMins: number,
): { stalled: boolean; stalledMinutes: number | null } {
  return evaluateStalledGeneration({
    scheduleKind: generator.scheduleKind,
    releaseDueAt: generator.releaseDueAt,
    lastJobTime: generator.lastJobTime,
    payWeekEndYmd: weekEndDate,
    running: generator.running,
    units,
    graceMins,
  });
}

class PayrollService {
  async syncClientFeatures(clientId: string): Promise<PayrollFeatureSync> {
    const sql =
      `SELECT FEATURE_ID, FEATURE_VALUE FROM RWSUSER.PRODUCT_FEATURE ` +
      `WHERE FEATURE_ID IN (${PAYROLL_FEATURE_IDS.map(id => `'${id}'`).join(',')})`;

    const result = await db2DirectService.queryClient(clientId, sql, 'Payroll/Features');
    const features: Record<string, string> = {};
    if (result.success && result.rows) {
      for (const row of result.rows) {
        const id = cell(row, 'FEATURE_ID').toUpperCase();
        if (id) features[id] = cell(row, 'FEATURE_VALUE');
      }
    }

    const payrollEnabled = features.RTA_INTEGRATION?.toUpperCase() === 'Y';
    const priorPeriodEdit = features.PRIOR_PERIOD_EDIT?.toUpperCase() === 'Y';
    const limitRaw = parseInt(features.PRIOR_PERIOD_EDIT_LIMIT || '0', 10);
    const priorPeriodEditLimit = Number.isFinite(limitRaw) ? Math.max(0, limitRaw) : 0;
    const payrollFileGen = (features.PAYROLL_FILE_GEN || '').trim().toUpperCase();

    let payrollCycle = 'WK';
    if (payrollEnabled) {
      payrollCycle = serializeFrequencies(await this.fetchFrequencies(clientId));
    }

    return {
      payrollEnabled,
      payrollCycle,
      payrollFileGen,
      priorPeriodEdit,
      priorPeriodEditLimit,
    };
  }

  async getPayrollStatus(clientId: string, weekEndParam?: string, frequencyParam?: string): Promise<PayrollResult> {
    const startMs = Date.now();
    const periodsRaw = await this.fetchPeriods(clientId);
    const previousWeek = defaultPayWeekEnd(periodsRaw);
    const periods = periodsRaw.map(p => ({
      ...p,
      isPrevious: !!previousWeek && p.weekEndDate === previousWeek && !p.isCurrent,
    }));
    const requested = sanitizeWeekEnd(weekEndParam);
    const current = periods.find(p => p.isCurrent);
    const weekEndDate = requested
      || previousWeek
      || current?.weekEndDate
      || periods[periods.length - 1]?.weekEndDate
      || '';

    if (!weekEndDate) {
      throw new Error(`No pay periods found in RWS_CALENDAR for ${clientId}`);
    }

    const allProcesses = await this.fetchPayProcesses(clientId);
    const frequencies = allProcesses.length
      ? parseFrequencies(allProcesses.map(p => p.frequency).join(','))
      : ['WK'];
    const frequency = sanitizeFrequency(frequencyParam) || frequencies[0] || null;
    const processes = frequency
      ? allProcesses.filter(p => p.frequency === frequency)
      : allProcesses;

    const local = await prisma.client.findUnique({
      where: { clientId },
      select: { priorPeriodEdit: true, priorPeriodEditLimit: true, payrollCycle: true, timezone: true },
    });
    const adjEligible = !!(local?.priorPeriodEdit && (local.priorPeriodEditLimit || 0) > 0);

    if (allProcesses.length && local) {
      const serialized = serializeFrequencies(frequencies);
      if (local.payrollCycle !== serialized) {
        await prisma.client.update({
          where: { clientId },
          data: { payrollCycle: serialized },
        });
      }
    }

    const [generators, records, adj] = await Promise.all([
      this.fetchGenerators(clientId),
      this.fetchUnitPayStatus(clientId, weekEndDate),
      adjEligible ? this.fetchAdjOutstanding(clientId, weekEndDate) : Promise.resolve(null),
    ]);

    const fileIds = [...new Set(records.filter(r => r.generated && r.fileId).map(r => r.fileId))];
    const generatedCount = records.filter(r => r.generated).length;
    const generatedTimes = records.map(r => r.generatedAt).filter(Boolean).sort();
    const generatedAt = generatedTimes[generatedTimes.length - 1] || null;

    return {
      clientId,
      weekEndDate,
      frequency,
      frequencies,
      processes,
      periods,
      generators,
      records,
      summary: {
        totalStores: records.length,
        generatedCount,
        pendingCount: records.length - generatedCount,
        distinctFileIds: fileIds.length,
        fileIds,
        generatedAt,
      },
      adj,
      timezone: local?.timezone || 'America/Chicago',
      executionTimeMs: Date.now() - startMs,
    };
  }

  private async fetchFrequencies(clientId: string): Promise<string[]> {
    const sql =
      `SELECT DISTINCT FREQUENCY FROM RWSUSER.TA_PAY_FILE_GEN_PROCESS ` +
      `WHERE FREQUENCY IS NOT NULL`;
    try {
      const result = await db2DirectService.queryClient(clientId, sql, 'Payroll/Frequency');
      if (result.success && result.rows && result.rows.length > 0) {
        return parseFrequencies(result.rows.map(r => cell(r, 'FREQUENCY')).join(','));
      }
    } catch {
      // table missing on some clients
    }
    return ['WK'];
  }

  private async fetchPayProcesses(clientId: string): Promise<PayFileProcess[]> {
    const sql =
      `SELECT FREQUENCY, UNIT_GRP_ID, FILE_TYPE, SPLIT_PAYFILE, PRIOR_PERIOD_ADJ_LIMIT, ` +
      `REOPEN_FOR_EDITS, PAY_CONFIG_NAME ` +
      `FROM RWSUSER.TA_PAY_FILE_GEN_PROCESS`;
    try {
      const result = await db2DirectService.queryClient(clientId, sql, 'Payroll/Processes');
      if (!result.success || !result.rows) return [];
      return result.rows.map(row => ({
        frequency: normalizeFrequency(cell(row, 'FREQUENCY')) || cell(row, 'FREQUENCY'),
        unitGrpId: cell(row, 'UNIT_GRP_ID'),
        fileType: cell(row, 'FILE_TYPE'),
        splitPayfile: cell(row, 'SPLIT_PAYFILE'),
        priorPeriodAdjLimit: parseCount(row, 'PRIOR_PERIOD_ADJ_LIMIT'),
        reopenForEdits: cell(row, 'REOPEN_FOR_EDITS'),
        payConfigName: cell(row, 'PAY_CONFIG_NAME'),
      })).filter(p => p.frequency);
    } catch {
      return [];
    }
  }

  private async fetchPeriods(clientId: string): Promise<PayPeriod[]> {
    const result = await db2DirectService.queryClient(clientId, calendarPeriodsSql(), 'Payroll/Calendar');
    if (!result.success || !result.rows) {
      throw new Error(result.error || `Failed to query RWS_CALENDAR for ${clientId}`);
    }

    const today = toYyyymmdd(cell(result.rows[0], 'TODAY_YMD')) || todayYmdUtc();
    return result.rows.map(row => {
      const weekStartDate = toYyyymmdd(cell(row, 'WEEK_START_DATE'));
      const weekEndDate = toYyyymmdd(cell(row, 'WEEK_END_DATE'));
      return {
        weekStartDate,
        weekEndDate,
        weekNo: '',
        year: weekStartDate.slice(0, 4),
        isCurrent: !!weekStartDate && !!weekEndDate && weekStartDate <= today && today <= weekEndDate,
        isPrevious: false,
      };
    }).filter(p => p.weekEndDate);
  }

  private async fetchGenerators(clientId: string): Promise<PayrollGenerators> {
    const sql =
      `SELECT JOB_TYPE FROM RWSUSER.RFX_QUEUE ` +
      `WHERE QUEUE_STATUS = 'R'`;

    const empty: PayrollGenerators = {
      regular: { running: false, jobType: null },
      adjustment: { running: false, jobType: null },
    };

    try {
      const result = await db2DirectService.queryClient(clientId, sql, 'Payroll/Queue');
      if (!result.success || !result.rows) return empty;

      let regularJob: string | null = null;
      let adjJob: string | null = null;

      for (const row of result.rows) {
        const blob = cell(row, 'JOB_TYPE');
        const kind = payJobKind(blob);
        if (kind === 'regular' && !regularJob) regularJob = blob;
        if (kind === 'adjustment' && !adjJob) adjJob = blob;
      }

      return {
        regular: { running: !!regularJob, jobType: regularJob },
        adjustment: { running: !!adjJob, jobType: adjJob },
      };
    } catch {
      return empty;
    }
  }

  private async fetchUnitPayStatus(clientId: string, weekEndDate: string): Promise<PayrollRecord[]> {
    const sql =
      `SELECT ${UNIT_STATUS_COLUMNS} FROM RWSUSER.TA_UNIT_PAY_STATUS u ` +
      `LEFT JOIN RWSUSER.TA_PAY_FILE f ON f.FILE_ID = u.FILE_ID ` +
      `WHERE ${weekEndEqualsSql('u.WEEK_END_DATE', weekEndDate)} ` +
      `ORDER BY u.UNIT_ID`;

    const fallbackSql =
      `SELECT UNIT_ID, WEEK_START_DATE, WEEK_END_DATE, FILE_STATUS, FILE_ID ` +
      `FROM RWSUSER.TA_UNIT_PAY_STATUS ` +
      `WHERE ${weekEndEqualsSql('WEEK_END_DATE', weekEndDate)} ` +
      `ORDER BY UNIT_ID`;

    let result = await db2DirectService.queryClient(clientId, sql, 'Payroll/UnitStatus');
    if (!result.success) {
      result = await db2DirectService.queryClient(clientId, fallbackSql, 'Payroll/UnitStatusFallback');
    }
    if (!result.success || !result.rows) {
      throw new Error(result.error || `Failed to query TA_UNIT_PAY_STATUS for ${clientId}`);
    }

    return result.rows.map(row => {
      const fileStatus = cell(row, 'FILE_STATUS');
      const generated = fileStatus.toUpperCase() === PAY_FILE_GENERATED_STATUS;
      return {
        unitId: cell(row, 'UNIT_ID'),
        weekStartDate: toYyyymmdd(cell(row, 'WEEK_START_DATE')),
        weekEndDate: toYyyymmdd(cell(row, 'WEEK_END_DATE')),
        fileStatus,
        fileId: cell(row, 'FILE_ID'),
        generated,
        generatedAt: generated ? generatedAtFromRow(row) : '',
        fileName: cell(row, 'FILE_NAME'),
      };
    });
  }

  private async fetchAdjOutstanding(clientId: string, weekEndDate: string): Promise<AdjOutstanding | null> {
    const sql =
      `SELECT ` +
      `(SELECT COUNT(*) FROM RWSUSER.TA_COST_SEG_DIFF WHERE ${weekEndEqualsSql('PAY_WEEK_END_DATE', weekEndDate)}) AS COST_SEG_CNT, ` +
      `(SELECT COUNT(*) FROM RWSUSER.TA_DIFF_PAY_DETAIL WHERE ${weekEndEqualsSql('PAY_WEEK_END_DATE', weekEndDate)}) AS DIFF_PAY_CNT ` +
      `FROM SYSIBM.SYSDUMMY1`;

    try {
      const result = await db2DirectService.queryClient(clientId, sql, 'Payroll/AdjDelta');
      if (!result.success || !result.rows || !result.rows[0]) {
        return { costSegCount: 0, diffPayCount: 0, outstanding: 0, error: result.error };
      }
      const costSegCount = parseCount(result.rows[0], 'COST_SEG_CNT');
      const diffPayCount = parseCount(result.rows[0], 'DIFF_PAY_CNT');
      return {
        costSegCount,
        diffPayCount,
        outstanding: Math.abs(costSegCount - diffPayCount),
      };
    } catch (err: any) {
      return {
        costSegCount: 0,
        diffPayCount: 0,
        outstanding: 0,
        error: err.message || 'Adj delta query failed',
      };
    }
  }

  async getMonitorSnapshot(): Promise<PayrollMonitorSnapshot> {
    const startMs = Date.now();
    const stalledGraceMins = configService.getInt('threshold.payrollStalledGraceMins', 30);
    const clients = await prisma.client.findMany({
      where: { payrollEnabled: true, isActive: true, db2Host: { not: null } },
      select: {
        clientId: true,
        name: true,
        timezone: true,
        payrollCycle: true,
        payrollFileGen: true,
      },
      orderBy: { clientId: 'asc' },
    });

    const CONCURRENCY = 5;
    const rows: PayrollMonitorRow[] = [];
    let idx = 0;

    const worker = async () => {
      while (idx < clients.length) {
        const c = clients[idx++];
        rows.push(...await this.scanMonitorClient(c, stalledGraceMins));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, clients.length || 1) }, () => worker()));
    rows.sort((a, b) =>
      phaseRank(a.phase) - phaseRank(b.phase)
      || stalledRank(a.stalled) - stalledRank(b.stalled)
      || compareMonitorReleaseOrder(a.generator, b.generator)
      || a.clientId.localeCompare(b.clientId)
      || a.distListId.localeCompare(b.distListId),
    );

    return {
      fetchedAt: new Date().toISOString(),
      liveCount: rows.filter(r => r.phase === 'live').length,
      upcomingCount: rows.filter(r => r.phase === 'upcoming').length,
      completeCount: rows.filter(r => r.phase === 'complete').length,
      stalledCount: rows.filter(r => r.stalled).length,
      stalledGraceMins,
      rows,
      executionTimeMs: Date.now() - startMs,
    };
  }

  async getMonitorDetail(clientId: string, distListId: string): Promise<PayrollMonitorDetail> {
    const startMs = Date.now();
    const safeDistListId = sanitizeDistListId(distListId);
    if (!safeDistListId) {
      throw new Error(`Invalid store group DIST_LIST_ID: ${distListId}`);
    }

    const local = await prisma.client.findUnique({
      where: { clientId },
      select: { timezone: true },
    });
    const timezone = local?.timezone || 'America/Chicago';
    const periods = await this.fetchPeriods(clientId);
    const weekEndDate = defaultPayWeekEnd(periods) || periods.find(p => p.isCurrent)?.weekEndDate || '';
    const generators = await this.fetchPayGenerators(clientId, timezone, weekEndDate);
    const weekStartDate = periods.find(p => p.weekEndDate === weekEndDate)?.weekStartDate || '';
    const generator = generators.find(g => g.distListId === safeDistListId);
    if (!generator) {
      throw new Error(`No pay generator queue row for ${clientId} store group ${safeDistListId}`);
    }

    const records = weekEndDate
      ? await this.fetchScopedUnitPayStatus(clientId, weekEndDate, safeDistListId)
      : [];
    const generated = records.filter(r => r.generated).length;
    const units = { total: records.length, generated, pending: records.length - generated };
    const stalledGraceMins = configService.getInt('threshold.payrollStalledGraceMins', 30);
    const phase = classifyMonitorPhase({
      scheduleKind: generator.scheduleKind,
      releaseDueAt: generator.releaseDueAt,
      lastJobTime: generator.lastJobTime,
      payWeekEndYmd: weekEndDate,
      running: generator.running,
      jobsPending: generator.jobsPending,
      units,
    });
    const { stalled, stalledMinutes } = evaluateRowStalled(generator, weekEndDate, units, stalledGraceMins);

    return {
      rowKey: monitorRowKey(clientId, safeDistListId),
      clientId,
      timezone,
      weekStartDate,
      weekEndDate,
      distListId: safeDistListId,
      generator,
      units,
      phase,
      stalled,
      stalledMinutes,
      records,
      executionTimeMs: Date.now() - startMs,
    };
  }

  private async scanMonitorClient(c: {
    clientId: string;
    name: string;
    timezone: string;
    payrollCycle: string;
    payrollFileGen: string;
  }, stalledGraceMins: number): Promise<PayrollMonitorRow[]> {
    const baseRow = {
      clientId: c.clientId,
      name: c.name,
      timezone: c.timezone,
      frequencies: parseFrequencies(c.payrollCycle),
      payrollFileGen: c.payrollFileGen,
      weekStartDate: '',
      weekEndDate: '',
    };

    try {
      const periods = await this.fetchPeriods(c.clientId);
      const weekEndDate = defaultPayWeekEnd(periods) || periods.find(p => p.isCurrent)?.weekEndDate || '';
      const generators = await this.fetchPayGenerators(c.clientId, c.timezone, weekEndDate);
      const weekStartDate = periods.find(p => p.weekEndDate === weekEndDate)?.weekStartDate || '';

      if (!generators.length) {
        return [{
          ...baseRow,
          rowKey: monitorRowKey(c.clientId, 'none'),
          distListId: '',
          generator: this.emptyMonitorGenerator('', c.timezone, weekEndDate),
          units: { total: 0, generated: 0, pending: 0 },
          phase: 'unknown',
          stalled: false,
          stalledMinutes: null,
          error: 'No regular pay generator rows with PARAM_3 store group in RFX_QUEUE',
        }];
      }

      const rows: PayrollMonitorRow[] = [];
      for (const generator of generators) {
        try {
          const units = weekEndDate
            ? await this.fetchScopedUnitCounts(c.clientId, weekEndDate, generator.distListId)
            : { total: 0, generated: 0, pending: 0 };
          const { stalled, stalledMinutes } = evaluateRowStalled(
            generator, weekEndDate, units, stalledGraceMins,
          );
          rows.push({
            ...baseRow,
            rowKey: monitorRowKey(c.clientId, generator.distListId),
            weekStartDate,
            weekEndDate,
            distListId: generator.distListId,
            generator,
            units,
            phase: classifyMonitorPhase({
              scheduleKind: generator.scheduleKind,
              releaseDueAt: generator.releaseDueAt,
              lastJobTime: generator.lastJobTime,
              payWeekEndYmd: weekEndDate,
              running: generator.running,
              jobsPending: generator.jobsPending,
              units,
            }),
            stalled,
            stalledMinutes,
          });
        } catch (err: any) {
          rows.push({
            ...baseRow,
            rowKey: monitorRowKey(c.clientId, generator.distListId),
            weekStartDate,
            weekEndDate,
            distListId: generator.distListId,
            generator,
            units: { total: 0, generated: 0, pending: 0 },
            phase: 'unknown',
            stalled: false,
            stalledMinutes: null,
            error: err.message || 'Monitor scan failed',
          });
        }
      }
      return rows;
    } catch (err: any) {
      return [{
        ...baseRow,
        rowKey: monitorRowKey(c.clientId, 'none'),
        distListId: '',
        generator: this.emptyMonitorGenerator('', c.timezone, ''),
        units: { total: 0, generated: 0, pending: 0 },
        phase: 'unknown',
        stalled: false,
        stalledMinutes: null,
        error: err.message || 'Monitor scan failed',
      }];
    }
  }

  private emptyMonitorGenerator(jobType: string, timezone: string, payWeekEndYmd: string): PayMonitorGenerator {
    return {
      queueId: '',
      jobType,
      distListId: '',
      execCron: null,
      schedule: '',
      scheduleKind: 'unknown',
      releaseDueAt: null,
      nextRunAt: null,
      lastJobTime: null,
      jobsPending: 0,
      running: false,
    };
  }

  private mapPayGeneratorRow(
    row: Record<string, string | null>,
    timezone: string,
    payWeekEndYmd: string,
  ): PayMonitorGenerator | null {
    const jobType = cell(row, 'JOB_TYPE');
    if (payJobKind(jobType) !== 'regular') return null;

    const distListId = sanitizeDistListId(cell(row, 'DIST_LIST_ID'));
    if (!distListId) return null;

    const execCronRaw = cell(row, 'EXEC_CRON') || null;
    const schedule = resolveQueueSchedule(execCronRaw, cell(row, 'QUEUE_SLEEP') || null);
    const kind = scheduleKind(schedule);

    return {
      queueId: cell(row, 'QUEUE_ID'),
      jobType,
      distListId,
      execCron: execCronRaw,
      schedule,
      scheduleKind: kind,
      releaseDueAt: payWeekEndYmd && kind === 'cron'
        ? computeReleaseDueAtIso(schedule, timezone, payWeekEndYmd)
        : null,
      nextRunAt: kind === 'cron' ? computeNextCronRunIso(schedule, timezone) : null,
      lastJobTime: cell(row, 'LAST_JOB_TIME') || null,
      jobsPending: parseCount(row, 'JOBS_PENDING'),
      running: cell(row, 'QUEUE_STATUS').toUpperCase() === 'R',
    };
  }

  private async fetchPayGenerators(
    clientId: string,
    timezone: string,
    payWeekEndYmd: string,
  ): Promise<PayMonitorGenerator[]> {
    const sql =
      `SELECT q.QUEUE_ID, q.JOB_TYPE, q.EXEC_CRON, q.QUEUE_SLEEP, ` +
      `q.LAST_JOB_TIME, q.JOBS_PENDING, q.QUEUE_STATUS, s.PARAM_3 AS DIST_LIST_ID ` +
      `FROM RWSUSER.RFX_QUEUE q ` +
      `LEFT JOIN RWSUSER.STD_QUEUE_JOB s ON s.QUEUE_ID = q.QUEUE_ID ` +
      `WHERE q.QUEUE_STATUS = 'R'`;

    const result = await db2DirectService.queryClient(clientId, sql, 'Payroll/MonitorQueue');
    if (!result.success || !result.rows) return [];

    const byDistList = new Map<string, PayMonitorGenerator>();
    for (const row of result.rows) {
      const mapped = this.mapPayGeneratorRow(row, timezone, payWeekEndYmd);
      if (!mapped) continue;
      const existing = byDistList.get(mapped.distListId);
      if (!existing || mapped.jobsPending > existing.jobsPending) {
        byDistList.set(mapped.distListId, mapped);
      }
    }
    return [...byDistList.values()].sort((a, b) => a.distListId.localeCompare(b.distListId));
  }

  private async fetchScopedUnitCounts(
    clientId: string,
    weekEndDate: string,
    distListId: string,
  ): Promise<{ total: number; generated: number; pending: number }> {
    const sql =
      `SELECT COUNT(*) AS TOTAL_CNT, ` +
      `SUM(CASE WHEN UPPER(FILE_STATUS) = '${PAY_FILE_GENERATED_STATUS}' THEN 1 ELSE 0 END) AS GENERATED_CNT ` +
      `FROM RWSUSER.TA_UNIT_PAY_STATUS u ` +
      `WHERE ${weekEndEqualsSql('u.WEEK_END_DATE', weekEndDate)} ` +
      `AND ${storeMapUnitScopeSql(distListId, weekEndDate, 'u.UNIT_ID')}`;
    const result = await db2DirectService.queryClient(clientId, sql, 'Payroll/MonitorCounts');
    if (!result.success || !result.rows || !result.rows[0]) {
      throw new Error(result.error || `Failed to query scoped unit counts for ${clientId}`);
    }
    const total = parseCount(result.rows[0], 'TOTAL_CNT');
    const generated = parseCount(result.rows[0], 'GENERATED_CNT');
    return { total, generated, pending: Math.max(0, total - generated) };
  }

  private async fetchScopedUnitPayStatus(
    clientId: string,
    weekEndDate: string,
    distListId: string,
  ): Promise<PayrollRecord[]> {
    const sql =
      `SELECT ${UNIT_STATUS_COLUMNS} FROM RWSUSER.TA_UNIT_PAY_STATUS u ` +
      `LEFT JOIN RWSUSER.TA_PAY_FILE f ON f.FILE_ID = u.FILE_ID ` +
      `WHERE ${weekEndEqualsSql('u.WEEK_END_DATE', weekEndDate)} ` +
      `AND ${storeMapUnitScopeSql(distListId, weekEndDate, 'u.UNIT_ID')} ` +
      `ORDER BY u.UNIT_ID`;

    const fallbackSql =
      `SELECT UNIT_ID, WEEK_START_DATE, WEEK_END_DATE, FILE_STATUS, FILE_ID ` +
      `FROM RWSUSER.TA_UNIT_PAY_STATUS u ` +
      `WHERE ${weekEndEqualsSql('u.WEEK_END_DATE', weekEndDate)} ` +
      `AND ${storeMapUnitScopeSql(distListId, weekEndDate, 'u.UNIT_ID')} ` +
      `ORDER BY UNIT_ID`;

    let result = await db2DirectService.queryClient(clientId, sql, 'Payroll/UnitStatus');
    if (!result.success) {
      result = await db2DirectService.queryClient(clientId, fallbackSql, 'Payroll/UnitStatusFallback');
    }
    if (!result.success || !result.rows) {
      throw new Error(result.error || `Failed to query scoped TA_UNIT_PAY_STATUS for ${clientId}`);
    }

    return result.rows.map(row => {
      const fileStatus = cell(row, 'FILE_STATUS');
      const generated = fileStatus.toUpperCase() === PAY_FILE_GENERATED_STATUS;
      return {
        unitId: cell(row, 'UNIT_ID'),
        weekStartDate: toYyyymmdd(cell(row, 'WEEK_START_DATE')),
        weekEndDate: toYyyymmdd(cell(row, 'WEEK_END_DATE')),
        fileStatus,
        fileId: cell(row, 'FILE_ID'),
        generated,
        generatedAt: generated ? generatedAtFromRow(row) : '',
        fileName: cell(row, 'FILE_NAME'),
      };
    });
  }
}

export const payrollService = new PayrollService();
