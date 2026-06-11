/**
 * Configure break-glass master account in AppConfig.
 * Default: WFMADMIN / WFMADMIN (bcrypt hash stored, not plaintext).
 *
 * Usage:
 *   node scripts/configure-master.js
 *   node scripts/configure-master.js --username WFMADMIN --password 'your-pass'
 */
const path = require('path');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const MASTER_USERNAME_DEFAULT = 'WFMADMIN';
const MASTER_PASSWORD_DEFAULT = 'WFMADMIN';

function parseArgs() {
  const args = process.argv.slice(2);
  let username = MASTER_USERNAME_DEFAULT;
  let password = MASTER_PASSWORD_DEFAULT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--username' && args[i + 1]) username = args[++i];
    if (args[i] === '--password' && args[i + 1]) password = args[++i];
  }
  return { username, password };
}

async function main() {
  const dbPath = path.resolve(__dirname, '../prisma/dev.db').replace(/\\/g, '/');
  process.env.DATABASE_URL = process.env.DATABASE_URL || `file:${dbPath}`;

  const { username, password } = parseArgs();
  const passwordHash = await bcrypt.hash(password, 10);
  const prisma = new PrismaClient();

  try {
    await prisma.appConfig.update({
      where: { key: 'secrets.masterUsername' },
      data: { value: username, updatedBy: 'configure-master', updatedAt: new Date() },
    });
    await prisma.appConfig.update({
      where: { key: 'secrets.masterPasswordHash' },
      data: { value: passwordHash, updatedBy: 'configure-master', updatedAt: new Date() },
    });
    console.log(`Master account configured: username="${username}" (password hash stored)`);
    console.log('Restart the backend if it is already running.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
