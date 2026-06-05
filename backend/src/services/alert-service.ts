// ============================================================
// Alert Service - Notification and alerting system
// ============================================================

import nodemailer from 'nodemailer';
import https from 'https';
import dayjs from 'dayjs';
import utcPlugin from 'dayjs/plugin/utc';
import tzPlugin from 'dayjs/plugin/timezone';
import { prisma } from '../database/prisma';
import { config } from '../config';
import { configService } from './config-service';
import { createServiceLogger } from '../utils/logger';
import { AlertSeverity, AlertChannel, AlertTriggerType } from '../models/types';
import { EventEmitter } from 'events';

dayjs.extend(utcPlugin);
dayjs.extend(tzPlugin);

const logger = createServiceLogger('AlertService');

interface AlertPayload {
  triggerType: AlertTriggerType;
  severity: AlertSeverity;
  title: string;
  message: string;
  metadata?: Record<string, any>;
  executionId?: string;
}

export class AlertService extends EventEmitter {
  private emailTransporter: nodemailer.Transporter | null = null;

  constructor() {
    super();
    this.initializeEmailTransporter();
  }

  /**
   * Normalize SMTP host/port for nodemailer.
   * On Windows, "localhost" often resolves to IPv6 (::1) while Mailpit binds IPv4 only.
   * Port 0 or legacy 587 with a local host → use Mailpit default 1025.
   */
  private resolveSmtpEndpoint(): { host: string; port: number } | null {
    const rawHost = (config.smtp.host || '').trim();
    if (!rawHost) return null;

    const host =
      rawHost === 'localhost' || rawHost === '::1' || rawHost === '[::1]'
        ? '127.0.0.1'
        : rawHost;

    let port = config.smtp.port;
    if (!Number.isFinite(port) || port <= 0) {
      port = host === '127.0.0.1' ? 1025 : 587;
    } else if (host === '127.0.0.1' && port === 587) {
      // AppConfig still on corporate default — prefer Mailpit when targeting loopback
      port = 1025;
      logger.warn('SMTP port 587 with localhost — using 1025 (Mailpit). Update secrets.smtpPort in Admin > Config.');
    }

    return { host, port };
  }

  /**
   * Initialize email transporter
   */
  private initializeEmailTransporter(): void {
    this.emailTransporter = null;
    const endpoint = this.resolveSmtpEndpoint();
    if (!endpoint) {
      logger.warn('Email transporter not configured - SMTP host not set, email alerts disabled');
      return;
    }

    const { host, port } = endpoint;
    const hasAuth = !!(config.smtp.user);
    const transportOptions: nodemailer.TransportOptions = {
      host,
      port,
      secure: port === 465,
      family: 4, // prefer IPv4 (avoids ECONNREFUSED on ::1)
      ...(hasAuth
        ? { auth: { user: config.smtp.user, pass: config.smtp.pass } }
        : { ignoreTLS: true }),
      tls: { rejectUnauthorized: false },
    } as nodemailer.TransportOptions;
    this.emailTransporter = nodemailer.createTransport(transportOptions);
    logger.info(`Email transporter initialized (host=${host}:${port}, auth=${hasAuth ? 'yes' : 'none'})`);
  }

  /**
   * Rebuild transporter from current in-memory config values.
   */
  reloadTransporter(): void {
    this.initializeEmailTransporter();
  }

  /**
   * Returns whether the email transporter is ready.
   */
  isEmailConfigured(): boolean {
    return this.emailTransporter !== null;
  }

  /**
   * Send an email directly to the given recipients.
   * Public wrapper used by EscalationService to bypass AlertRule routing.
   * Throws on failure so the caller can catch and log.
   */
  async sendDirectEmail(
    recipients: string[],
    subject: string,
    html: string,
  ): Promise<{ accepted: string[]; rejected: string[] }> {
    if (!this.emailTransporter) {
      throw new Error(
        `SMTP not configured — set secrets.smtpHost in Admin > Config ` +
        `(current: host="${config.smtp.host || 'not set'}", port=${config.smtp.port || 0})`
      );
    }
    if (recipients.length === 0) {
      throw new Error('No recipients provided');
    }

    const info = await this.emailTransporter.sendMail({
      from: config.smtp.fromEmail,
      to: recipients.join(', '),
      subject,
      html,
    });

    // nodemailer envelope accepted/rejected is in info.accepted / info.rejected
    return {
      accepted: (info.accepted ?? recipients) as string[],
      rejected: (info.rejected ?? []) as string[],
    };
  }

