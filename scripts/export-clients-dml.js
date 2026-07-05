#!/usr/bin/env node
/**
 * Export Client + AppServer rows from the live SQLite DB into database/clients-dml.sql.
 *
 * Usage (from repo root):
 *   node scripts/export-clients-dml.js
 *
 * Requires DATABASE_URL in .env or environment (same as backend).
 */

const path = require('path');
const { PrismaClient } = require(path.join(__dirname, '../backend/node_modules/@prisma/client'));
const { buildInsertStatement, writeFileSafe } = require(path.join(__dirname, '../backend/scripts/lib/sql-export-core'));

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'database', 'clients-dml.sql');

async function main() {
  const prisma = new PrismaClient();
  const header = [
    '-- WFM Control-M client inventory DML',
    '--',
    '-- Seeds Client + AppServer rows after database/dml.sql on fresh Unix/WSL deploys.',
    '-- Safe to rerun: uses INSERT OR IGNORE.',
    '--',
    '-- Apply manually:',
    '--   sqlite3 backend/prisma/dev.db < database/clients-dml.sql',
    '--   sqlite3 backend/prisma/dev.db < database/fix-client-datetimes.sql  # only if dates were exported as text',
    '--',
    '-- Regenerate from live DB:',
    '--   node scripts/export-clients-dml.js',
    '',
  ].join('\n');

  const clients = await prisma.$queryRawUnsafe('SELECT * FROM "Client" ORDER BY "clientId"');
  const servers = await prisma.$queryRawUnsafe(
    'SELECT * FROM "AppServer" ORDER BY "clientId", "environment", "serverNum"',
  );

  const parts = [header];
  parts.push('-- ============================================================');
  parts.push(`-- CLIENTS (${clients.length} rows)`);
  parts.push('-- ============================================================');
  if (clients.length) {
    const cols = Object.keys(clients[0]);
    for (let i = 0; i < clients.length; i += 50) {
      parts.push(buildInsertStatement('Client', cols, clients.slice(i, i + 50), 'ignore'));
    }
  } else {
    parts.push('-- (no rows in Client)');
  }

  parts.push('');
  parts.push('-- ============================================================');
  parts.push(`-- APP SERVERS (${servers.length} rows)`);
  parts.push('-- ============================================================');
  if (servers.length) {
    const cols = Object.keys(servers[0]);
    for (let i = 0; i < servers.length; i += 50) {
      parts.push(buildInsertStatement('AppServer', cols, servers.slice(i, i + 50), 'ignore'));
    }
  } else {
    parts.push('-- (no rows in AppServer)');
  }
  parts.push('');

  writeFileSafe(OUT, parts.join('\n'));
  console.log(`Wrote ${OUT} (${clients.length} clients, ${servers.length} app servers)`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
