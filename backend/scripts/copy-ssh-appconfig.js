#!/usr/bin/env node
/**
 * Copy SSH AppConfig rows from another SQLite DB (e.g. Windows dev.db → WSL dev.db).
 * Encrypted secret values copy as-is — both DBs must use the same CONFIG_ENCRYPTION_KEY.
 *
 * Usage (from backend/, target = current DATABASE_URL in .env):
 *   SOURCE_DATABASE_URL="file:/path/to/source/dev.db" node scripts/copy-ssh-appconfig.js
 */
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const KEYS = ['secrets.sshUsername', 'secrets.sshPassword', 'secrets.sshTotpSecret'];
const sourceUrl = process.env.SOURCE_DATABASE_URL;
if (!sourceUrl) {
  console.error('Set SOURCE_DATABASE_URL to the source SQLite file URL (file:./prisma/dev.db or absolute file:/...)');
  process.exit(1);
}

async function readRows(dbUrl) {
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  try {
    return prisma.appConfig.findMany({
      where: { key: { in: KEYS } },
      select: { key: true, value: true, isSecret: true },
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const sourceRows = await readRows(sourceUrl);
  const byKey = new Map(sourceRows.map((r) => [r.key, r]));
  const missing = KEYS.filter((k) => !byKey.has(k));
  if (missing.length) {
    console.error('Source DB missing keys:', missing.join(', '));
    process.exit(1);
  }

  const user = byKey.get('secrets.sshUsername')?.value?.trim() || '';
  const pass = byKey.get('secrets.sshPassword')?.value?.trim() || '';
  if (!user || !pass) {
    console.error('Source DB has empty SSH username or password — configure on source first.');
    process.exit(1);
  }

  const target = new PrismaClient();
  try {
    for (const key of KEYS) {
      const row = byKey.get(key);
      await target.appConfig.update({
        where: { key },
        data: {
          value: row.value ?? '',
          updatedBy: 'copy-ssh-appconfig',
          updatedAt: new Date(),
        },
      });
      console.log(`Copied ${key} (len=${(row.value || '').length}, secret=${row.isSecret})`);
    }
    console.log(`Done — SSH account "${user}" copied to target DB. Restart backend (pm2 restart wfm-backend).`);
  } finally {
    await target.$disconnect();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
