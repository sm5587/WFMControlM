#!/usr/bin/env node
/**
 * Extract consolidated DDL and/or DML SQL files.
 *
 * Usage:
 *   node scripts/extract-sql.js [--ddl] [--dml] [--all] [--stdout] [--dry-run]
 *
 * Defaults (no flags): writes both database/ddl.sql and database/dml.sql
 *
 * DDL  — generated from prisma/schema.prisma via `prisma migrate diff`
 * DML  — exported from the live SQLite DB using database/sql-export-manifest.json
 *
 * Typical workflow after schema or seed changes:
 *   npm run db:migrate
 *   npm run db:seed          # optional: refresh reference rows in DB first
 *   npm run db:extract
 */

const path = require('path');
const { PrismaClient } = require('@prisma/client');
const {
  extractDdlFromPrisma,
  extractDmlFromDatabase,
  writeFileSafe,
} = require('./lib/sql-export-core');

function parseArgs(argv) {
  const opts = {
    ddl: false,
    dml: false,
    all: false,
    stdout: false,
    dryRun: false,
    outputDir: path.resolve(__dirname, '../../database'),
    manifestPath: path.resolve(__dirname, '../../database/sql-export-manifest.json'),
  };

  for (const arg of argv) {
    if (arg === '--ddl') opts.ddl = true;
    else if (arg === '--dml') opts.dml = true;
    else if (arg === '--all') opts.all = true;
    else if (arg === '--stdout') opts.stdout = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg.startsWith('--output-dir=')) opts.outputDir = path.resolve(arg.split('=')[1]);
    else if (arg.startsWith('--manifest=')) opts.manifestPath = path.resolve(arg.split('=')[1]);
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/extract-sql.js [options]

Options:
  --ddl              Extract DDL only
  --dml              Extract DML only
  --all              Extract both (default when no flags)
  --stdout           Print SQL to stdout instead of writing files
  --dry-run          Show what would be written without saving
  --output-dir=PATH  Output directory (default: ../database)
  --manifest=PATH    DML manifest JSON (default: ../database/sql-export-manifest.json)
`);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  if (!opts.ddl && !opts.dml) {
    opts.all = true;
  }
  if (opts.all) {
    opts.ddl = true;
    opts.dml = true;
  }

  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const results = {};

  if (opts.ddl) {
    console.log('[extract-sql] Generating DDL from Prisma schema...');
    results.ddl = extractDdlFromPrisma();
    console.log(`[extract-sql] DDL ready (${results.ddl.length} bytes)`);
  }

  if (opts.dml) {
    console.log('[extract-sql] Exporting DML from database...');
    const prisma = new PrismaClient();
    try {
      results.dml = await extractDmlFromDatabase(prisma, {
        manifestPath: opts.manifestPath,
      });
      console.log(`[extract-sql] DML ready (${results.dml.length} bytes)`);
    } finally {
      await prisma.$disconnect();
    }
  }

  if (opts.stdout) {
    if (results.ddl) {
      process.stdout.write('\n-- ===== DDL =====\n\n');
      process.stdout.write(results.ddl);
      process.stdout.write('\n');
    }
    if (results.dml) {
      process.stdout.write('\n-- ===== DML =====\n\n');
      process.stdout.write(results.dml);
      process.stdout.write('\n');
    }
    return;
  }

  if (opts.dryRun) {
    console.log('[extract-sql] Dry run — no files written.');
    if (results.ddl) console.log(`  would write: ${path.join(opts.outputDir, 'ddl.sql')}`);
    if (results.dml) console.log(`  would write: ${path.join(opts.outputDir, 'dml.sql')}`);
    return;
  }

  if (results.ddl) {
    const ddlPath = path.join(opts.outputDir, 'ddl.sql');
    writeFileSafe(ddlPath, results.ddl);
    console.log(`[extract-sql] Wrote ${ddlPath}`);
  }
  if (results.dml) {
    const dmlPath = path.join(opts.outputDir, 'dml.sql');
    writeFileSafe(dmlPath, results.dml);
    console.log(`[extract-sql] Wrote ${dmlPath}`);
  }

  console.log('[extract-sql] Done.');
}

main().catch((err) => {
  console.error('[extract-sql] Failed:', err?.message || err);
  process.exit(1);
});
