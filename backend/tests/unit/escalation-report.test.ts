import {
  alertOverlapsPeriod,
  computeDurationMins,
  derivePunchActivities,
  deriveQueueSeverity,
  isDateInRange,
  isOpenAtPeriodEnd,
  parseMonthPeriod,
  parseQuarterPeriod,
  periodContainsNow,
} from '../../src/utils/escalation-report';

describe('escalation-report', () => {
  describe('parseMonthPeriod', () => {
    it('returns correct range for August 2026', () => {
      const p = parseMonthPeriod(2026, 8);
      expect(p.label).toBe('August 2026');
      expect(p.type).toBe('monthly');
      expect(p.startDate).toBe('2026-08-01');
      expect(p.endDate).toBe('2026-08-31');
      expect(p.start.getMonth()).toBe(7);
      expect(p.end.getDate()).toBe(31);
    });
  });

  describe('parseQuarterPeriod', () => {
    it('returns Jan–Mar for Q1', () => {
      const p = parseQuarterPeriod(2026, 1);
      expect(p.label).toBe('Q1 2026');
      expect(p.type).toBe('quarterly');
      expect(p.quarter).toBe(1);
      expect(p.startDate).toBe('2026-01-01');
      expect(p.endDate).toBe('2026-03-31');
    });

    it('returns Apr–Jun for Q2', () => {
      const p = parseQuarterPeriod(2026, 2);
      expect(p.startDate).toBe('2026-04-01');
      expect(p.endDate).toBe('2026-06-30');
    });

    it('returns Oct–Dec for Q4', () => {
      const p = parseQuarterPeriod(2026, 4);
      expect(p.startDate).toBe('2026-10-01');
      expect(p.endDate).toBe('2026-12-31');
    });
  });

  describe('periodContainsNow', () => {
    it('is true for a range that includes now', () => {
      const p = parseQuarterPeriod(2026, 3);
      expect(periodContainsNow(p, new Date(2026, 7, 15))).toBe(true);
    });

    it('is false outside the range', () => {
      const p = parseQuarterPeriod(2026, 3);
      expect(periodContainsNow(p, new Date(2026, 5, 15))).toBe(false);
    });
  });

  describe('deriveQueueSeverity', () => {
    it('marks >= 10 stale pending as CRITICAL', () => {
      expect(deriveQueueSeverity(10)).toBe('CRITICAL');
      expect(deriveQueueSeverity(9)).toBe('WARNING');
    });
  });

  describe('computeDurationMins', () => {
    it('uses resolvedAt when present', () => {
      const first = new Date('2026-08-01T10:00:00Z');
      const resolved = new Date('2026-08-01T11:30:00Z');
      const last = new Date('2026-08-01T12:00:00Z');
      expect(computeDurationMins(first, resolved, last)).toBe(90);
    });

    it('falls back to lastSeenAt when unresolved', () => {
      const first = new Date('2026-08-01T10:00:00Z');
      const last = new Date('2026-08-01T10:45:00Z');
      expect(computeDurationMins(first, null, last)).toBe(45);
    });
  });

  describe('derivePunchActivities', () => {
    const start = new Date('2026-08-01T00:00:00Z');
    const end = new Date('2026-08-31T23:59:59Z');

    it('lists activities that occurred in the month', () => {
      const activities = derivePunchActivities(
        {
          createdAt: new Date('2026-08-01T08:00:00Z'),
          acknowledgedAt: new Date('2026-08-15T12:00:00Z'),
          suppressedAt: null,
          emailSentAt: new Date('2026-08-10T08:00:00Z'),
        },
        start,
        end
      );
      expect(activities).toEqual(['Tracked', 'Acknowledged', 'Notified']);
    });

    it('ignores activity outside the month', () => {
      const activities = derivePunchActivities(
        {
          acknowledgedAt: new Date('2026-07-15T12:00:00Z'),
          emailSentAt: new Date('2026-08-01T08:00:00Z'),
        },
        start,
        end
      );
      expect(activities).toEqual(['Notified']);
    });
  });

  describe('isDateInRange', () => {
    it('returns false for null', () => {
      expect(isDateInRange(null, new Date('2026-08-01'), new Date('2026-08-31'))).toBe(false);
    });
  });

  describe('alertOverlapsPeriod', () => {
    const start = new Date('2026-09-01T00:00:00Z');
    const end = new Date('2026-09-30T23:59:59Z');

    it('includes alerts that started before the period but are still open', () => {
      expect(alertOverlapsPeriod(
        new Date('2026-08-15T10:00:00Z'),
        null,
        start,
        end,
      )).toBe(true);
    });

    it('includes alerts resolved during the period', () => {
      expect(alertOverlapsPeriod(
        new Date('2026-08-20T10:00:00Z'),
        new Date('2026-09-10T12:00:00Z'),
        start,
        end,
      )).toBe(true);
    });

    it('excludes alerts fully resolved before the period', () => {
      expect(alertOverlapsPeriod(
        new Date('2026-08-01T10:00:00Z'),
        new Date('2026-08-31T12:00:00Z'),
        start,
        end,
      )).toBe(false);
    });

    it('excludes alerts that start after the period', () => {
      expect(alertOverlapsPeriod(
        new Date('2026-10-01T10:00:00Z'),
        null,
        start,
        end,
      )).toBe(false);
    });
  });

  describe('isOpenAtPeriodEnd', () => {
    it('treats unresolved alerts as open', () => {
      expect(isOpenAtPeriodEnd(null, new Date('2026-09-30T23:59:59Z'))).toBe(true);
    });

    it('treats alerts resolved after asOf as still open', () => {
      expect(isOpenAtPeriodEnd(
        new Date('2026-09-20T12:00:00Z'),
        new Date('2026-09-15T12:00:00Z'),
      )).toBe(true);
    });

    it('treats alerts resolved before asOf as closed', () => {
      expect(isOpenAtPeriodEnd(
        new Date('2026-09-10T12:00:00Z'),
        new Date('2026-09-15T12:00:00Z'),
      )).toBe(false);
    });
  });
});
