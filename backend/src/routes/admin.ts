// ============================================================
// Admin Routes - Users, Profiles, Permissions management
// ============================================================

import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../database/prisma';
import { requirePermission } from '../middleware';
import { APP_FUNCTIONS } from '../constants/functions';
import { signToken } from './auth';
import { purgeService } from '../services/purge-service';
import { exportSql, writeSqlFiles, SqlExportType } from '../services/sql-export-service';

const router = Router();

// ────────────────────────────────────────────────────────────
// USERS
// ────────────────────────────────────────────────────────────

// GET /api/admin/users
router.get('/users', requirePermission('USERS_VIEW', 'read'), async (_req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true, username: true, email: true, displayName: true,
        timezone: true, isActive: true, createdAt: true,
        profiles: { include: { profile: { select: { id: true, name: true } } } },
      },
      orderBy: { username: 'asc' },
    });
    res.json({ success: true, data: users });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/admin/users/:id — edit displayName, email, isActive
router.patch('/users/:id', requirePermission('USERS_MANAGE', 'write'), async (req: Request, res: Response) => {
  try {
    const { displayName, email, isActive, password, timezone } = req.body;
    const data: any = {};
    if (displayName !== undefined) data.displayName = displayName;
    if (email !== undefined) data.email = email;
    if (timezone !== undefined) data.timezone = timezone;
    if (isActive !== undefined) data.isActive = isActive;
    if (password) data.passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.update({ where: { id: req.params.id }, data });
    res.json({ success: true, data: { id: user.id, username: user.username, displayName: user.displayName, isActive: user.isActive } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/admin/users/:id — deactivate (soft delete)
router.delete('/users/:id', requirePermission('USERS_MANAGE', 'write'), async (req: Request, res: Response) => {
  try {
    await prisma.user.update({ where: { id: req.params.id }, data: { isActive: false } });
    res.json({ success: true, message: 'User deactivated' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// PROFILE ASSIGNMENTS
// ────────────────────────────────────────────────────────────

// GET /api/admin/users/:id/profiles
router.get('/users/:id/profiles', requirePermission('USERS_VIEW', 'read'), async (req: Request, res: Response) => {
  try {
    const rows = await prisma.userProfile.findMany({
      where: { userId: req.params.id },
      include: { profile: { select: { id: true, name: true, description: true } } },
    });
    res.json({ success: true, data: rows });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/users/:id/profiles — assign profile
router.post('/users/:id/profiles', requirePermission('USER_PROFILE_ASSIGN', 'write'), async (req: Request, res: Response) => {
  try {
    const { profileId } = req.body;
    const assigner = (req as any).user?.username;
    await prisma.userProfile.upsert({
      where: { userId_profileId: { userId: req.params.id, profileId } },
      update: { assignedBy: assigner },
      create: { userId: req.params.id, profileId, assignedBy: assigner },
    });
    res.json({ success: true, message: 'Profile assigned' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/admin/users/:userId/profiles/:profileId — remove profile
router.delete('/users/:userId/profiles/:profileId', requirePermission('USER_PROFILE_ASSIGN', 'write'), async (req: Request, res: Response) => {
  try {
    await prisma.userProfile.delete({
      where: { userId_profileId: { userId: req.params.userId, profileId: req.params.profileId } },
    });
    res.json({ success: true, message: 'Profile removed' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// PROFILES
// ────────────────────────────────────────────────────────────

// GET /api/admin/profiles
router.get('/profiles', requirePermission('PROFILES_VIEW', 'read'), async (_req: Request, res: Response) => {
  try {
    const profiles = await prisma.profile.findMany({
      include: {
        permissions: { include: { function: true } },
        _count: { select: { users: true } },
      },
      orderBy: { name: 'asc' },
    });
    res.json({ success: true, data: profiles });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/profiles — create profile
router.post('/profiles', requirePermission('PROFILES_MANAGE', 'write'), async (req: Request, res: Response) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'name is required' });
    const profile = await prisma.profile.create({ data: { name, description } });
    res.status(201).json({ success: true, data: profile });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/admin/profiles/:id
router.patch('/profiles/:id', requirePermission('PROFILES_MANAGE', 'write'), async (req: Request, res: Response) => {
  try {
    const { name, description } = req.body;
    const profile = await prisma.profile.update({
      where: { id: req.params.id },
      data: { ...(name && { name }), ...(description !== undefined && { description }) },
    });
    res.json({ success: true, data: profile });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/admin/profiles/:id (non-system only)
router.delete('/profiles/:id', requirePermission('PROFILES_MANAGE', 'write'), async (req: Request, res: Response) => {
  try {
    const profile = await prisma.profile.findUnique({ where: { id: req.params.id } });
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });
    if (profile.isSystem) return res.status(403).json({ success: false, error: 'Cannot delete a system profile' });
    await prisma.profile.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: 'Profile deleted' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// PERMISSIONS (on a profile)
// ────────────────────────────────────────────────────────────

// GET /api/admin/functions — full function catalog
router.get('/functions', requirePermission('PROFILES_VIEW', 'read'), (_req: Request, res: Response) => {
  const fns = Object.values(APP_FUNCTIONS);
  res.json({ success: true, data: fns });
});

// PUT /api/admin/profiles/:id/permissions — replace all permissions for profile
// Body: [{ functionId, canRead, canWrite }, ...]
router.put('/profiles/:id/permissions', requirePermission('PERMISSIONS_EDIT', 'write'), async (req: Request, res: Response) => {
  try {
    const profile = await prisma.profile.findUnique({ where: { id: req.params.id } });
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

    const perms: { functionId: string; canRead: boolean; canWrite: boolean }[] = req.body;
    if (!Array.isArray(perms)) return res.status(400).json({ success: false, error: 'Body must be an array of permissions' });

    // Replace all permissions in a transaction
    await prisma.$transaction([
      prisma.permission.deleteMany({ where: { profileId: req.params.id } }),
      ...perms.map(p =>
        prisma.permission.create({
          data: { profileId: req.params.id, functionId: p.functionId, canRead: !!p.canRead, canWrite: !!p.canWrite },
        }),
      ),
    ]);

    res.json({ success: true, message: 'Permissions updated' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/admin/profiles/:id/permissions/:functionId — update single permission
router.patch('/profiles/:id/permissions/:functionId', requirePermission('PERMISSIONS_EDIT', 'write'), async (req: Request, res: Response) => {
  try {
    const { canRead, canWrite } = req.body;
    const perm = await prisma.permission.upsert({
      where: { profileId_functionId: { profileId: req.params.id, functionId: req.params.functionId } },
      update: { canRead: !!canRead, canWrite: !!canWrite },
      create: { profileId: req.params.id, functionId: req.params.functionId, canRead: !!canRead, canWrite: !!canWrite },
    });
    res.json({ success: true, data: perm });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// PURGE CONFIGURATION
// ────────────────────────────────────────────────────────────

// GET /api/admin/purge/config — get all purge configs + current row counts
router.get('/purge/config', requirePermission('DATA_PURGE_VIEW', 'read'), async (_req: Request, res: Response) => {
  try {
    const [configs, counts] = await Promise.all([
      prisma.purgeConfig.findMany({ orderBy: { id: 'asc' } }),
      purgeService.getRowCounts(),
    ]);
    res.json({ success: true, data: { configs, counts } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/admin/purge/config/:id — update retention for one table
router.put('/purge/config/:id', requirePermission('DATA_PURGE_RUN', 'write'), async (req: Request, res: Response) => {
  try {
    const { retainDays, enabled } = req.body;
    const data: any = {};
    if (retainDays !== undefined) data.retainDays = Number(retainDays);
    if (enabled !== undefined) data.enabled = Boolean(enabled);
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid fields' });
    }
    const cfg = await prisma.purgeConfig.update({ where: { id: req.params.id }, data });
    res.json({ success: true, data: cfg });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/purge/run — run all purge tasks now
router.post('/purge/run', requirePermission('DATA_PURGE_RUN', 'write'), async (_req: Request, res: Response) => {
  try {
    const summary = await purgeService.runAll();
    res.json({ success: true, data: summary });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/purge/run/:id — run purge for a single table
router.post('/purge/run/:id', requirePermission('DATA_PURGE_RUN', 'write'), async (req: Request, res: Response) => {
  try {
    const cfg = await prisma.purgeConfig.findUnique({ where: { id: req.params.id } });
    if (!cfg) return res.status(404).json({ success: false, error: 'Config not found' });
    const result = await purgeService.runOne(cfg.id, cfg.label, cfg.retainDays, cfg.enabled);
    await prisma.purgeConfig.update({
      where: { id: cfg.id },
      data: { lastPurgeAt: new Date(), lastPurgeCount: result.deleted },
    });
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ────────────────────────────────────────────────────────────
// SQL EXPORT — regenerate database/ddl.sql and database/dml.sql
// ────────────────────────────────────────────────────────────

// GET /api/admin/sql-export?type=ddl|dml|all
router.get('/sql-export', requirePermission('PERMISSIONS_EDIT', 'read'), async (req: Request, res: Response) => {
  try {
    const rawType = String(req.query.type || 'all').toLowerCase();
    const type: SqlExportType = rawType === 'ddl' || rawType === 'dml' ? rawType : 'all';
    const data = await exportSql(type);
    res.json({
      success: true,
      data: {
        type,
        ...data,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/sql-export/write?type=ddl|dml|all
router.post('/sql-export/write', requirePermission('PERMISSIONS_EDIT', 'write'), async (req: Request, res: Response) => {
  try {
    const rawType = String(req.query.type || 'all').toLowerCase();
    const type: SqlExportType = rawType === 'ddl' || rawType === 'dml' ? rawType : 'all';
    const payload = await exportSql(type);
    const paths = writeSqlFiles(payload);
    res.json({
      success: true,
      data: {
        type,
        paths,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
