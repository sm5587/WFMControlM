// ============================================================
// RBAC bootstrap helpers — grant new function permissions on
// existing DBs without requiring a manual upgrade SQL re-run.
// ============================================================

import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';

const HEATMAP_FUNCTION_ID = 'HEATMAP_VIEW';
const LEGACY_HEATMAP_FUNCTION_ID = 'WIP_HEATMAP_VIEW';

const SYSTEM_PROFILE_WRITE = new Set(['System Admin']);
const SYSTEM_PROFILE_READ = new Set([
  'System Admin',
  'Monitor',
  'Advanced Monitor',
  'Read Only',
]);

/**
 * Ensure HEATMAP_VIEW exists on system profiles and on any profile
 * that already has Payroll Monitor read (custom clones).
 * Migrates legacy WIP_HEATMAP_VIEW grants when present.
 */
export async function ensureHeatMapPermissions(): Promise<void> {
  await migrateLegacyHeatMapFunction();

  const systemProfiles = await prisma.profile.findMany({
    where: { isSystem: true },
    select: { id: true, name: true },
  });

  let created = 0;
  for (const profile of systemProfiles) {
    if (!SYSTEM_PROFILE_READ.has(profile.name)) continue;
    const canWrite = SYSTEM_PROFILE_WRITE.has(profile.name);
    const before = await prisma.permission.findUnique({
      where: {
        profileId_functionId: { profileId: profile.id, functionId: HEATMAP_FUNCTION_ID },
      },
    });
    if (before) continue;
    await prisma.permission.create({
      data: {
        profileId: profile.id,
        functionId: HEATMAP_FUNCTION_ID,
        canRead: true,
        canWrite,
      },
    });
    created += 1;
  }

  const monitorReaders = await prisma.permission.findMany({
    where: { functionId: 'PAYROLL_MONITOR_VIEW', canRead: true },
    select: { profileId: true },
  });
  for (const { profileId } of monitorReaders) {
    const before = await prisma.permission.findUnique({
      where: {
        profileId_functionId: { profileId, functionId: HEATMAP_FUNCTION_ID },
      },
    });
    if (before) continue;
    await prisma.permission.create({
      data: {
        profileId,
        functionId: HEATMAP_FUNCTION_ID,
        canRead: true,
        canWrite: false,
      },
    });
    created += 1;
  }

  if (created > 0) {
    logger.info(`Granted ${HEATMAP_FUNCTION_ID} to ${created} profile(s)`);
  }
}

/** Copy grants from WIP_HEATMAP_VIEW → HEATMAP_VIEW, then drop the legacy function. */
async function migrateLegacyHeatMapFunction(): Promise<void> {
  const legacy = await prisma.appFunction.findUnique({
    where: { id: LEGACY_HEATMAP_FUNCTION_ID },
  });
  if (!legacy) return;

  await prisma.appFunction.upsert({
    where: { id: HEATMAP_FUNCTION_ID },
    update: {
      module: 'Heat Map',
      name: 'Heat Map',
      description: 'Weekly ITERATION_TYPE 6 vs 7 store count comparison',
      sortOrder: 74,
    },
    create: {
      id: HEATMAP_FUNCTION_ID,
      module: 'Heat Map',
      name: 'Heat Map',
      description: 'Weekly ITERATION_TYPE 6 vs 7 store count comparison',
      sortOrder: 74,
    },
  });

  const legacyPerms = await prisma.permission.findMany({
    where: { functionId: LEGACY_HEATMAP_FUNCTION_ID },
  });
  for (const perm of legacyPerms) {
    await prisma.permission.upsert({
      where: {
        profileId_functionId: {
          profileId: perm.profileId,
          functionId: HEATMAP_FUNCTION_ID,
        },
      },
      create: {
        profileId: perm.profileId,
        functionId: HEATMAP_FUNCTION_ID,
        canRead: perm.canRead,
        canWrite: perm.canWrite,
      },
      update: {
        canRead: perm.canRead,
        canWrite: perm.canWrite,
      },
    });
  }

  await prisma.permission.deleteMany({ where: { functionId: LEGACY_HEATMAP_FUNCTION_ID } });
  await prisma.appFunction.delete({ where: { id: LEGACY_HEATMAP_FUNCTION_ID } });
  logger.info(`Migrated ${LEGACY_HEATMAP_FUNCTION_ID} → ${HEATMAP_FUNCTION_ID}`);
}

/** @deprecated Use ensureHeatMapPermissions */
export const ensureWipHeatMapPermissions = ensureHeatMapPermissions;
