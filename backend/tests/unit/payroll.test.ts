import {
  calendarPeriodsSql,
  classifyMonitorPhase,
  computePayrollDeadlineAtIso,
  computePayrollDeadlineAtIsoFromDayOfMonth,
  defaultPayWeekEnd,
  evaluatePayrollDeadlineLate,
  isClientWideDistList,
  isPayrollDeadlineAttentionLate,
  jobTimeOnOrAfterPayWeekEnd,
  matchPayJob,
  compareMonitorReleaseOrder,
  evaluateStalledGeneration,
  monitorRowKey,
  normalizeFrequency,
  normalizeQuartzCron,
  parseFrequencies,
  parsePayrollDeadlineLocalTime,
  payrollDeadlinePickerKind,
  payJobKind,
  calendarWeekEndOnOrBefore,
  frequencyUsesCalendarWeekEndQuery,
  periodsForFrequency,
  priorPayWeekEnd,
  regularPayJobRank,
  resolvePayrollDeadlineAtIso,
  resolveQueueSchedule,
  resolveWeekEndInPeriods,
  sanitizePayrollDeadlineDayOfMonth,
  sanitizePayrollDeadlineDays,
  rfxCompactDateTime,
  sanitizeDistListId,
  sanitizeWeekEnd,
  scheduleKind,
  serializeFrequencies,
  storeMapUnitScopeSql,
  toYyyymmdd,
  weekEndEqualsSql,
  countFileStatuses,
  fileStatusBucket,
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

  it('ranks either-or regular pay generators (Feed preferred over NewPay)', () => {
    expect(regularPayJobRank('RTAPayrollFeedGeneratorJob')).toBe(0);
    expect(regularPayJobRank('com.rws.RTANewPayFileGeneratorJob')).toBe(1);
    expect(regularPayJobRank('RTA_PAYROLL_FILE_GEN')).toBe(2);
    expect(regularPayJobRank('Other')).toBeGreaterThan(2);
  });

  it('treats ALL as client-wide dist list sentinel', () => {
    expect(sanitizeDistListId('ALL')).toBe('ALL');
    expect(sanitizeDistListId('all')).toBe('ALL');
    expect(isClientWideDistList('ALL')).toBe(true);
    expect(isClientWideDistList('1')).toBe(false);
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

  it('resolves the prior calendar week end for FILE_STATUS=F comparison', () => {
    const periods = [
      { weekEndDate: '20260830' },
      { weekEndDate: '20260906' },
      { weekEndDate: '20260913' },
    ];
    expect(priorPayWeekEnd(periods, '20260913')).toBe('20260906');
    expect(priorPayWeekEnd(periods, '20260906')).toBe('20260830');
    expect(priorPayWeekEnd(periods, '20260830')).toBe('');
    expect(priorPayWeekEnd(periods, 'nope')).toBe('');
  });

  it('pairs consecutive calendar weeks into 14-day bi-weekly periods', () => {
    const weekly = [
      { weekStartDate: '20260824', weekEndDate: '20260830', isCurrent: false },
      { weekStartDate: '20260831', weekEndDate: '20260906', isCurrent: false },
      { weekStartDate: '20260907', weekEndDate: '20260913', isCurrent: false },
      { weekStartDate: '20260914', weekEndDate: '20260920', isCurrent: false },
      { weekStartDate: '20260921', weekEndDate: '20260927', isCurrent: true },
    ];
    const bw = periodsForFrequency(weekly, 'BW', '20260926');
    expect(bw).toEqual([
      {
        weekStartDate: '20260824',
        weekEndDate: '20260906',
        isCurrent: false,
        isPrevious: false,
        year: '2026',
      },
      {
        weekStartDate: '20260907',
        weekEndDate: '20260920',
        isCurrent: false,
        isPrevious: false,
        year: '2026',
      },
      {
        weekStartDate: '20260921',
        weekEndDate: '20260927',
        isCurrent: true,
        isPrevious: false,
      },
    ]);
    expect(defaultPayWeekEnd(bw)).toBe('20260920');
    expect(priorPayWeekEnd(bw, '20260920')).toBe('20260906');
    expect(periodsForFrequency(weekly, 'WK')).toBe(weekly);
  });

  it('groups calendar weeks into gregorian months and semi-monthly halves', () => {
    const weekly = [
      { weekStartDate: '20260824', weekEndDate: '20260830', isCurrent: false },
      { weekStartDate: '20260831', weekEndDate: '20260906', isCurrent: false },
      { weekStartDate: '20260907', weekEndDate: '20260913', isCurrent: false },
      { weekStartDate: '20260914', weekEndDate: '20260920', isCurrent: false },
      { weekStartDate: '20260921', weekEndDate: '20260927', isCurrent: true },
    ];
    const gm = periodsForFrequency(weekly, 'GM', '20260926');
    expect(gm).toEqual([
      {
        weekStartDate: '20260801',
        weekEndDate: '20260831',
        isCurrent: false,
        isPrevious: false,
        year: '2026',
      },
      {
        weekStartDate: '20260901',
        weekEndDate: '20260930',
        isCurrent: true,
        isPrevious: false,
        year: '2026',
      },
    ]);
    expect(defaultPayWeekEnd(gm)).toBe('20260831');

    const sm = periodsForFrequency(weekly, 'SM', '20260926');
    expect(sm.map(p => `${p.weekStartDate}-${p.weekEndDate}`)).toEqual([
      '20260816-20260831',
      '20260901-20260915',
      '20260916-20260930',
    ]);
    expect(sm.find(p => p.isCurrent)?.weekEndDate).toBe('20260930');
    expect(frequencyUsesCalendarWeekEndQuery('GM')).toBe(true);
    expect(frequencyUsesCalendarWeekEndQuery('SM')).toBe(true);
    expect(frequencyUsesCalendarWeekEndQuery('BW')).toBe(false);
    expect(calendarWeekEndOnOrBefore(weekly, '20260930')).toBe('20260927');
    expect(calendarWeekEndOnOrBefore(weekly, '20260915')).toBe('20260913');
    expect(calendarWeekEndOnOrBefore(weekly, '20260927')).toBe('20260927');
  });

  it('maps a weekly week-end into the containing frequency period end', () => {
    const bw = [
      { weekStartDate: '20260907', weekEndDate: '20260920' },
      { weekStartDate: '20260921', weekEndDate: '20261004' },
    ];
    expect(resolveWeekEndInPeriods(bw, '20260920')).toBe('20260920');
    expect(resolveWeekEndInPeriods(bw, '20260913')).toBe('20260920');
    expect(resolveWeekEndInPeriods(bw, '20260830')).toBe('');

    const gm = [
      { weekStartDate: '20260901', weekEndDate: '20260930' },
    ];
    expect(resolveWeekEndInPeriods(gm, '20260920')).toBe('20260930');
  });

  it('buckets FILE_STATUS into F / D / Q / blank for monitor colors', () => {
    expect(fileStatusBucket('F')).toBe('F');
    expect(fileStatusBucket('d')).toBe('D');
    expect(fileStatusBucket(' Q ')).toBe('Q');
    expect(fileStatusBucket('')).toBe('blank');
    expect(fileStatusBucket(null)).toBe('blank');
    expect(fileStatusBucket('P')).toBe('blank');
    expect(countFileStatuses(['F', 'F', 'D', '', null, 'Q', 'G'])).toEqual({
      F: 2,
      D: 1,
      Q: 1,
      blank: 3,
    });
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

  it('classifies monitor phase from SLA deadline window and unit progress', () => {
    const unitsPending = { total: 10, generated: 3, pending: 7 };
    const unitsDone = { total: 10, generated: 10, pending: 0 };
    // Days before SLA → Upcoming (EXEC_CRON alone no longer makes Live)
    expect(classifyMonitorPhase({
      scheduleKind: 'cron',
      releaseDueAt: '2026-09-08T11:00:00.000Z',
      lastJobTime: null,
      payWeekEndYmd: '20260906',
      running: true,
      jobsPending: 2,
      units: unitsPending,
      deadlineAt: '2026-09-12T15:00:00.000Z',
      now: new Date('2026-09-10T10:00:00.000Z'),
    })).toBe('upcoming');
    // Within 12h before SLA deadline → Live
    expect(classifyMonitorPhase({
      scheduleKind: 'cron',
      releaseDueAt: '2026-09-08T11:00:00.000Z',
      lastJobTime: null,
      payWeekEndYmd: '20260906',
      running: false,
      jobsPending: 0,
      units: unitsPending,
      deadlineAt: '2026-09-10T20:00:00.000Z',
      now: new Date('2026-09-10T10:00:00.000Z'),
    })).toBe('live');
    // 2h past SLA but still inside ±12h → Live (not Late yet)
    expect(classifyMonitorPhase({
      scheduleKind: 'cron',
      releaseDueAt: '2026-09-08T11:00:00.000Z',
      lastJobTime: null,
      payWeekEndYmd: '20260906',
      running: false,
      jobsPending: 0,
      units: unitsPending,
      deadlineAt: '2026-09-10T08:00:00.000Z',
      now: new Date('2026-09-10T10:00:00.000Z'),
    })).toBe('live');
    // More than 12h past SLA → Late
    expect(classifyMonitorPhase({
      scheduleKind: 'cron',
      releaseDueAt: '2026-09-08T11:00:00.000Z',
      lastJobTime: null,
      payWeekEndYmd: '20260906',
      running: true,
      jobsPending: 2,
      units: unitsPending,
      deadlineAt: '2026-09-09T15:00:00.000Z',
      now: new Date('2026-09-10T10:00:00.000Z'),
    })).toBe('late');
    // No SLA: release due 2h ago → Live (fallback)
    expect(classifyMonitorPhase({
      scheduleKind: 'cron',
      releaseDueAt: '2026-09-10T08:00:00.000Z',
      lastJobTime: null,
      payWeekEndYmd: '20260906',
      running: false,
      jobsPending: 0,
      units: unitsPending,
      now: new Date('2026-09-10T10:00:00.000Z'),
    })).toBe('live');
    // Resolved for this pay week past window → Upcoming (not Late)
    expect(classifyMonitorPhase({
      scheduleKind: 'cron',
      releaseDueAt: '2026-09-08T11:00:00.000Z',
      lastJobTime: null,
      payWeekEndYmd: '20260906',
      running: false,
      jobsPending: 0,
      units: unitsPending,
      deadlineAt: '2026-09-09T15:00:00.000Z',
      deadlineResolved: true,
      now: new Date('2026-09-10T10:00:00.000Z'),
    })).toBe('upcoming');
    expect(classifyMonitorPhase({
      scheduleKind: 'cron',
      releaseDueAt: '2026-09-08T11:00:00.000Z',
      lastJobTime: null,
      payWeekEndYmd: '20260906',
      running: false,
      jobsPending: 0,
      units: unitsDone,
      deadlineAt: '2026-09-09T15:00:00.000Z',
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

  it('parses and sanitizes payroll SLA deadline inputs', () => {
    expect(parsePayrollDeadlineLocalTime('9:05')).toBe('09:05');
    expect(parsePayrollDeadlineLocalTime('23:59')).toBe('23:59');
    expect(parsePayrollDeadlineLocalTime('24:00')).toBeNull();
    expect(parsePayrollDeadlineLocalTime('abc')).toBeNull();
    expect(sanitizePayrollDeadlineDays(0)).toBe(0);
    expect(sanitizePayrollDeadlineDays(7)).toBe(7);
    expect(sanitizePayrollDeadlineDays(8)).toBeNull();
    expect(sanitizePayrollDeadlineDays(14, 14)).toBe(14);
    expect(sanitizePayrollDeadlineDays(15, 14)).toBeNull();
    expect(sanitizePayrollDeadlineDays(null)).toBeNull();
    expect(sanitizePayrollDeadlineDayOfMonth(1)).toBe(1);
    expect(sanitizePayrollDeadlineDayOfMonth(28)).toBe(28);
    expect(sanitizePayrollDeadlineDayOfMonth(29)).toBeNull();
    expect(sanitizePayrollDeadlineDayOfMonth(0)).toBeNull();
  });

  it('picks deadline UI shape by pay frequency', () => {
    expect(payrollDeadlinePickerKind('WK')).toBe('weekday');
    expect(payrollDeadlinePickerKind('BW')).toBe('daysAfter');
    expect(payrollDeadlinePickerKind('SM')).toBe('dayOfMonth');
    expect(payrollDeadlinePickerKind('GM')).toBe('dayOfMonth');
  });

  it('computes payroll SLA deadline from week end + days + local time', () => {
    // Week end 2026-09-06 (Sat) + 1 day at 10:00 America/Chicago (CDT, UTC-5) → 2026-09-07 15:00Z
    const iso = computePayrollDeadlineAtIso('20260906', 1, '10:00', 'America/Chicago');
    expect(iso).toBe('2026-09-07T15:00:00.000Z');
    expect(computePayrollDeadlineAtIso('20260906', null, '10:00', 'America/Chicago')).toBeNull();
    expect(computePayrollDeadlineAtIso('20260906', 1, null, 'America/Chicago')).toBeNull();
    // Bi-weekly: 10 days after week end still computes
    expect(computePayrollDeadlineAtIso('20260906', 10, '10:00', 'America/Chicago'))
      .toBe('2026-09-16T15:00:00.000Z');
  });

  it('computes SM/GM deadline from day-of-month on or after week end', () => {
    // Week end Sat 2026-09-06 → next 5th is Oct 5 at 10:00 Chicago
    expect(computePayrollDeadlineAtIsoFromDayOfMonth('20260906', 5, '10:00', 'America/Chicago'))
      .toBe('2026-10-05T15:00:00.000Z');
    // Week end Sep 15 → day 18 same month
    expect(computePayrollDeadlineAtIsoFromDayOfMonth('20260915', 18, '10:00', 'America/Chicago'))
      .toBe('2026-09-18T15:00:00.000Z');
    // Day-of-month wins over days-after when both present
    expect(resolvePayrollDeadlineAtIso({
      payWeekEndYmd: '20260906',
      daysAfterWeekEnd: 1,
      dayOfMonth: 5,
      localTime: '10:00',
      tz: 'America/Chicago',
    })).toBe('2026-10-05T15:00:00.000Z');
  });

  it('flags late when past deadline with pending units', () => {
    const deadlineAt = '2026-09-07T15:00:00.000Z';
    expect(evaluatePayrollDeadlineLate({
      deadlineAt,
      pendingUnits: 3,
      now: new Date('2026-09-07T16:00:00.000Z'),
    })).toEqual({ late: true, lateMinutes: 60 });
    expect(evaluatePayrollDeadlineLate({
      deadlineAt,
      pendingUnits: 3,
      now: new Date('2026-09-07T14:59:00.000Z'),
    })).toEqual({ late: false, lateMinutes: null });
    expect(evaluatePayrollDeadlineLate({
      deadlineAt,
      pendingUnits: 0,
      now: new Date('2026-09-07T16:00:00.000Z'),
    })).toEqual({ late: false, lateMinutes: null });
  });

  it('suppresses attention late when resolved or still inside the Live window', () => {
    expect(isPayrollDeadlineAttentionLate(true, false, false)).toBe(true);
    expect(isPayrollDeadlineAttentionLate(true, true, false)).toBe(false);
    expect(isPayrollDeadlineAttentionLate(true, false, true)).toBe(false);
    expect(isPayrollDeadlineAttentionLate(false, true, false)).toBe(false);
  });
});
