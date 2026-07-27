/**
 * One-off / manual: ensure Upload File Monitor AppConfig keys exist.
 * Also runs automatically on backend startup via config-service.ensureFileMonitorConfig().
 */
const { PrismaClient } = require('@prisma/client');

const defaults = [
  ['infra.sshPendingFolderPath', '/mount/RWS4/batch_jobs/in', 'Pending IN Folder', 'Remote path for pending upload files'],
  ['infra.sshRejectedUploadRoot', '/mount/RWS4/appuploads/upload', 'Rejected Upload Root', 'Root path for rejected DTS file scan'],
  ['infra.sshCommandTimeoutSec', '30', 'SSH Command Timeout (sec)', 'Timeout for pending IN folder find (maxdepth 1)'],
  ['infra.sshRejectedFindTimeoutSec', '120', 'Rejected Find Timeout (sec)', 'Timeout for recursive rejected DTS find under upload root'],
];

async function main() {
  const prisma = new PrismaClient();
  try {
    for (const [key, value, label, description] of defaults) {
      const existing = await prisma.appConfig.findUnique({ where: { key } });
      if (existing) {
        console.log(`exists: ${key} = ${existing.value}`);
        continue;
      }
      await prisma.appConfig.create({
        data: { key, value, category: 'INFRA', label, description, isSecret: false, updatedBy: 'system' },
      });
      console.log(`added:  ${key} = ${value}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