  /**
   * Process an alert - find matching rules and send notifications
   */
  async processAlert(payload: AlertPayload): Promise<void> {
    logger.info(`Processing alert: ${payload.triggerType} - ${payload.title}`);

    // Find matching alert rules
    const rules = await prisma.alertRule.findMany({
      where: {
        isActive: true,
        triggerType: payload.triggerType,
        // Filter by job if execution is provided
        ...(payload.executionId ? {
          OR: [
            { jobId: null }, // Global rules
            {
              job: {
                executions: { some: { id: payload.executionId } },
              },
            },
          ],
        } : {}),
      },
    });

    for (const rule of rules) {
      // Check cooldown
      if (rule.lastTriggeredAt) {
        const cooldownExpiry = new Date(rule.lastTriggeredAt.getTime() + rule.cooldownMinutes * 60000);
        if (new Date() < cooldownExpiry) {
          logger.debug(`Alert rule ${rule.id} in cooldown, skipping`);
          continue;
        }
      }

      // Create alert event
      const alertEvent = await prisma.alertEvent.create({
        data: {
          alertRuleId: rule.id,
          executionId: payload.executionId,
          severity: payload.severity,
          title: payload.title,
          message: payload.message,
          metadata: payload.metadata ? JSON.stringify(payload.metadata) : null,
        },
      });

      // Update last triggered time
      await prisma.alertRule.update({
        where: { id: rule.id },
        data: { lastTriggeredAt: new Date() },
      });

      // Send notifications through each channel
      for (const channel of (typeof rule.channels === 'string' ? JSON.parse(rule.channels) : rule.channels) as AlertChannel[]) {
        try {
          switch (channel) {
            case 'EMAIL':
              const recipients = typeof rule.recipients === 'string' ? JSON.parse(rule.recipients) : rule.recipients;
              await this.sendEmail(recipients, payload);
              break;
            case 'SLACK':
              await this.sendSlack(rule.slackChannel || '', payload);
              break;
            case 'WEBHOOK':
              if (rule.webhookUrl) {
                await this.sendWebhook(rule.webhookUrl, payload);
              }
              break;
            case 'IN_APP':
              this.emit('alert:new', { alertEvent, payload });
              break;
          }
        } catch (error: any) {
          logger.error(`Failed to send ${channel} alert: ${error.message}`);
        }
      }
    }
  }

  /**
   * Send email alert
   */
  private async sendEmail(recipients: string[], payload: AlertPayload): Promise<void> {
    if (!this.emailTransporter || recipients.length === 0) return;

    const severityColors: Record<string, string> = {
      INFO: '#3b82f6',
      WARNING: '#f59e0b',
      CRITICAL: '#ef4444',
      EMERGENCY: '#7c3aed',
    };

    const severityIcons: Record<string, string> = {
      INFO: 'ℹ️',
      WARNING: '⚠️',
      CRITICAL: '🔴',
      EMERGENCY: '🚨',
    };

    const color = severityColors[payload.severity] || '#6b7280';
    const icon = severityIcons[payload.severity] || '⚠️';
    const appName = configService.getAppName();
    const now = dayjs().tz('Asia/Kolkata');
    const timestamp = now.format('DD MMM YYYY HH:mm') + ' IST';

    // Format metadata as a clean key-value table instead of raw JSON
    let detailsHtml = '';
    if (payload.metadata && Object.keys(payload.metadata).length > 0) {
      const rows = Object.entries(payload.metadata)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => {
          const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
          const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
          return `<tr><td style="padding:6px 12px;color:#6b7280;font-size:13px;white-space:nowrap;vertical-align:top;">${label}</td><td style="padding:6px 12px;font-size:13px;color:#1f2937;">${val}</td></tr>`;
        })
        .join('');
      detailsHtml = `
        <table style="width:100%;border-collapse:collapse;margin:12px 0;background:#f9fafb;border-radius:6px;overflow:hidden;">
          ${rows}
        </table>`;
    }

    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <!-- Header -->
        <div style="background:${color};padding:20px 24px;">
          <h2 style="margin:0;color:#ffffff;font-size:18px;font-weight:600;">${icon} ${appName} Alert</h2>
          <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:13px;">${payload.severity} · ${payload.triggerType.replace(/_/g, ' ')}</p>
        </div>

