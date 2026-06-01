// ============================================================
// Monitoring API Routes
// ============================================================

import { Router, Request, Response } from 'express';
import { monitoringService } from '../services/monitoring-service';
import { scheduler } from '../engine/scheduler';

const router = Router();

// GET /api/monitoring/dashboard - Main dashboard stats
router.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const stats = await monitoringService.getDashboardStats();
    res.json({ success: true, data: stats });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/monitoring/live - Live execution feed
router.get('/live', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const executions = await monitoringService.getLiveExecutions(limit);
    res.json({ success: true, data: executions });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/monitoring/history - Execution history
router.get('/history', async (req: Request, res: Response) => {
  try {
    const result = await monitoringService.getExecutionHistory({
      page: parseInt(req.query.page as string) || 1,
      pageSize: parseInt(req.query.pageSize as string) || 100,
      jobId: req.query.jobId as string,
      clientId: req.query.clientId as string,
      cluster: req.query.cluster as string,
      status: req.query.status as string,
      startDate: req.query.startDate as string,
      endDate: req.query.endDate as string,
      category: req.query.category as string,
      search: req.query.search as string,
    });
    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/monitoring/analytics/:jobId - Job analytics
router.get('/analytics/:jobId', async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const analytics = await monitoringService.getJobAnalytics(req.params.jobId, days);
    res.json({ success: true, data: analytics });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/monitoring/health - System health
router.get('/health', async (req: Request, res: Response) => {
  try {
    const health = await monitoringService.getSystemHealth();
    res.json({ success: true, data: health });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/monitoring/scheduler - Scheduler status
router.get('/scheduler', async (req: Request, res: Response) => {
  try {
    const status = scheduler.getStatus();
    res.json({ success: true, data: status });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/monitoring/upcoming-checks - Jobs queued for automatic status check
router.get('/upcoming-checks', async (req: Request, res: Response) => {
  try {
    const checks = scheduler.getUpcomingChecks();
    res.json({
      success: true,
      data: {
        totalPending: checks.length,
        checks,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
