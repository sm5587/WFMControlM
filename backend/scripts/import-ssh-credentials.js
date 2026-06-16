/**
 * One-off: import SSH credentials from deprecated backup into AppConfig.
 * Usage: node scripts/import-ssh-credentials.js [path-to-.saved_credentials.json]
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const defaultPath = path.resolve(__dirname, '../../deprecated/artifacts/.saved_credentials.json');
const credPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultPath;

function loadFromBackup(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const mode = (raw.credential_mode || 'service').toLowerCase();

  if (mode === 'personal' && raw.personal_username) {
    return {
      username: raw.personal_username,
      password: raw.personal_password
        ? Buffer.from(raw.personal_password, 'base64').toString()
        : '',
      totpSecret: raw.personal_totp_secret
        ? Buffer.from(raw.personal_totp_secret, 'base64').toString()
        : '',
      mode,
    };
  }

  let password = '';
  if (raw.password) {
    if (raw.password_format === 'dpapi') {
      throw new Error('DPAPI passwords must be decrypted on Windows before import');
    }
    password = Buffer.from(raw.password, 'base64').toString();
  }

  return {
    username: raw.username || '',
    password,
    totpSecret: raw.totp_secret
      ? Buffer.from(raw.totp_secret, 'base64').toString()
      : '',
    mode,
  };
}

async function main() {
  if (!fs.existsSync(credPath)) {
    console.error(`Credentials file not found: ${credPath}`);
    process.exit(1);
  }

  const creds = loadFromBackup(credPath);
  if (!creds.username || !creds.password) {
    console.error('Backup file is missing username or password');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  const updates = [
    ['secrets.sshUsername', creds.username],
    ['secrets.sshPassword', creds.password],
    ['secrets.sshTotpSecret', creds.totpSecret],
  ];

  try {
    for (const [key, value] of updates) {
      await prisma.appConfig.update({
        where: { key },
        data: {
          value,
          updatedBy: 'import-ssh-credentials',
          updatedAt: new Date(),
        },
      });
      const label = key.replace('secrets.', '');
      console.log(`Updated ${label} (len=${value.length})`);
    }
    console.log(`Done — imported ${creds.mode} account "${creds.username}" into AppConfig`);
    console.log('Restart the backend if it is already running so config cache reloads.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
