import path from 'path';
import { prisma } from '../database/prisma';

// Shared with CLI script (backend/scripts/extract-sql.js)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require(path.join(__dirname, '../../scripts/lib/sql-export-core'));

export type SqlExportType = 'ddl' | 'dml' | 'all';

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
  outputDir?: string,
): { ddlPath?: string; dmlPath?: string } {
  const dir = outputDir || path.resolve(__dirname, '../../../database');
  const written: { ddlPath?: string; dmlPath?: string } = {};

  if (payload.ddl) {
    const ddlPath = path.join(dir, 'ddl.sql');
    core.writeFileSafe(ddlPath, payload.ddl);
    written.ddlPath = ddlPath;
  }
  if (payload.dml) {
    const dmlPath = path.join(dir, 'dml.sql');
    core.writeFileSafe(dmlPath, payload.dml);
    written.dmlPath = dmlPath;
  }

  return written;
}
