/**
 * import-db2-creds.ts
 * One-time script: reads existing dbconnections/Production/*_DBString.txt files
 * and populates db2Host, db2Port, db2Database, db2Username, db2Password on
 * matching Client rows in Prisma.
 *
 * Run from the backend/ directory:
 *   npx ts-node --project tsconfig.json prisma/import-db2-creds.ts
 *
 * Safe to run multiple times — uses upsert semantics (only updates non-null values).
 * Once Keeper is integrated, passwords can be cleared: db2Password = null.
 */

import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();
const connDir = path.resolve(__dirname, '../../dbconnections/Production');

interface ConnInfo {
  clientId: string;
  jdbcUrl:  string;
  host:     string;
  port:     number;
  database: string;
  username: string;
  password: string;
}

function parseConnFile(filePath: string, fileClientId: string): ConnInfo | null {
  try {
    const lines = fs.readFileSync(filePath, 'utf-8')
      .trim()
      .split('\n')
      .map(l => l.trim());

    if (lines.length < 3) {
      console.warn(`  SKIP ${fileClientId}: file has fewer than 3 lines`);
      return null;
    }

    const jdbcUrl  = lines[0];
    const username = lines[1];
    const password = lines[2];

    const m = jdbcUrl.match(/^jdbc:db2:\/\/([^:]+):(\d+)\/([^\s]+)/i);
    if (!m) {
      console.warn(`  SKIP ${fileClientId}: cannot parse JDBC URL: ${jdbcUrl}`);
      return null;
    }

    return {
      clientId: fileClientId,
      jdbcUrl,
      host:     m[1],
      port:     parseInt(m[2], 10),
      database: m[3],
      username,
      password,
    };
  } catch (err: any) {
    console.warn(`  SKIP ${fileClientId}: ${err.message}`);
    return null;
  }
}

async function main() {
  console.log(`\nDB2 Credentials Import\n${'='.repeat(50)}`);
  console.log(`Connection files: ${connDir}\n`);

  if (!fs.existsSync(connDir)) {
    console.error(`ERROR: Directory not found: ${connDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(connDir).filter(f => /\.txt$/i.test(f));
  console.log(`Found ${files.length} connection file(s)\n`);

  let updated = 0;
  let skippedNoMatch = 0;
  let skippedParseError = 0;

  for (const file of files) {
    const fileClientId = file.replace(/_DBString\.txt$/i, '').toUpperCase();
    const info = parseConnFile(path.join(connDir, file), fileClientId);

    if (!info) {
      skippedParseError++;
      continue;
    }

    // Try to find the Client by exact clientId match
    const existing = await prisma.client.findFirst({
      where: { clientId: fileClientId },
      select: { id: true, clientId: true, db2Host: true },
    });

    if (!existing) {
      console.log(`  NO MATCH  ${fileClientId} — no Client row with this clientId`);
      skippedNoMatch++;
      continue;
    }

    await prisma.client.update({
      where: { id: existing.id },
      data: {
        db2Host:     info.host,
        db2Port:     info.port,
        db2Database: info.database,
        db2Username: info.username,
        db2Password: info.password,
      },
    });

    console.log(`  OK  ${fileClientId.padEnd(12)} → ${info.host}:${info.port}/${info.database}  user=${info.username}`);
    updated++;
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Updated       : ${updated}`);
  console.log(`No DB match   : ${skippedNoMatch}`);
  console.log(`Parse errors  : ${skippedParseError}`);
  console.log(`Total files   : ${files.length}`);

  await prisma.$disconnect();
}

main().catch(err => {
  console.error('Fatal:', err);
  prisma.$disconnect();
  process.exit(1);
});
