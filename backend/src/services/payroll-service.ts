// ============================================================
// Payroll Service
// Queries TA_UNIT_PAY_STATUS from client DB2 databases
// Uses db2DirectService (jjs/JDBC) — same approach as DB Monitor
// ============================================================

import { logger } from '../utils/logger';
import { db2DirectService } from './db2-direct-service';
import { configService } from './config-service';

export interface PayrollRecord {
  [key: string]: string;
}

export interface PayrollSummary {
  totalRecords: number;
  uniqueUnits: number;
  weekStartDates: string[];
  fileStatusCounts: Record<string, number>;
  lockStatusCounts: Record<string, number>;
}

export interface PayrollResult {
  clientId: string;
  columns: string[];
  records: PayrollRecord[];
  summary: PayrollSummary;
  recordCount: number;
  executionTimeMs: number;
  error?: string;
}

// Columns that are internal IDs or redundant — exclude from display
const EXCLUDED_COLUMNS = new Set([
  'TA_UNIT_PAY_STATUS_ID', 'CREATED_BY', 'UPDATED_BY',
  'VERSION', 'RECORD_STATUS', 'TENANT_ID',
  'OWNER_ID', 'CLIENT_ID', 'YEAR', 'WEEK_NO',
]);

class PayrollService {

  /**
   * Fetch TA_UNIT_PAY_STATUS data for a single client (last 7 days).
   * Returns SELECT * but filters out columns with no meaningful data.
   */
  async getPayrollStatus(clientId: string): Promise<PayrollResult> {
    const startMs = Date.now();

    const sql = `SELECT * FROM RWSUSER.TA_UNIT_PAY_STATUS ` +
      `WHERE to_date(WEEK_END_DATE,'yyyyMMdd') >= CURRENT DATE - ${configService.getInt('engine.payrollLookbackDays', 7)} DAYS ` +
      `AND to_date(WEEK_END_DATE,'yyyyMMdd') <= CURRENT DATE ` +
      `ORDER BY WEEK_START_DATE DESC, UNIT_ID`;

    const result = await db2DirectService.queryClient(clientId, sql, 'Payroll');

    if (!result.success || !result.rows) {
      throw new Error(result.error || `Failed to query TA_UNIT_PAY_STATUS for ${clientId}`);
    }

    // Filter out excluded columns, all-empty columns, and all-zero columns
    const allColumns = result.rows.length > 0 ? Object.keys(result.rows[0]) : [];
    const meaningfulColumns = allColumns.filter(col => {
      if (EXCLUDED_COLUMNS.has(col)) return false;

      const values = result.rows!.map(row => (row[col] || '').trim());
      // Drop column if every value is empty/null
      const hasNonEmpty = values.some(v => v.length > 0 && v !== 'null');
      if (!hasNonEmpty) return false;

      // Drop column if every non-empty value is zero-like (0, 0.0, 0.00000, -0, etc.)
      const nonEmpty = values.filter(v => v.length > 0 && v !== 'null');
      const allZero = nonEmpty.length > 0 && nonEmpty.every(v => /^-?0+(\.0+)?$/.test(v));
      if (allZero) return false;

      // Drop COUNT columns where every non-empty value is zero-like
      if (col.toUpperCase().includes('COUNT') || col.toUpperCase().includes('CNT')) {
        const allCountZero = nonEmpty.every(v => /^-?\d*\.?0+$/.test(v) && parseFloat(v) === 0);
        if (allCountZero) return false;
      }

      return true;
    });

    // Build cleaned records with only meaningful columns
    const records: PayrollRecord[] = result.rows.map(row => {
      const clean: PayrollRecord = {};
      for (const col of meaningfulColumns) {
        clean[col] = (row[col] || '').trim();
      }
      return clean;
    });

    // Build summary
    const unitSet = new Set<string>();
    const weekDates = new Set<string>();
    const fileStatusCounts: Record<string, number> = {};
    const lockStatusCounts: Record<string, number> = {};

    for (const r of records) {
      if (r.UNIT_ID) unitSet.add(r.UNIT_ID);
      if (r.WEEK_START_DATE) weekDates.add(r.WEEK_START_DATE);
      if (r.FILE_STATUS) {
        const fs = r.FILE_STATUS;
        fileStatusCounts[fs] = (fileStatusCounts[fs] || 0) + 1;
      }
      if (r.LOCK_STATUS) {
        const ls = r.LOCK_STATUS;
        lockStatusCounts[ls] = (lockStatusCounts[ls] || 0) + 1;
      }
    }

    const summary: PayrollSummary = {
      totalRecords: records.length,
      uniqueUnits: unitSet.size,
      weekStartDates: Array.from(weekDates).sort().reverse(),
      fileStatusCounts,
      lockStatusCounts,
    };

    return {
      clientId,
      columns: meaningfulColumns,
      records,
      summary,
      recordCount: records.length,
      executionTimeMs: Date.now() - startMs,
    };
  }
}

export const payrollService = new PayrollService();