        <!-- Body -->
        <div style="padding:24px;">
          <h3 style="margin:0 0 8px;font-size:16px;color:#111827;">${payload.title}</h3>
          <p style="margin:0 0 16px;font-size:14px;color:#4b5563;line-height:1.5;">${payload.message}</p>

          ${detailsHtml}

          <!-- Timestamp -->
          <div style="margin-top:20px;padding-top:16px;border-top:1px solid #f3f4f6;">
            <p style="margin:0;font-size:12px;color:#9ca3af;">
              Sent at ${timestamp}
            </p>
          </div>
        </div>

        <!-- Footer -->
        <div style="background:#f9fafb;padding:12px 24px;border-top:1px solid #f3f4f6;">
          <p style="margin:0;font-size:11px;color:#9ca3af;text-align:center;">
            ${appName} · Job Orchestration Platform · Zebra Technologies
          </p>
        </div>
      </div>
    `;

    await this.emailTransporter.sendMail({
      from: config.smtp.fromEmail,
      to: recipients.join(', '),
      subject: `[${payload.severity}] ${appName}: ${payload.title}`,
      html,
    });

    logger.info(`Email alert sent to: ${recipients.join(', ')}`);
  }

  /**
   * Send Slack notification
   */
  private async sendSlack(channel: string, payload: AlertPayload): Promise<void> {
    const webhookUrl = config.slackWebhookUrl;
    if (!webhookUrl) return;

    const severityEmoji: Record<string, string> = {
      INFO: 'ℹ️',
      WARNING: '⚠️',
      CRITICAL: '🔴',
      EMERGENCY: '🚨',
    };

    const appName = configService.getAppName();
    const slackPayload = {
      channel: channel || undefined,
      username: appName,
      icon_emoji: ':robot_face:',
      attachments: [{
        color: payload.severity === 'CRITICAL' || payload.severity === 'EMERGENCY' ? 'danger' :
               payload.severity === 'WARNING' ? 'warning' : 'good',
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: `${severityEmoji[payload.severity]} ${payload.title}`,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: payload.message,
            },
          },
          {
            type: 'context',
            elements: [{
              type: 'mrkdwn',
              text: `*Severity:* ${payload.severity} | *Type:* ${payload.triggerType} | *Time:* ${new Date().toISOString()}`,
            }],
          },
        ],
      }],
    };

    return new Promise((resolve, reject) => {
      const url = new URL(webhookUrl);
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          if (res.statusCode === 200) {
            logger.info('Slack alert sent');
            resolve();
          } else {
            reject(new Error(`Slack returned ${res.statusCode}`));
          }
        });
      });
      req.on('error', reject);
      req.write(JSON.stringify(slackPayload));
      req.end();
    });
  }

  /**
   * Send webhook notification
   */
  private async sendWebhook(url: string, payload: AlertPayload): Promise<void> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const client = parsed.protocol === 'https:' ? https : require('http');
      
      const req = client.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (res: any) => {
        res.on('data', () => {});
        res.on('end', () => resolve());
      });
      req.on('error', reject);
      req.write(JSON.stringify({
        source: 'wfm-controlm',
        timestamp: new Date().toISOString(),
        ...payload,
      }));
      req.end();
    });
  }

  /**
   * Get alert history
   */
  async getAlertHistory(options: {
    page?: number;
    pageSize?: number;
    severity?: AlertSeverity;
    acknowledged?: boolean;
    startDate?: string;
    endDate?: string;
  } = {}) {
    const { page = 1, pageSize = 50, severity, acknowledged, startDate, endDate } = options;

    const where: any = {};
    if (severity) where.severity = severity;
    if (acknowledged !== undefined) where.acknowledged = acknowledged;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const [events, total] = await Promise.all([
      prisma.alertEvent.findMany({
        where,
        include: {
          alertRule: true,
          execution: { include: { job: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.alertEvent.count({ where }),
    ]);

    return {
      data: events,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  /**
   * Acknowledge an alert
   */
  async acknowledgeAlert(alertEventId: string, userId: string): Promise<void> {
    await prisma.alertEvent.update({
      where: { id: alertEventId },
      data: {
        acknowledged: true,
        acknowledgedBy: userId,
        acknowledgedAt: new Date(),
      },
    });
    logger.info(`Alert ${alertEventId} acknowledged by ${userId}`);
  }
}

export const alertService = new AlertService();
