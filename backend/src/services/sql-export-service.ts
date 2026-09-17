import path from 'path';
import { prisma } from '../database/prisma';

// Shared with CLI script (backend/scripts/extract-sql.js)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require(path.join(__dirname, '../../scripts/lib/sql-export-core'));

export type SqlExportType = 'ddl' | 'dml' | 'all';

export type SqlWriteMode = 'snapshot' | 'first-time' | 'both';

export async function exportSql(type: SqlExportType = 'all'): Promise<{ ddl?: string; dml?: string }> {
  const result: { ddl?: string; dml?: string } = {};

  if (type === 'ddl' || type === 'all') {
    result.ddl = core.extractDdlFromPrisma();
  }
  if (type === 'dml' || type === 'all') {
    result.dml = await core.extractDmlFromDatabase(prisma, {
      manifestPath: core.DEFAULT_MANIFEST,
    });
  }

  return result;
}

export function writeSqlFiles(
  payload: { ddl?: string; dml?: string },
  options?: { outputDir?: string; mode?: SqlWriteMode },
): { ddlPaths?: string[]; dmlPaths?: string[] } {
  const dir = options?.outputDir || path.resolve(__dirname, '../../../database');
  const mode = options?.mode || 'snapshot';
  const updateFirstTime = mode === 'both' || mode === 'first-time';
  const firstTimeOnly = mode === 'first-time';
  const targets = core.resolveExportTargets(dir, { updateFirstTime, firstTimeOnly });
  const written: { ddlPaths?: string[]; dmlPaths?: string[] } = {};

  if (payload.ddl) {
    written.ddlPaths = [];
    for (const filePath of targets.ddl) {
      core.writeFileSafe(filePath, payload.ddl);
      written.ddlPaths.push(filePath);
    }
  }
  if (payload.dml) {
    written.dmlPaths = [];
    for (const filePath of targets.dml) {
      core.writeFileSafe(filePath, payload.dml);
      written.dmlPaths.push(filePath);
    }
  }

  return written;
}
