#!/usr/bin/env node
/**
 * Extract consolidated DDL and/or DML SQL files.
 *
 * Usage:
 *   node scripts/extract-sql.js [--ddl] [--dml] [--all] [--stdout] [--dry-run]
 *                                 [--update-first-time] [--first-time-only]
 *
 * Defaults (no flags): writes dated snapshots under database/snapshots/
 *   e.g. database/snapshots/dml-20260913.sql
 *
 * First-time bootstrap files (committed to git, used on fresh deploy only):
 *   database/first-time-deployment-ddl.sql
 *   database/first-time-deployment-dml.sql
 *
 * DDL  — generated from prisma/schema.prisma via `prisma migrate diff`
 * DML  — exported from the live SQLite DB using database/sql-export-manifest.json
 *
 * Typical workflow after schema or seed changes:
 *   npm run db:migrate
 *   npm run db:seed          # optional: refresh reference rows in DB first
 *   npm run db:extract       # dated snapshot only
 *   npm run db:extract:first-time   # refresh first-time bootstrap files (rare)
 */

const path = require('path');
const { PrismaClient } = require('@prisma/client');
const {
  extractDdlFromPrisma,
  extractDmlFromDatabase,
  writeFileSafe,
  resolveExportTargets,
} = require('./lib/sql-export-core');

function parseArgs(argv) {
  const opts = {
    ddl: false,
    dml: false,
    all: false,
    stdout: false,
    dryRun: false,
    updateFirstTime: false,
    firstTimeOnly: false,
    outputDir: path.resolve(__dirname, '../../database'),
    manifestPath: path.resolve(__dirname, '../../database/sql-export-manifest.json'),
  };

  for (const arg of argv) {
    if (arg === '--ddl') opts.ddl = true;
    else if (arg === '--dml') opts.dml = true;
    else if (arg === '--all') opts.all = true;
    else if (arg === '--stdout') opts.stdout = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--update-first-time') opts.updateFirstTime = true;
    else if (arg === '--first-time-only') opts.firstTimeOnly = true;
    else if (arg.startsWith('--output-dir=')) opts.outputDir = path.resolve(arg.split('=')[1]);
    else if (arg.startsWith('--manifest=')) opts.manifestPath = path.resolve(arg.split('=')[1]);
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/extract-sql.js [options]

Options:
  --ddl                  Extract DDL only
  --dml                  Extract DML only
  --all                  Extract both (default when no flags)
  --stdout               Print SQL to stdout instead of writing files
  --dry-run              Show what would be written without saving
  --update-first-time    Also refresh database/first-time-deployment-*.sql
  --first-time-only      Refresh first-time bootstrap files only (no dated snapshot)
  --output-dir=PATH      Output directory (default: ../database)
  --manifest=PATH        DML manifest JSON (default: ../database/sql-export-manifest.json)

Default (no special flags): writes dated snapshots to database/snapshots/
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

  const targets = resolveExportTargets(opts.outputDir, {
    updateFirstTime: opts.updateFirstTime,
    firstTimeOnly: opts.firstTimeOnly,
  });

  if (opts.dryRun) {
    console.log('[extract-sql] Dry run — no files written.');
    if (results.ddl) {
      for (const filePath of targets.ddl) console.log(`  would write DDL: ${filePath}`);
    }
    if (results.dml) {
      for (const filePath of targets.dml) console.log(`  would write DML: ${filePath}`);
    }
    return;
  }

  if (results.ddl) {
    for (const filePath of targets.ddl) {
      writeFileSafe(filePath, results.ddl);
      console.log(`[extract-sql] Wrote ${filePath}`);
    }
  }
  if (results.dml) {
    for (const filePath of targets.dml) {
      writeFileSafe(filePath, results.dml);
      console.log(`[extract-sql] Wrote ${filePath}`);
    }
  }

  console.log('[extract-sql] Done.');
}

main().catch((err) => {
  console.error('[extract-sql] Failed:', err?.message || err);
  process.exit(1);
});
