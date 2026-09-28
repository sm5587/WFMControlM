import { parseWipWeekRow, wipWeeklyCountsSql } from '../../src/constants/wip';

describe('wipWeeklyCountsSql', () => {
  it('queries RWS_GEN_SHIFT by active EFF_DATE/END_DATE for iteration types 6 and 7', () => {
    const sql = wipWeeklyCountsSql();
    expect(sql).toContain('RWSUSER.RWS_GEN_SHIFT');
    expect(sql).not.toContain('RWS_CALENDAR');
    expect(sql).toContain('g.EFF_DATE <= CURRENT DATE');
    expect(sql).toContain('g.END_DATE >= CURRENT DATE');
    expect(sql).toContain('CURRENT DATE - 7 DAYS');
    expect(sql).toContain('ITERATION_TYPE IN (6, 7)');
    expect(sql).toContain('ITER6_STORES');
    expect(sql).toContain('ITER7_STORES');
    expect(sql).toContain('UNION ALL');
  });
});

describe('parseWipWeekRow', () => {
  it('marks mismatch when store counts differ', () => {
    const week = parseWipWeekRow({
      WEEK_START_DATE: '20260322',
      WEEK_END_DATE: '20260328',
      ITER6_STORES: '100',
      ITER7_STORES: '98',
    });
    expect(week).toEqual({
      fiscalYear: 0,
      fiscalWeek: 0,
      weekInd: 0,
      weekStartDate: '20260322',
      weekEndDate: '20260328',
      iter6Stores: 100,
      iter7Stores: 98,
      mismatch: true,
      delta: -2,
    });
  });

  it('marks match when counts are equal', () => {
    const week = parseWipWeekRow({
      WEEK_START_DATE: '20260104',
      WEEK_END_DATE: '20260110',
      ITER6_STORES: '4190',
      ITER7_STORES: '4190',
    });
    expect(week?.mismatch).toBe(false);
    expect(week?.delta).toBe(0);
  });

  it('returns null when week dates are missing', () => {
    expect(parseWipWeekRow({ ITER6_STORES: '1', ITER7_STORES: '1' })).toBeNull();
  });
});
