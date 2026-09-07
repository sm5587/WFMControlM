import {
  computeDurationMins,
  derivePunchActivities,
  deriveQueueSeverity,
  isDateInRange,
  parseMonthPeriod,
} from '../../src/utils/escalation-report';

describe('escalation-report', () => {
  describe('parseMonthPeriod', () => {
    it('returns correct range for August 2026', () => {
      const p = parseMonthPeriod(2026, 8);
      expect(p.label).toBe('August 2026');
      expect(p.startDate).toBe('2026-08-01');
      expect(p.endDate).toBe('2026-08-31');
      expect(p.start.getMonth()).toBe(7);
      expect(p.end.getDate()).toBe(31);
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
});
