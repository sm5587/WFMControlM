import {
  filterStalePunchRows,
  isStalePunchRow,
  parseDb2Ts,
  staleAgeMins,
} from '../../src/utils/punch-stale';

describe('punch-stale', () => {
  const baseRow = {
    clientId: 'WAWA',
    punchCount: 500,
    lastUpdateTime: '2026-08-31-08.00.00.000000',
    dbCurrentTime: '2026-08-31-10.30.00.000000',
  };

  it('parseDb2Ts parses DB2 timestamps', () => {
    const d = parseDb2Ts('2026-08-31-10.30.00.000000');
    expect(d?.getUTCHours()).toBe(10);
    expect(d?.getUTCMinutes()).toBe(30);
  });

  it('detects stale punch rows above thresholds', () => {
    expect(isStalePunchRow(baseRow, 100, 60)).toBe(true);
    expect(isStalePunchRow({ ...baseRow, punchCount: 50 }, 100, 60)).toBe(false);
  });

  it('computes stale age in minutes', () => {
    expect(staleAgeMins(baseRow)).toBe(150);
  });

  it('filters and sorts stale rows', () => {
    const rows = filterStalePunchRows([
      baseRow,
      { ...baseRow, clientId: 'ACME', lastUpdateTime: '2026-08-31-09.00.00.000000' },
      { ...baseRow, clientId: 'LOW', punchCount: 10 },
    ], 100, 60);
    expect(rows.map(r => r.clientId)).toEqual(['WAWA', 'ACME']);
  });
});
