// ============================================================
// Monitoring Service - Real-time monitoring and dashboard data
// ============================================================

import dayjs from 'dayjs';
import { prisma } from '../database/prisma';
import { createServiceLogger } from '../utils/logger';
import { DashboardStats } from '../models/types';
import { jobExecutor } from '../engine/executor';

const logger = createServiceLogger('MonitoringService');

export class MonitoringService {
  /**
   * Get main dashboard statistics
   */
  async getDashboardStats(): Promise<DashboardStats> {
    const today = dayjs().startOf('day').toDate();
    const todayEnd = dayjs().endOf('day').toDate();

    const [
      totalJobs,
      activeJobs,
      runningExecutions,
      failedToday,
      succeededToday,
      pendingExecutions,
      activeAlerts,
    ] = await Promise.all([
      prisma.job.count(),
      prisma.job.count({ where: { isActive: true } }),
      prisma.jobExecution.count({ where: { status: 'RUNNING' } }),
      prisma.jobExecution.count({
        where: { status: 'FAILED', completedAt: { gte: today, lte: todayEnd } },
      }),
      prisma.jobExecution.count({
        where: { status: 'SUCCESS', completedAt: { gte: today, lte: todayEnd } },
      }),
      prisma.jobExecution.count({
        where: { status: { in: ['PENDING', 'QUEUED'] } },
      }),
      prisma.alertEvent.count({
        where: { acknowledged: false, createdAt: { gte: today } },
      }),
    ]);

    // Calculate trends (last 7 days)
    const avgDurationTrend: number[] = [];
    const successRateTrend: number[] = [];

    for (let i = 6; i >= 0; i--) {
      const dayStart = dayjs().subtract(i, 'day').startOf('day').toDate();
      const dayEnd = dayjs().subtract(i, 'day').endOf('day').toDate();

      const [executions, avgDuration] = await Promise.all([
        prisma.jobExecution.groupBy({
          by: ['status'],
          where: { completedAt: { gte: dayStart, lte: dayEnd } },
          _count: true,
        }),
        prisma.jobExecution.aggregate({
          where: {
            completedAt: { gte: dayStart, lte: dayEnd },
            status: 'SUCCESS',
            duration: { not: null },
          },
          _avg: { duration: true },
        }),
      ]);

      const totalForDay = executions.reduce((sum, e) => sum + e._count, 0);
      const successForDay = executions.find(e => e.status === 'SUCCESS')?._count || 0;

      avgDurationTrend.push(Math.round(avgDuration._avg.duration || 0));
      successRateTrend.push(totalForDay > 0 ? Math.round((successForDay / totalForDay) * 100) : 100);
    }

    return {
      totalJobs,
      activeJobs,
      runningExecutions,
      failedToday,
      succeededToday,
      pendingExecutions,
      activeAlerts,
      avgDurationTrend,
      successRateTrend,
    };
  }

  /**
   * Get live job execution feed
   */
  async getLiveExecutions(limit: number = 50) {
    return prisma.jobExecution.findMany({
      where: {
        status: { in: ['RUNNING', 'PENDING', 'QUEUED', 'RETRY_PENDING'] },
      },
      include: {
        job: { select: { name: true, jobType: true, category: true, priority: true } },
      },
      orderBy: [
        { job: { priority: 'desc' } },
        { scheduledAt: 'asc' },
      ],
      take: limit,
    });
  }

  /**
   * Get recent execution history
   */
  async getExecutionHistory(options: {
    page?: number;
    pageSize?: number;
    jobId?: string;
    clientId?: string;
    cluster?: string;
    status?: string;
    startDate?: string;
    endDate?: string;
    category?: string;
    search?: string;
  } = {}) {
    const {
      page = 1,
      pageSize = 50,
      jobId,
      clientId,
      cluster,
      status,
      startDate,
      endDate,
      category,
      search,
    } = options;

    const where: any = {};
    if (jobId) where.jobId = jobId;
    if (status) where.status = status;

    // Build job-relation filter
    const jobFilter: any = {};
    if (clientId) jobFilter.clientId = clientId;
    if (cluster)  jobFilter.client   = { cluster };
    if (category) jobFilter.category = category;
    if (search) {
      jobFilter.OR = [
        { name: { contains: search } },
        { description: { contains: search } },
      ];
    }
    if (Object.keys(jobFilter).length > 0) where.job = jobFilter;

    if (startDate || endDate) {
      where.scheduledAt = {};
      if (startDate) where.scheduledAt.gte = new Date(startDate);
      if (endDate)   where.scheduledAt.lte = new Date(endDate);
    }

    const [executions, total] = await Promise.all([
      prisma.jobExecution.findMany({
        where,
        include: {
          job: { select: { name: true, jobType: true, category: true, tags: true } },
        },
        orderBy: { scheduledAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.jobExecution.count({ where }),
    ]);

    return {
      data: executions,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  /**
   * Get job performance analytics
   */
  async getJobAnalytics(jobId: string, days: number = 30) {
    const since = dayjs().subtract(days, 'day').toDate();

    const [executions, avgDuration, statsByStatus] = await Promise.all([
      prisma.jobExecution.findMany({
        where: { jobId, scheduledAt: { gte: since } },
        select: {
          id: true,
          status: true,
          scheduledAt: true,
          startedAt: true,
          completedAt: true,
          duration: true,
          attempt: true,
        },
        orderBy: { scheduledAt: 'desc' },
      }),
      prisma.jobExecution.aggregate({
        where: { jobId, scheduledAt: { gte: since }, status: 'SUCCESS' },
        _avg: { duration: true },
        _min: { duration: true },
        _max: { duration: true },
      }),
      prisma.jobExecution.groupBy({
        by: ['status'],
        where: { jobId, scheduledAt: { gte: since } },
        _count: true,
      }),
    ]);

    const totalExecutions = statsByStatus.reduce((sum, s) => sum + s._count, 0);
    const successCount = statsByStatus.find(s => s.status === 'SUCCESS')?._count || 0;

    return {
      jobId,
      period: `${days} days`,
      totalExecutions,
      successRate: totalExecutions > 0 ? Math.round((successCount / totalExecutions) * 100) : 0,
      duration: {
        avg: Math.round(avgDuration._avg.duration || 0),
        min: avgDuration._min.duration || 0,
        max: avgDuration._max.duration || 0,
      },
      statusBreakdown: statsByStatus.map(s => ({ status: s.status, count: s._count })),
      recentExecutions: executions.slice(0, 20),
    };
  }

  /**
   * Get system health overview
   */
  async getSystemHealth() {
    const [
      runningJobs,
      queueDepth,
      recentFailures,
      resourcePools,
    ] = await Promise.all([
      prisma.jobExecution.count({ where: { status: 'RUNNING' } }),
      prisma.jobExecution.count({ where: { status: { in: ['PENDING', 'QUEUED'] } } }),
      prisma.jobExecution.count({
        where: {
          status: 'FAILED',
          completedAt: { gte: dayjs().subtract(1, 'hour').toDate() },
        },
      }),
      prisma.resourcePool.findMany(),
    ]);

    return {
      status: recentFailures > 10 ? 'degraded' : 'healthy',
      runningJobs,
      queueDepth,
      recentFailures,
      executorRunning: jobExecutor.getRunningCount(),
      resourcePools: resourcePools.map(p => ({
        name: p.name,
        usage: `${p.currentUsage}/${p.maxConcurrency}`,
        utilization: Math.round((p.currentUsage / p.maxConcurrency) * 100),
      })),
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
    };
  }
}

export const monitoringService = new MonitoringService();
