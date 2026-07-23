/**
 * One-time script: encrypt existing plaintext Client.db2Password values.
 *
 * Run from backend/:
 *   npx ts-node --project tsconfig.json prisma/encrypt-client-db2-passwords.ts
 *
 * Requires CONFIG_ENCRYPTION_KEY in the environment (or .env loaded by your shell).
 * Skips rows that already decrypt successfully (already encrypted).
 */
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import path from 'path';
import {
  decryptClientDb2Password,
  encryptClientDb2Password,
} from '../src/utils/client-db2-password';
import { decryptSecret } from '../src/utils/crypto';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const prisma = new PrismaClient();

function isAlreadyEncrypted(stored: string): boolean {
  try {
    decryptSecret(stored);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const rows = await prisma.client.findMany({
    where: { db2Password: { not: null } },
    select: { id: true, clientId: true, db2Password: true },
  });

  let encrypted = 0;
  let skipped = 0;

  for (const row of rows) {
    const stored = row.db2Password!;
    if (isAlreadyEncrypted(stored)) {
      skipped++;
      continue;
    }

    const plaintext = decryptClientDb2Password(stored);
    if (!plaintext) continue;

    await prisma.client.update({
      where: { id: row.id },
      data: { db2Password: encryptClientDb2Password(plaintext) },
    });
    encrypted++;
    console.log(`  encrypted ${row.clientId}`);
  }

  console.log(`\nDone: ${encrypted} encrypted, ${skipped} already encrypted, ${rows.length} total with password`);
}

main()
  .catch(err => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
