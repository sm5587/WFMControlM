import {
  calendarPeriodsSql,
  classifyMonitorPhase,
  defaultPayWeekEnd,
  jobTimeOnOrAfterPayWeekEnd,
  matchPayJob,
  compareMonitorReleaseOrder,
  evaluateStalledGeneration,
  monitorRowKey,
  normalizeFrequency,
  normalizeQuartzCron,
  parseFrequencies,
  payJobKind,
  resolveQueueSchedule,
  rfxCompactDateTime,
  sanitizeWeekEnd,
  scheduleKind,
  serializeFrequencies,
  storeMapUnitScopeSql,
  toYyyymmdd,
  weekEndEqualsSql,
} from '../../src/constants/payroll';

describe('payroll constants', () => {
  it('normalizes frequency codes and legacy cycle names', () => {
    expect(normalizeFrequency('wk')).toBe('WK');
    expect(normalizeFrequency('weekly')).toBe('WK');
    expect(normalizeFrequency('bi-weekly')).toBe('BW');
    expect(normalizeFrequency('SM')).toBe('SM');
    expect(normalizeFrequency('monthly')).toBe('GM');
    expect(normalizeFrequency(null)).toBe('');
  });

  it('keeps weekly and bi-weekly as separate frequencies', () => {
    expect(parseFrequencies('WK,BW')).toEqual(['WK', 'BW']);
    expect(parseFrequencies('weekly,bi-weekly,SM')).toEqual(['WK', 'BW', 'SM']);
    expect(serializeFrequencies(['BW', 'WK', 'GM'])).toBe('WK,BW,GM');
  });

  it('classifies RFX_QUEUE pay generator job names', () => {
    expect(payJobKind('RTANewPayFileGeneratorJob')).toBe('regular');
    expect(payJobKind('RTA_PAYROLL_FILE_GEN')).toBe('regular');
    expect(payJobKind('com.rws.RTAPayrollFeedGeneratorJob')).toBe('regular');
    expect(payJobKind('RTAPriorAdjPayGeneratorJob')).toBe('adjustment');
    expect(payJobKind('SomeOtherJob')).toBeNull();
  });

  it('matches generator job names inside JOB_TYPE or class paths', () => {
    expect(matchPayJob('RTANewPayFileGeneratorJob', 'RTANewPayFileGeneratorJob')).toBe(true);
    expect(matchPayJob('com.rws.RTAPriorAdjPayGeneratorJob', 'RTAPriorAdjPayGeneratorJob')).toBe(true);
    expect(matchPayJob('RTAPayrollFeedGeneratorJob', 'RTANewPayFileGeneratorJob')).toBe(false);
  });

  it('normalizes DB2 timestamps and ISO dates to yyyyMMdd', () => {
    expect(toYyyymmdd('20240204')).toBe('20240204');
    expect(toYyyymmdd('2024-02-04')).toBe('20240204');
    expect(toYyyymmdd('2024-02-04-00.00.00.000000')).toBe('20240204');
    expect(toYyyymmdd('2024-02-04 00:00:00.0')).toBe('20240204');
    expect(sanitizeWeekEnd('2024-02-04-00.00.00.000000')).toBe('20240204');
    expect(sanitizeWeekEnd('')).toBeNull();
  });

  it('builds calendar SQL for DATE/TIMESTAMP columns, not CHAR to_date', () => {
    const sql = calendarPeriodsSql();
    expect(sql).toContain("VARCHAR_FORMAT(WEEK_START_DATE, 'yyyyMMdd')");
    expect(sql).toContain('YEAR_NO = YEAR(CURRENT DATE)');
    expect(sql).toContain('SELECT DISTINCT');
    expect(sql).not.toMatch(/to_date\s*\(\s*WEEK_START_DATE/i);
    expect(sql).not.toContain('INTEGER(YEAR)');
  });

  it('defaults the pay week to the completed week before current', () => {
    const periods = [
      { weekEndDate: '20260830', isCurrent: false },
      { weekEndDate: '20260906', isCurrent: false },
      { weekEndDate: '20260913', isCurrent: true },
    ];
    expect(defaultPayWeekEnd(periods)).toBe('20260906');
    expect(defaultPayWeekEnd([{ weekEndDate: '20260913', isCurrent: true }])).toBe('20260913');
  });

  it('converts WFM compact BIGINT creation times to a timestamp string', () => {
    expect(rfxCompactDateTime('20260906190120')).toBe('2026-09-06 19:01:20');
    expect(rfxCompactDateTime('0')).toBe('');
  });

  it('builds a typed week-end predicate from yyyyMMdd', () => {
    expect(weekEndEqualsSql('WEEK_END_DATE', '20240204')).toBe(
      'INTEGER(WEEK_END_DATE) = 20240204',
    );
    expect(() => weekEndEqualsSql('WEEK_END_DATE', 'nope')).toThrow();
  });

  it('resolves queue schedule from EXEC_CRON or QUEUE_SLEEP', () => {
    expect(resolveQueueSchedule('0 30 20 * * ?', '120')).toBe('0 30 20 * * ?');
    expect(resolveQueueSchedule('', '600')).toBe('600');
    expect(scheduleKind('120')).toBe('interval');
    expect(scheduleKind('0 30 20 * * ?')).toBe('cron');
  });

  it('normalizes Quartz cron with optional year field', () => {
    expect(normalizeQuartzCron('0 00 11 ? * MON *')).toBe('0 00 11 ? * MON');
    expect(normalizeQuartzCron('0 30 20 * * ?')).toBe('0 30 20 * * ?');
  });

  it('builds store-group scoped unit SQL', () => {
    const sql = storeMapUnitScopeSql('42', '20260906', 'u.UNIT_ID');
    expect(sql).toContain('RWS_DIST_STORE_MAP');
    expect(sql).toContain('INTEGER(m.DIST_LIST_ID) = 42');
    expect(sql).toContain('INTEGER(m.EFF_DATESKEY) <= 20260906');
    expect(sql).toContain('INTEGER(m.END_DATESKEY) >= 20260906');
    expect(sql).toContain('u.UNIT_ID');
  });

  it('classifies monitor phase from release schedule and unit progress', () => {
    const unitsPending = { total: 10, generated: 3, pending: 7 };
    const unitsDone = { total: 10, generated: 10, pending: 0 };
    expect(classifyMonitorPhase({
      scheduleKind: 'cron',
      releaseDueAt: '2099-01-01T11:00:00.000Z',
      lastJobTime: null,
      payWeekEndYmd: '20260906',
      running: false,
      jobsPending: 0,
      units: unitsPending,
      now: new Date('2026-09-10T10:00:00.000Z'),
    })).toBe('upcoming');
    expect(classifyMonitorPhase({
      scheduleKind: 'cron',
      releaseDueAt: '2026-09-08T11:00:00.000Z',
      lastJobTime: null,
      payWeekEndYmd: '20260906',
      running: true,
      jobsPending: 2,
      units: unitsPending,
      now: new Date('2026-09-10T10:00:00.000Z'),
    })).toBe('live');
    expect(classifyMonitorPhase({
      scheduleKind: 'cron',
      releaseDueAt: '2026-09-08T11:00:00.000Z',
      lastJobTime: null,
      payWeekEndYmd: '20260906',
      running: false,
      jobsPending: 0,
      units: unitsDone,
      now: new Date('2026-09-10T10:00:00.000Z'),
    })).toBe('complete');
  });

  it('detects last job time on or after pay week end', () => {
    expect(jobTimeOnOrAfterPayWeekEnd('2026-09-07 11:00:00.0', '20260906')).toBe(true);
    expect(jobTimeOnOrAfterPayWeekEnd('2026-09-05 11:00:00.0', '20260906')).toBe(false);
  });

  it('builds stable monitor row keys', () => {
    expect(monitorRowKey('BOBS', '123')).toBe('BOBS:123');
  });

  it('flags stalled generation after release grace period', () => {
    const base = {
      scheduleKind: 'cron' as const,
      releaseDueAt: '2026-09-08T11:00:00.000Z',
      lastJobTime: '2026-09-08 11:05:00.0',
      payWeekEndYmd: '20260906',
      running: false,
      units: { pending: 5 },
      graceMins: 30,
    };
    expect(evaluateStalledGeneration({
      ...base,
      now: new Date('2026-09-08T11:20:00.000Z'),
    })).toEqual({ stalled: false, stalledMinutes: null });
    expect(evaluateStalledGeneration({
      ...base,
      now: new Date('2026-09-08T12:00:00.000Z'),
    })).toEqual({ stalled: true, stalledMinutes: 55 });
    expect(evaluateStalledGeneration({
      ...base,
      running: true,
      now: new Date('2026-09-08T13:00:00.000Z'),
    })).toEqual({ stalled: false, stalledMinutes: null });
  });

  it('sorts monitor rows by release due then last job time', () => {
    const early = { releaseDueAt: '2026-09-08T11:00:00.000Z', lastJobTime: null };
    const later = { releaseDueAt: '2026-09-08T15:00:00.000Z', lastJobTime: null };
    const fallback = { releaseDueAt: null, lastJobTime: '2026-09-08 12:00:00.0' };
    expect(compareMonitorReleaseOrder(early, later)).toBeLessThan(0);
    expect(compareMonitorReleaseOrder(later, early)).toBeGreaterThan(0);
    expect(compareMonitorReleaseOrder(early, fallback)).toBeLessThan(0);
  });
});
