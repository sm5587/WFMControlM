/**
 * One-time script: encrypt existing plaintext Client.db2Password values.
 *
 * Run from backend/:
 *   npx ts-node --project tsconfig.json prisma/encrypt-client-db2-passwords.ts
 *
 * Requires CONFIG_ENCRYPTION_KEY in the environment (or .env loaded by your shell).
 * Prefer Admin → Config → Re-encrypt secrets when the app is running.
 */
import dotenv from 'dotenv';
import path from 'path';
import { connectDatabase, disconnectDatabase } from '../src/database/prisma';
import { getReencryptPreflight, reencryptSecrets } from '../src/services/reencrypt-secrets-service';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function main() {
  await connectDatabase();

  const preflight = await getReencryptPreflight();
  console.log('Preflight:', JSON.stringify(preflight, null, 2));

  if (!preflight.encryptionConfigured) {
    throw new Error('CONFIG_ENCRYPTION_KEY not set');
  }

  if (preflight.needsReencrypt === 0) {
    console.log('\nNothing to re-encrypt.');
    return;
  }

  const result = await reencryptSecrets('cli-script');
  console.log('\nDone:', result);
}

main()
  .catch(err => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => disconnectDatabase());
