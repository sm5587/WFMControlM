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
import { payrollDeadlineAlertService } from './payroll-deadline-alert-service';
import { escalationService } from './escalation-service';
import { logger } from '../utils/logger';
import {
  CLIENT_WIDE_DIST_LIST_ID,
  EMPTY_FILE_STATUS_COUNTS,
  PAY_FILE_GENERATED_STATUS,
  PAYROLL_FEATURE_IDS,
  PayScheduleKind,
  PayrollFileStatusCounts,
  PayrollMonitorPhase,
  calendarPeriodsSql,
  DEFAULT_PAYROLL_LIVE_WINDOW_HOURS,
  classifyMonitorPhase,
  compareMonitorReleaseOrder,
  computeNextCronRunIso,
  computeReleaseDueAtIso,
  countFileStatuses,
  defaultPayWeekEnd,
  evaluatePayrollDeadlineLate,
  evaluateStalledGeneration,
  isClientWideDistList,
  isPayrollDeadlineAttentionLate,
  isWithinPayrollLiveWindow,
  monitorRowKey,
  calendarWeekEndOnOrBefore,
  frequencyUsesCalendarWeekEndQuery,
  periodsForFrequency,
  priorPayWeekEnd,
  normalizeFrequency,
  parseFrequencies,
  payJobKind,
  regularPayJobRank,
  resolvePayrollDeadlineAtIso,
  resolveQueueSchedule,
  resolveWeekEndInPeriods,
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

export interface PayrollUnitCounts {
  total: number;
  generated: number;
  pending: number;
  /** This-week FILE_STATUS buckets (F/D/Q/blank); blank includes null and any other code. */
  byStatus: PayrollFileStatusCounts;
}

const EMPTY_UNITS: PayrollUnitCounts = {
  total: 0,
  generated: 0,
  pending: 0,
  byStatus: { ...EMPTY_FILE_STATUS_COUNTS },
};

/** Prior-week FILE_STATUS=F baseline; `generated` is the expected store count for the week in question. */
export interface PriorWeekGeneratedCompare {
  weekEndDate: string;
  total: number;
  generated: number;
}

export interface PayrollSummary {
  totalStores: number;
  generatedCount: number;
  pendingCount: number;
  distinctFileIds: number;
  fileIds: string[];
  generatedAt: string | null;
  /** Stores with FILE_STATUS=F on the prior calendar week (same scope). */
  priorWeek: PriorWeekGeneratedCompare | null;
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
  payrollDeadlineDaysAfterWeekEnd: number | null;
  payrollDeadlineDayOfMonth: number | null;
  payrollDeadlineLocalTime: string | null;
  payrollMonitorEnabled: boolean;
  deadlineAt: string | null;
  /** True when Escalated deadline alert was resolved for this pay week. */
  deadlineResolved: boolean;
  /** Attention Late (false when deadlineResolved for this week). */
  late: boolean;
  lateMinutes: number | null;
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
  /** From RWS_DIST_LIST.NAME when PARAM_3 matches a store group; null for ALL / unknown. */
  distListName: string | null;
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
  distListName: string | null;
  generator: PayMonitorGenerator;
  units: PayrollUnitCounts;
  priorWeek: PriorWeekGeneratedCompare | null;
  phase: PayrollMonitorPhase;
  stalled: boolean;
  stalledMinutes: number | null;
  deadlineAt: string | null;
  /** Escalated alert resolved for this pay week — no Late attention. */
  deadlineResolved: boolean;
  /** Attention Late (suppressed when deadlineResolved). */
  late: boolean;
  lateMinutes: number | null;
  error?: string;
}

export interface PayrollMonitorSnapshot {
  fetchedAt: string;
  liveCount: number;
  upcomingCount: number;
  completeCount: number;
  stalledCount: number;
  lateCount: number;
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
  distListName: string | null;
  generator: PayMonitorGenerator;
  units: PayrollUnitCounts;
  priorWeek: PriorWeekGeneratedCompare | null;
  phase: PayrollMonitorPhase;
  stalled: boolean;
  stalledMinutes: number | null;
  deadlineAt: string | null;
  deadlineResolved: boolean;
  late: boolean;
  lateMinutes: number | null;
  records: PayrollRecord[];
  executionTimeMs: number;
}

const UNIT_STATUS_COLUMNS =
  'u.UNIT_ID, u.WEEK_START_DATE, u.WEEK_END_DATE, u.FILE_STATUS, u.FILE_ID, ' +
  'f.CREATION_TIME, f.LAST_UPDATE_TIME, f.FILE_NAME';

function cell(row: Record<string, string | null> | undefined, key: string): string {
  if (!row) return '';
  const direct = row[key] ?? row[key.toLowerCase()] ?? row[key.toUpperCase()];
  if (direct == null) return '';
  const s = String(direct).trim();
  // DB2/JDBC occasionally stringifies SQL NULL as the literal "null"
  if (!s || /^null$/i.test(s) || /^undefined$/i.test(s)) return '';
  return s;
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
  if (phase === 'late') return 0;
  if (phase === 'live') return 1;
  if (phase === 'upcoming') return 2;
  if (phase === 'complete') return 3;
  return 4;
}

function stalledRank(stalled: boolean): number {
  return stalled ? 0 : 1;
}

function lateRank(late: boolean): number {
  return late ? 0 : 1;
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

function evaluateRowDeadline(
  weekEndDate: string,
  timezone: string,
  daysAfter: number | null | undefined,
  dayOfMonth: number | null | undefined,
  localTime: string | null | undefined,
  pendingUnits: number,
): { deadlineAt: string | null; late: boolean; lateMinutes: number | null } {
  const deadlineAt = resolvePayrollDeadlineAtIso({
    payWeekEndYmd: weekEndDate,
    daysAfterWeekEnd: daysAfter,
    dayOfMonth,
    localTime,
    tz: timezone,
  });
  const { late, lateMinutes } = evaluatePayrollDeadlineLate({
    deadlineAt,
    pendingUnits,
  });
  return { deadlineAt, late, lateMinutes };
}

/**
 * Expected store count = prior week's FILE_STATUS=F count when available.
 * e.g. 40 generated this week / 53 that had F last week → pending 13.
 * `byStatus` is always this week's FILE_STATUS breakdown (unchanged by baseline).
 */
function unitsAgainstPriorBaseline(
  currentGenerated: number,
  currentTotal: number,
  priorWeek: PriorWeekGeneratedCompare | null,
  byStatus: PayrollFileStatusCounts = EMPTY_FILE_STATUS_COUNTS,
): PayrollUnitCounts {
  const total = priorWeek && priorWeek.generated > 0 ? priorWeek.generated : currentTotal;
  return {
    total,
    generated: currentGenerated,
    pending: Math.max(0, total - currentGenerated),
    byStatus: { ...byStatus },
  };
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

  async getPayrollStatus(
    clientId: string,
    weekEndParam?: string,
    frequencyParam?: string,
    includeRecords = false,
  ): Promise<PayrollResult> {
    const startMs = Date.now();
    const [periodsRaw, allProcesses] = await Promise.all([
      this.fetchPeriods(clientId),
      this.fetchPayProcesses(clientId),
    ]);
    const frequencies = allProcesses.length
      ? parseFrequencies(allProcesses.map(p => p.frequency).join(','))
      : ['WK'];
    const frequency = sanitizeFrequency(frequencyParam) || frequencies[0] || null;
    const processes = frequency
      ? allProcesses.filter(p => p.frequency === frequency)
      : allProcesses;

    const periodsForFreq = periodsForFrequency(periodsRaw, frequency);
    const previousWeek = defaultPayWeekEnd(periodsForFreq);
    const periods = periodsForFreq.map(p => ({
      ...p,
      isPrevious: !!previousWeek && p.weekEndDate === previousWeek && !p.isCurrent,
    }));
    const requested = resolveWeekEndInPeriods(periods, sanitizeWeekEnd(weekEndParam));
    const current = periods.find(p => p.isCurrent);
    const weekEndDate = requested
      || previousWeek
      || current?.weekEndDate
      || periods[periods.length - 1]?.weekEndDate
      || '';

    if (!weekEndDate) {
      throw new Error(`No pay periods found in RWS_CALENDAR for ${clientId}`);
    }

    // SM/GM period ends are calendar bounds; TA_* tables still key by RWS week-end.
    const mapQueryWeekEnd = (periodEnd: string) => {
      if (!frequencyUsesCalendarWeekEndQuery(frequency)) return periodEnd;
      return calendarWeekEndOnOrBefore(periodsRaw, periodEnd) || periodEnd;
    };
    const queryWeekEnd = mapQueryWeekEnd(weekEndDate);

    const local = await prisma.client.findUnique({
      where: { clientId },
      select: {
        priorPeriodEdit: true,
        priorPeriodEditLimit: true,
        payrollCycle: true,
        timezone: true,
        payrollDeadlineDaysAfterWeekEnd: true,
        payrollDeadlineDayOfMonth: true,
        payrollDeadlineLocalTime: true,
        payrollMonitorEnabled: true,
        name: true,
      },
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

    const [generators, records, adj, priorWeek] = await Promise.all([
      this.fetchGenerators(clientId),
      this.fetchUnitPayStatus(clientId, queryWeekEnd),
      adjEligible ? this.fetchAdjOutstanding(clientId, queryWeekEnd) : Promise.resolve(null),
      this.fetchPriorWeekCompare(
        clientId,
        periods,
        weekEndDate,
        CLIENT_WIDE_DIST_LIST_ID,
        mapQueryWeekEnd,
      ),
    ]);

    const fileIds = [...new Set(records.filter(r => r.generated && r.fileId).map(r => r.fileId))];
    const generatedCount = records.filter(r => r.generated).length;
    // Denominator = prior week FILE_STATUS=F count (expected stores), not this week's row count.
    const { total: totalStores, pending: pendingCount } = unitsAgainstPriorBaseline(
      generatedCount,
      records.length,
      priorWeek,
    );
    const generatedTimes = records.map(r => r.generatedAt).filter(Boolean).sort();
    const generatedAt = generatedTimes[generatedTimes.length - 1] || null;
    const timezone = local?.timezone || 'America/Chicago';
    const payrollDeadlineDaysAfterWeekEnd = local?.payrollDeadlineDaysAfterWeekEnd ?? null;
    const payrollDeadlineDayOfMonth = local?.payrollDeadlineDayOfMonth ?? null;
    const payrollDeadlineLocalTime = local?.payrollDeadlineLocalTime ?? null;
    const { deadlineAt, late: factuallyLate, lateMinutes: factualLateMinutes } = evaluateRowDeadline(
      weekEndDate,
      timezone,
      payrollDeadlineDaysAfterWeekEnd,
      payrollDeadlineDayOfMonth,
      payrollDeadlineLocalTime,
      pendingCount,
    );
    const monitorOn = !!local?.payrollMonitorEnabled;
    const deadlineResolved = monitorOn
      && await payrollDeadlineAlertService.isResolvedForWeek(clientId, weekEndDate);
    const liveWindowHours = configService.getInt(
      'threshold.payrollLiveWindowHours',
      DEFAULT_PAYROLL_LIVE_WINDOW_HOURS,
    );
    const inLiveWindow = isWithinPayrollLiveWindow({
      deadlineAt,
      scheduleKind: 'unknown',
      releaseDueAt: null,
      lastJobTime: null,
      payWeekEndYmd: weekEndDate,
      liveWindowHours,
    });
    const late = isPayrollDeadlineAttentionLate(factuallyLate, deadlineResolved, inLiveWindow);
    const lateMinutes = late ? factualLateMinutes : null;

    payrollDeadlineAlertService.sync({
      clientId,
      clientName: local?.name,
      weekEndDate,
      deadlineAt,
      pendingUnits: pendingCount,
      totalUnits: totalStores,
      lateMinutes: late ? factualLateMinutes : null,
      // Escalate only after the Live (±) window ends — same as Monitor Late.
      late: monitorOn && factuallyLate && !inLiveWindow,
    })
      .then(() => escalationService.scheduleAutoEscalationNotify())
      .catch(() => { /* alert persistence must not fail the status response */ });

    return {
      clientId,
      weekEndDate,
      frequency,
      frequencies,
      processes,
      periods,
      generators,
      // Stats always computed from unit rows; omit the payload until the UI asks for details.
      records: includeRecords ? records : [],
      summary: {
        totalStores,
        generatedCount,
        pendingCount,
        distinctFileIds: fileIds.length,
        fileIds,
        generatedAt,
        priorWeek,
      },
      adj,
      timezone,
      payrollDeadlineDaysAfterWeekEnd,
      payrollDeadlineDayOfMonth,
      payrollDeadlineLocalTime,
      payrollMonitorEnabled: local?.payrollMonitorEnabled ?? true,
      deadlineAt,
      deadlineResolved,
      late: monitorOn && late,
      lateMinutes: monitorOn ? lateMinutes : null,
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
    const liveWindowHours = configService.getInt(
      'threshold.payrollLiveWindowHours',
      DEFAULT_PAYROLL_LIVE_WINDOW_HOURS,
    );
    const clients = await this.listMonitorClients();
    logger.info(`Payroll monitor: snapshot start (${clients.length} client(s))`);

    const CONCURRENCY = 5;
    const rows: PayrollMonitorRow[] = [];
    let idx = 0;

    const worker = async () => {
      while (idx < clients.length) {
        const c = clients[idx++];
        rows.push(...await this.scanMonitorClient(c, stalledGraceMins, liveWindowHours));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, clients.length || 1) }, () => worker()));
    rows.sort((a, b) =>
      phaseRank(a.phase) - phaseRank(b.phase)
      || stalledRank(a.stalled) - stalledRank(b.stalled)
      || lateRank(a.late) - lateRank(b.late)
      || compareMonitorReleaseOrder(a.generator, b.generator)
      || a.clientId.localeCompare(b.clientId)
      || a.distListId.localeCompare(b.distListId),
    );

    const executionTimeMs = Date.now() - startMs;
    const liveCount = rows.filter(r => r.phase === 'live').length;
    const upcomingCount = rows.filter(r => r.phase === 'upcoming').length;
    const completeCount = rows.filter(r => r.phase === 'complete').length;
    const stalledCount = rows.filter(r => r.stalled).length;
    const lateCount = rows.filter(r => r.late).length;
    logger.info(
      `Payroll monitor: snapshot done → ${rows.length} row(s) `
      + `live=${liveCount} upcoming=${upcomingCount} complete=${completeCount} `
      + `stalled=${stalledCount} late=${lateCount} in ${executionTimeMs}ms`,
    );

    return {
      fetchedAt: new Date().toISOString(),
      liveCount,
      upcomingCount,
      completeCount,
      stalledCount,
      lateCount,
      stalledGraceMins,
      rows,
      executionTimeMs,
    };
  }

  /** Fast SQLite list of payroll-enabled clients for progressive monitor loading. */
  async listMonitorClients(): Promise<Array<{
    clientId: string;
    name: string;
    timezone: string;
    payrollCycle: string;
    payrollFileGen: string;
    payrollDeadlineDaysAfterWeekEnd: number | null;
    payrollDeadlineDayOfMonth: number | null;
    payrollDeadlineLocalTime: string | null;
  }>> {
    return prisma.client.findMany({
      where: {
        payrollEnabled: true,
        payrollMonitorEnabled: true,
        isActive: true,
        db2Host: { not: null },
      },
      select: {
        clientId: true,
        name: true,
        timezone: true,
        payrollCycle: true,
        payrollFileGen: true,
        payrollDeadlineDaysAfterWeekEnd: true,
        payrollDeadlineDayOfMonth: true,
        payrollDeadlineLocalTime: true,
      },
      orderBy: { clientId: 'asc' },
    });
  }

  /** Scan one client for progressive monitor loading (one or more store-group rows). */
  async getMonitorClientScan(clientId: string): Promise<{
    clientId: string;
    rows: PayrollMonitorRow[];
    stalledGraceMins: number;
    lateCount: number;
    executionTimeMs: number;
  }> {
    const startMs = Date.now();
    logger.info(`Payroll monitor: scan start ${clientId}`);
    const stalledGraceMins = configService.getInt('threshold.payrollStalledGraceMins', 30);
    const liveWindowHours = configService.getInt(
      'threshold.payrollLiveWindowHours',
      DEFAULT_PAYROLL_LIVE_WINDOW_HOURS,
    );
    const local = await prisma.client.findFirst({
      where: {
        clientId,
        payrollEnabled: true,
        payrollMonitorEnabled: true,
        isActive: true,
        db2Host: { not: null },
      },
      select: {
        clientId: true,
        name: true,
        timezone: true,
        payrollCycle: true,
        payrollFileGen: true,
        payrollDeadlineDaysAfterWeekEnd: true,
        payrollDeadlineDayOfMonth: true,
        payrollDeadlineLocalTime: true,
      },
    });
    if (!local) {
      throw new Error(`Payroll monitor client not found: ${clientId}`);
    }
    const rows = await this.scanMonitorClient(local, stalledGraceMins, liveWindowHours);
    this.publishDeadlineAlert(local.clientId, local.name, rows);
    const lateCount = rows.filter(r => r.late).length;
    const executionTimeMs = Date.now() - startMs;
    logger.info(
      `Payroll monitor: scan ${local.clientId} → ${rows.length} row(s) late=${lateCount} in ${executionTimeMs}ms`,
    );
    return {
      clientId: local.clientId,
      rows,
      stalledGraceMins,
      lateCount,
      executionTimeMs,
    };
  }

  /** Re-check every client that has an SLA deadline and refresh Escalated alerts. */
  async refreshDeadlineAlerts(): Promise<{ checked: number; errors: string[] }> {
    const clients = await prisma.client.findMany({
      where: {
        payrollEnabled: true,
        payrollMonitorEnabled: true,
        isActive: true,
        db2Host: { not: null },
        payrollDeadlineLocalTime: { not: null },
        OR: [
          { payrollDeadlineDaysAfterWeekEnd: { not: null } },
          { payrollDeadlineDayOfMonth: { not: null } },
        ],
      },
      select: { clientId: true },
      orderBy: { clientId: 'asc' },
    });
    logger.info(`Payroll monitor: deadline refresh start (${clients.length} client(s))`);
    const errors: string[] = [];
    const CONCURRENCY = 3;
    let idx = 0;
    const worker = async () => {
      while (idx < clients.length) {
        const c = clients[idx++];
        try {
          await this.getMonitorClientScan(c.clientId);
        } catch (err: any) {
          errors.push(`${c.clientId}: ${err.message || 'scan failed'}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, clients.length || 1) }, () => worker()));
    escalationService.scheduleAutoEscalationNotify(2000);
    logger.info(
      `Payroll monitor: deadline refresh done → checked=${clients.length} errors=${errors.length}`,
    );
    return { checked: clients.length, errors };
  }

  private publishDeadlineAlert(clientId: string, clientName: string, rows: PayrollMonitorRow[]): void {
    // Escalate when past SLA and outside the Live (±) window (ignore deadlineResolved here;
    // sync keeps a manual resolve closed for the week).
    const factual = rows.map(r => {
      const { late, lateMinutes } = evaluatePayrollDeadlineLate({
        deadlineAt: r.deadlineAt,
        pendingUnits: r.units?.pending || 0,
      });
      const inLiveWindow = isWithinPayrollLiveWindow({
        deadlineAt: r.deadlineAt,
        scheduleKind: r.generator.scheduleKind,
        releaseDueAt: r.generator.releaseDueAt,
        lastJobTime: r.generator.lastJobTime,
        payWeekEndYmd: r.weekEndDate,
      });
      return { row: r, late: late && !inLiveWindow, lateMinutes: late && !inLiveWindow ? lateMinutes : null };
    });
    const lateRows = factual.filter(f => f.late);
    const pendingUnits = lateRows.reduce((n, f) => n + (f.row.units?.pending || 0), 0);
    const totalUnits = rows.reduce((n, r) => n + (r.units?.total || 0), 0);
    const sample = lateRows[0]?.row || rows.find(r => r.deadlineAt) || rows[0];
    const lateMinutes = lateRows.reduce<number | null>((max, f) => {
      if (f.lateMinutes == null) return max;
      return max == null ? f.lateMinutes : Math.max(max, f.lateMinutes);
    }, null);
    payrollDeadlineAlertService.sync({
      clientId,
      clientName,
      weekEndDate: sample?.weekEndDate || '',
      deadlineAt: sample?.deadlineAt || null,
      pendingUnits,
      totalUnits,
      lateMinutes,
      late: lateRows.length > 0 && pendingUnits > 0,
    })
      .then(() => escalationService.scheduleAutoEscalationNotify())
      .catch(() => { /* ignore */ });
  }

  async getMonitorDetail(clientId: string, distListId: string): Promise<PayrollMonitorDetail> {
    const startMs = Date.now();
    const safeDistListId = sanitizeDistListId(distListId);
    if (!safeDistListId) {
      throw new Error(`Invalid store group DIST_LIST_ID: ${distListId}`);
    }
    logger.info(`Payroll monitor: detail start ${clientId} distListId=${safeDistListId}`);

    const local = await prisma.client.findUnique({
      where: { clientId },
      select: {
        timezone: true,
        payrollMonitorEnabled: true,
        payrollDeadlineDaysAfterWeekEnd: true,
        payrollDeadlineDayOfMonth: true,
        payrollDeadlineLocalTime: true,
      },
    });
    if (local && local.payrollMonitorEnabled === false) {
      throw new Error(`Payroll monitor is disabled for ${clientId}`);
    }
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
    const byStatus = countFileStatuses(records.map(r => r.fileStatus));
    const priorWeek = await this.fetchPriorWeekCompare(clientId, periods, weekEndDate, safeDistListId);
    const units = unitsAgainstPriorBaseline(generated, records.length, priorWeek, byStatus);
    const stalledGraceMins = configService.getInt('threshold.payrollStalledGraceMins', 30);
    const liveWindowHours = configService.getInt(
      'threshold.payrollLiveWindowHours',
      DEFAULT_PAYROLL_LIVE_WINDOW_HOURS,
    );
    const { stalled, stalledMinutes } = evaluateRowStalled(generator, weekEndDate, units, stalledGraceMins);
    const { deadlineAt, late: factuallyLate, lateMinutes: factualLateMinutes } = evaluateRowDeadline(
      weekEndDate,
      timezone,
      local?.payrollDeadlineDaysAfterWeekEnd,
      local?.payrollDeadlineDayOfMonth,
      local?.payrollDeadlineLocalTime,
      units.pending,
    );
    const deadlineResolved = await payrollDeadlineAlertService.isResolvedForWeek(clientId, weekEndDate);
    const inLiveWindow = isWithinPayrollLiveWindow({
      deadlineAt,
      scheduleKind: generator.scheduleKind,
      releaseDueAt: generator.releaseDueAt,
      lastJobTime: generator.lastJobTime,
      payWeekEndYmd: weekEndDate,
      liveWindowHours,
    });
    const late = isPayrollDeadlineAttentionLate(factuallyLate, deadlineResolved, inLiveWindow);
    const lateMinutes = late ? factualLateMinutes : null;
    const phase = classifyMonitorPhase({
      scheduleKind: generator.scheduleKind,
      releaseDueAt: generator.releaseDueAt,
      lastJobTime: generator.lastJobTime,
      payWeekEndYmd: weekEndDate,
      running: generator.running,
      jobsPending: generator.jobsPending,
      units,
      deadlineAt,
      deadlineResolved,
      liveWindowHours,
    });

    const executionTimeMs = Date.now() - startMs;
    logger.info(
      `Payroll monitor: detail ${clientId}/${safeDistListId} → phase=${phase} `
      + `units=${units.generated}/${units.total} late=${late} in ${executionTimeMs}ms`,
    );

    return {
      rowKey: monitorRowKey(clientId, safeDistListId),
      clientId,
      timezone,
      weekStartDate,
      weekEndDate,
      distListId: safeDistListId,
      distListName: generator.distListName,
      generator,
      units,
      priorWeek,
      phase,
      stalled,
      stalledMinutes,
      deadlineAt,
      deadlineResolved,
      late,
      lateMinutes,
      records,
      executionTimeMs,
    };
  }

  private async scanMonitorClient(c: {
    clientId: string;
    name: string;
    timezone: string;
    payrollCycle: string;
    payrollFileGen: string;
    payrollDeadlineDaysAfterWeekEnd?: number | null;
    payrollDeadlineDayOfMonth?: number | null;
    payrollDeadlineLocalTime?: string | null;
  }, stalledGraceMins: number, liveWindowHours: number): Promise<PayrollMonitorRow[]> {
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
      const deadlineResolved = await payrollDeadlineAlertService.isResolvedForWeek(c.clientId, weekEndDate);

      if (!generators.length) {
        return [{
          ...baseRow,
          rowKey: monitorRowKey(c.clientId, 'none'),
          distListId: '',
          distListName: null,
          generator: this.emptyMonitorGenerator('', c.timezone, weekEndDate),
          units: EMPTY_UNITS,
          priorWeek: null,
          phase: 'unknown',
          stalled: false,
          stalledMinutes: null,
          deadlineAt: resolvePayrollDeadlineAtIso({
            payWeekEndYmd: weekEndDate,
            daysAfterWeekEnd: c.payrollDeadlineDaysAfterWeekEnd,
            dayOfMonth: c.payrollDeadlineDayOfMonth,
            localTime: c.payrollDeadlineLocalTime,
            tz: c.timezone,
          }),
          deadlineResolved,
          late: false,
          lateMinutes: null,
          error: 'No running regular pay generator in RFX_QUEUE (RTAPayrollFeedGeneratorJob / RTANewPayFileGeneratorJob / RTA_PAYROLL_FILE_GEN)',
        }];
      }

      const rows: PayrollMonitorRow[] = [];
      for (const generator of generators) {
        try {
          const [currentUnits, priorWeek] = weekEndDate
            ? await Promise.all([
              this.fetchScopedUnitCounts(c.clientId, weekEndDate, generator.distListId),
              this.fetchPriorWeekCompare(c.clientId, periods, weekEndDate, generator.distListId),
            ])
            : [EMPTY_UNITS, null];
          const units = unitsAgainstPriorBaseline(
            currentUnits.generated,
            currentUnits.total,
            priorWeek,
            currentUnits.byStatus,
          );
          const { stalled, stalledMinutes } = evaluateRowStalled(
            generator, weekEndDate, units, stalledGraceMins,
          );
          const { deadlineAt, late: factuallyLate, lateMinutes: factualLateMinutes } = evaluateRowDeadline(
            weekEndDate,
            c.timezone,
            c.payrollDeadlineDaysAfterWeekEnd,
            c.payrollDeadlineDayOfMonth,
            c.payrollDeadlineLocalTime,
            units.pending,
          );
          const inLiveWindow = isWithinPayrollLiveWindow({
            deadlineAt,
            scheduleKind: generator.scheduleKind,
            releaseDueAt: generator.releaseDueAt,
            lastJobTime: generator.lastJobTime,
            payWeekEndYmd: weekEndDate,
            liveWindowHours,
          });
          const late = isPayrollDeadlineAttentionLate(factuallyLate, deadlineResolved, inLiveWindow);
          const lateMinutes = late ? factualLateMinutes : null;
          rows.push({
            ...baseRow,
            rowKey: monitorRowKey(c.clientId, generator.distListId),
            weekStartDate,
            weekEndDate,
            distListId: generator.distListId,
            distListName: generator.distListName,
            generator,
            units,
            priorWeek,
            phase: classifyMonitorPhase({
              scheduleKind: generator.scheduleKind,
              releaseDueAt: generator.releaseDueAt,
              lastJobTime: generator.lastJobTime,
              payWeekEndYmd: weekEndDate,
              running: generator.running,
              jobsPending: generator.jobsPending,
              units,
              deadlineAt,
              deadlineResolved,
              liveWindowHours,
            }),
            stalled,
            stalledMinutes,
            deadlineAt,
            deadlineResolved,
            late,
            lateMinutes,
          });
        } catch (err: any) {
          rows.push({
            ...baseRow,
            rowKey: monitorRowKey(c.clientId, generator.distListId),
            weekStartDate,
            weekEndDate,
            distListId: generator.distListId,
            distListName: generator.distListName,
            generator,
            units: EMPTY_UNITS,
            priorWeek: null,
            phase: 'unknown',
            stalled: false,
            stalledMinutes: null,
            deadlineAt: null,
            deadlineResolved,
            late: false,
            lateMinutes: null,
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
        distListName: null,
        generator: this.emptyMonitorGenerator('', c.timezone, ''),
        units: EMPTY_UNITS,
        priorWeek: null,
        phase: 'unknown',
        stalled: false,
        stalledMinutes: null,
        deadlineAt: null,
        deadlineResolved: false,
        late: false,
        lateMinutes: null,
        error: err.message || 'Monitor scan failed',
      }];
    }
  }

  private emptyMonitorGenerator(jobType: string, timezone: string, payWeekEndYmd: string): PayMonitorGenerator {
    return {
      queueId: '',
      jobType,
      distListId: '',
      distListName: null,
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

    const distListId = sanitizeDistListId(cell(row, 'DIST_LIST_ID')) || CLIENT_WIDE_DIST_LIST_ID;
    const distListName = isClientWideDistList(distListId)
      ? null
      : (cell(row, 'DIST_LIST_NAME') || null);

    const execCronRaw = cell(row, 'EXEC_CRON') || null;
    const schedule = resolveQueueSchedule(execCronRaw, cell(row, 'QUEUE_SLEEP') || null);
    const kind = scheduleKind(schedule);

    return {
      queueId: cell(row, 'QUEUE_ID'),
      jobType,
      distListId,
      distListName,
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

  /**
   * Prefer one regular pay generator family per client (either-or):
   * RTAPayrollFeedGeneratorJob → RTANewPayFileGeneratorJob → RTA_PAYROLL_FILE_GEN.
   * Only QUEUE_STATUS = 'R' (running) jobs are considered — paused rows are ignored.
   * Store-group (PARAM_3) rows stay one-per-group; client-wide jobs use distListId ALL.
   */
  private async fetchPayGenerators(
    clientId: string,
    timezone: string,
    payWeekEndYmd: string,
  ): Promise<PayMonitorGenerator[]> {
    const sql =
      `SELECT q.QUEUE_ID, q.JOB_TYPE, q.EXEC_CRON, q.QUEUE_SLEEP, ` +
      `q.LAST_JOB_TIME, q.JOBS_PENDING, q.QUEUE_STATUS, s.PARAM_3 AS DIST_LIST_ID, ` +
      `d.NAME AS DIST_LIST_NAME ` +
      `FROM RWSUSER.RFX_QUEUE q ` +
      `LEFT JOIN RWSUSER.STD_QUEUE_JOB s ON s.QUEUE_ID = q.QUEUE_ID ` +
      `LEFT JOIN RWSUSER.RWS_DIST_LIST d ` +
      `ON TRIM(CAST(d.DIST_LIST_ID AS VARCHAR(32))) = TRIM(CAST(s.PARAM_3 AS VARCHAR(32))) ` +
      `WHERE q.QUEUE_STATUS = 'R'`;

    const result = await db2DirectService.queryClient(clientId, sql, 'Payroll/MonitorQueue');
    if (!result.success || !result.rows) return [];

    const mapped: PayMonitorGenerator[] = [];
    for (const row of result.rows) {
      const gen = this.mapPayGeneratorRow(row, timezone, payWeekEndYmd);
      if (gen) mapped.push(gen);
    }
    if (!mapped.length) return [];

    const bestRank = Math.min(...mapped.map(g => regularPayJobRank(g.jobType)));
    const preferred = mapped.filter(g => regularPayJobRank(g.jobType) === bestRank);

    const withStoreGroup = preferred.filter(g => !isClientWideDistList(g.distListId));
    if (withStoreGroup.length) {
      const byDistList = new Map<string, PayMonitorGenerator>();
      for (const gen of withStoreGroup) {
        const existing = byDistList.get(gen.distListId);
        if (!existing || this.isBetterMonitorGenerator(gen, existing)) {
          byDistList.set(gen.distListId, gen);
        }
      }
      return [...byDistList.values()].sort((a, b) => a.distListId.localeCompare(b.distListId));
    }

    let best = preferred[0];
    for (let i = 1; i < preferred.length; i++) {
      if (this.isBetterMonitorGenerator(preferred[i], best)) best = preferred[i];
    }
    return [{ ...best, distListId: CLIENT_WIDE_DIST_LIST_ID, distListName: null }];
  }

  /** Prefer higher JOBS_PENDING when both candidates are already running. */
  private isBetterMonitorGenerator(candidate: PayMonitorGenerator, existing: PayMonitorGenerator): boolean {
    return candidate.jobsPending > existing.jobsPending;
  }

  private async fetchPriorWeekCompare(
    clientId: string,
    periods: Array<{ weekEndDate: string }>,
    weekEndDate: string,
    distListId: string,
    mapQueryWeekEnd?: (periodEnd: string) => string,
  ): Promise<PriorWeekGeneratedCompare | null> {
    const priorWeekEnd = priorPayWeekEnd(periods, weekEndDate);
    if (!priorWeekEnd) return null;
    const queryPriorWeekEnd = mapQueryWeekEnd
      ? mapQueryWeekEnd(priorWeekEnd)
      : priorWeekEnd;
    if (!queryPriorWeekEnd) return null;
    try {
      const counts = await this.fetchScopedUnitCounts(clientId, queryPriorWeekEnd, distListId);
      return {
        weekEndDate: priorWeekEnd,
        total: counts.total,
        generated: counts.generated,
      };
    } catch {
      // Prior-week baseline is informational; do not fail the primary week response.
      return null;
    }
  }

  private async fetchScopedUnitCounts(
    clientId: string,
    weekEndDate: string,
    distListId: string,
  ): Promise<PayrollUnitCounts> {
    const scope = isClientWideDistList(distListId)
      ? ''
      : ` AND ${storeMapUnitScopeSql(distListId, weekEndDate, 'u.UNIT_ID')}`;
    const statusExpr = `UPPER(TRIM(COALESCE(u.FILE_STATUS, '')))`;
    const sql =
      `SELECT COUNT(*) AS TOTAL_CNT, ` +
      `SUM(CASE WHEN ${statusExpr} = 'F' THEN 1 ELSE 0 END) AS F_CNT, ` +
      `SUM(CASE WHEN ${statusExpr} = 'D' THEN 1 ELSE 0 END) AS D_CNT, ` +
      `SUM(CASE WHEN ${statusExpr} = 'Q' THEN 1 ELSE 0 END) AS Q_CNT, ` +
      `SUM(CASE WHEN ${statusExpr} NOT IN ('F', 'D', 'Q') THEN 1 ELSE 0 END) AS BLANK_CNT ` +
      `FROM RWSUSER.TA_UNIT_PAY_STATUS u ` +
      `WHERE ${weekEndEqualsSql('u.WEEK_END_DATE', weekEndDate)}${scope}`;
    const result = await db2DirectService.queryClient(clientId, sql, 'Payroll/MonitorCounts');
    if (!result.success || !result.rows || !result.rows[0]) {
      throw new Error(result.error || `Failed to query scoped unit counts for ${clientId}`);
    }
    const row = result.rows[0];
    const total = parseCount(row, 'TOTAL_CNT');
    const byStatus: PayrollFileStatusCounts = {
      F: parseCount(row, 'F_CNT'),
      D: parseCount(row, 'D_CNT'),
      Q: parseCount(row, 'Q_CNT'),
      blank: parseCount(row, 'BLANK_CNT'),
    };
    const generated = byStatus.F;
    return {
      total,
      generated,
      pending: Math.max(0, total - generated),
      byStatus,
    };
  }

  private async fetchScopedUnitPayStatus(
    clientId: string,
    weekEndDate: string,
    distListId: string,
  ): Promise<PayrollRecord[]> {
    const scope = isClientWideDistList(distListId)
      ? ''
      : ` AND ${storeMapUnitScopeSql(distListId, weekEndDate, 'u.UNIT_ID')}`;
    const sql =
      `SELECT ${UNIT_STATUS_COLUMNS} FROM RWSUSER.TA_UNIT_PAY_STATUS u ` +
      `LEFT JOIN RWSUSER.TA_PAY_FILE f ON f.FILE_ID = u.FILE_ID ` +
      `WHERE ${weekEndEqualsSql('u.WEEK_END_DATE', weekEndDate)}${scope} ` +
      `ORDER BY u.UNIT_ID`;

    const fallbackSql =
      `SELECT UNIT_ID, WEEK_START_DATE, WEEK_END_DATE, FILE_STATUS, FILE_ID ` +
      `FROM RWSUSER.TA_UNIT_PAY_STATUS u ` +
      `WHERE ${weekEndEqualsSql('u.WEEK_END_DATE', weekEndDate)}${scope} ` +
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
