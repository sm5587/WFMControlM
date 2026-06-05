/**
 * Point AppConfig SMTP at local Mailpit and ensure a test recipient exists.
 * Run from backend/: node scripts/configure-mailpit.js
 * Then restart the backend (reloadTransporter runs on startup).
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const smtp = {
    'secrets.smtpHost': '127.0.0.1',
    'secrets.smtpPort': '1025',
    'secrets.smtpUser': '',
    'secrets.smtpPass': '',
  };

  for (const [key, value] of Object.entries(smtp)) {
    await prisma.appConfig.upsert({
      where: { key },
      update: { value },
      create: {
        key,
        value,
        category: 'SECRETS',
        label: key,
        isSecret: key === 'secrets.smtpPass',
      },
    });
    console.log(`  ${key} = ${value || '(empty)'}`);
  }

  await prisma.notificationRecipient.upsert({
    where: { email: 'test@localhost' },
    create: { name: 'Local Tester', email: 'test@localhost', isActive: true },
    update: { isActive: true, name: 'Local Tester' },
  });
  console.log('  recipient: test@localhost (active)');

  console.log('\nDone. Restart backend, open Mailpit UI http://localhost:8025');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
