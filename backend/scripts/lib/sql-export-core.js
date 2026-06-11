const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_MANIFEST = path.resolve(__dirname, '../../../database/sql-export-manifest.json');

function loadManifest(manifestPath = DEFAULT_MANIFEST) {
  const absolute = path.resolve(manifestPath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`SQL export manifest not found: ${absolute}`);
  }
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

function postProcessDdl(rawSql) {
  const body = rawSql
    .replace(/^CREATE UNIQUE INDEX "/gm, 'CREATE UNIQUE INDEX IF NOT EXISTS "')
    .replace(/^CREATE INDEX "/gm, 'CREATE INDEX IF NOT EXISTS "')
    .replace(/^CREATE TABLE "/gm, 'CREATE TABLE IF NOT EXISTS "');

  return [
    '-- WFM Control-M consolidated production DDL',
    '-- Generated from current Prisma schema (all tables/indexes/constraints).',
    '-- Apply on a fresh database before running database/dml.sql.',
    '-- Regenerate: npm run db:extract',
    '',
    'PRAGMA foreign_keys = ON;',
    '',
    body.trim(),
    '',
  ].join('\n');
}

function extractDdlFromPrisma(options = {}) {
  const backendDir = options.backendDir || path.resolve(__dirname, '../..');
  const schemaPath = options.schemaPath || path.join(backendDir, 'prisma', 'schema.prisma');
  const prismaCli = path.join(backendDir, 'node_modules', 'prisma', 'build', 'index.js');

  const raw = execFileSync(
    process.execPath,
    [
      prismaCli,
      'migrate',
      'diff',
      '--from-empty',
      '--to-schema-datamodel',
      schemaPath,
      '--script',
    ],
    {
      cwd: backendDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  return postProcessDdl(raw);
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (value instanceof Date) return `'${value.toISOString().replace('T', ' ').replace('Z', '')}'`;
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return `'${value.toString('hex')}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function buildInsertStatement(table, columns, rows, insertMode) {
  if (rows.length === 0) return '';

  const verb = insertMode === 'replace' ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE';
  const colList = columns.map(quoteIdent).join(', ');
  const valueGroups = rows.map((row) => {
    const vals = columns.map((col) => sqlLiteral(row[col])).join(', ');
    return `  (${vals})`;
  });

  return `${verb} INTO ${quoteIdent(table)} (${colList}) VALUES\n${valueGroups.join(',\n')};`;
}

function chunkRows(rows, size) {
  const chunks = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

function normalizeRow(row, section) {
  const copy = { ...row };
  if (section.maskSecretValues && Object.prototype.hasOwnProperty.call(copy, 'isSecret') && copy.isSecret) {
    copy.value = '';
  }
  return copy;
}

async function fetchTableRows(prisma, section) {
  const table = section.table;
  const whereClause = section.where ? ` WHERE ${section.where}` : '';
  const orderClause = Array.isArray(section.orderBy) && section.orderBy.length > 0
    ? ` ORDER BY ${section.orderBy.map(quoteIdent).join(', ')}`
    : '';

  const sql = `SELECT * FROM ${quoteIdent(table)}${whereClause}${orderClause}`;
  return prisma.$queryRawUnsafe(sql);
}

function buildDmlHeader() {
  return [
    '-- WFM Control-M consolidated production DML',
    '--',
    '-- This script seeds baseline reference/config data after database/ddl.sql.',
    '-- It is safe to rerun because statements use INSERT OR IGNORE / OR REPLACE.',
    '-- Regenerate: npm run db:extract',
    '--',
    '-- NOTE:',
    '-- 1) Client/AppServer inventory is environment-specific and should be loaded',
    '--    via import scripts/admin APIs, not hardcoded in this file.',
    '-- 2) Replace placeholder secret values before production rollout.',
    '',
  ].join('\n');
}

async function extractDmlFromDatabase(prisma, options = {}) {
  const manifest = loadManifest(options.manifestPath);
  const sections = manifest?.dml?.sections || [];
  if (sections.length === 0) {
    throw new Error('No DML sections configured in sql-export-manifest.json');
  }

  const parts = [buildDmlHeader()];
  const rowsPerInsert = options.rowsPerInsert || 100;

  for (const section of sections) {
    parts.push('-- ============================================================');
    parts.push(`-- ${section.title}`);
    parts.push('-- ============================================================');
    if (Array.isArray(section.notes)) {
      for (const note of section.notes) parts.push(`-- ${note}`);
    }

    const rawRows = await fetchTableRows(prisma, section);
    const rows = rawRows.map((row) => normalizeRow(row, section));

    if (rows.length === 0) {
      parts.push(`-- (no rows in ${section.table})`);
      parts.push('');
      continue;
    }

    const columns = Object.keys(rows[0]);
    for (const chunk of chunkRows(rows, rowsPerInsert)) {
      parts.push(buildInsertStatement(section.table, columns, chunk, section.insertMode || 'ignore'));
    }
    parts.push('');
  }

  return parts.join('\n');
}

function writeFileSafe(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

module.exports = {
  DEFAULT_MANIFEST,
  loadManifest,
  postProcessDdl,
  extractDdlFromPrisma,
  extractDmlFromDatabase,
  writeFileSafe,
  sqlLiteral,
  buildInsertStatement,
};
