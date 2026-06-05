// ============================================================
// Notify Team email templates (queue buildup + unprocessed punch)
// Used by escalation-service, escalations route, and /dev/email-preview
// ============================================================

export function escHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface QueueBuildupNotifyParams {
  appName: string;
  clientCount: number;
  alertLinesHtml: string;
  recipients: string[];
  sentAt: Date;
}

export function buildQueueBuildupNotifyEmail(params: QueueBuildupNotifyParams): { subject: string; html: string } {
  const { appName, clientCount, alertLinesHtml, recipients, sentAt } = params;
  const subject = `[CRITICAL] ${appName}: ${clientCount} Client(s) with Stale Pending Jobs > 1 Hour`;
  const html = `
      <div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto;">
        <div style="background: #b91c1c; color: white; padding: 12px 20px; border-radius: 8px 8px 0 0;">
          <h2 style="margin: 0; font-size: 16px; font-weight: 500; line-height: 1.3;">⚠️ ${escHtml(appName)} — Escalation Alert</h2>
          <p style="margin: 3px 0 0; opacity: 0.85; font-size: 12px;">CRITICAL · QUEUE_BUILDUP · ${sentAt.toISOString()}</p>
        </div>
        <div style="border: 1px solid #ddd; border-top: none; padding: 20px 24px; border-radius: 0 0 8px 8px;">
          <p style="font-size: 15px; color: #333;">
            <strong>${clientCount} client(s)</strong> have jobs pending for more than 1 hour and require immediate attention.
          </p>
          <table style="width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px;">
            <thead>
              <tr style="background: #f5f5f5; border-bottom: 2px solid #ddd;">
                <th style="padding: 8px 12px; text-align: left;">Client</th>
                <th style="padding: 8px 12px; text-align: left;">Server Code</th>
                <th style="padding: 8px 12px; text-align: left;">Job Type</th>
                <th style="padding: 8px 12px; text-align: left;">Plan</th>
                <th style="padding: 8px 12px; text-align: left;">Stale Pending</th>
                <th style="padding: 8px 12px; text-align: left;">Pending</th>
                <th style="padding: 8px 12px; text-align: left;">Since</th>
              </tr>
            </thead>
            <tbody>
              ${alertLinesHtml}
            </tbody>
          </table>
          <hr style="border: none; border-top: 1px solid #eee; margin: 16px 0;">
          <p style="color: #888; font-size: 12px;">
            Sent by ${escHtml(appName)} at ${sentAt.toISOString()} to: ${recipients.map(escHtml).join(', ')}
          </p>
        </div>
      </div>
    `;
  return { subject, html };
}

export interface PunchNotifyParams {
  appName: string;
  clientCount: number;
  rowLinesHtml: string;
  recipients: string[];
  sentAt: Date;
}

export function buildPunchNotifyEmail(params: PunchNotifyParams): { subject: string; html: string } {
  const { appName, clientCount, rowLinesHtml, recipients, sentAt } = params;
  const subject = `[ALERT] ${appName}: ${clientCount} Client(s) with Unprocessed Punches > 100`;
  const html = `
      <div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;">
        <div style="background:#b45309;color:white;padding:12px 20px;border-radius:8px 8px 0 0;">
          <h2 style="margin:0;font-size:16px;font-weight:500;line-height:1.3;">⏱ ${escHtml(appName)} — Unprocessed Punch Alert</h2>
          <p style="margin:3px 0 0;opacity:.85;font-size:12px;">${sentAt.toISOString()}</p>
        </div>
        <div style="border:1px solid #ddd;border-top:none;padding:20px 24px;border-radius:0 0 8px 8px;">
          <p style="font-size:15px;color:#333;">
            <strong>${clientCount} client(s)</strong> have more than 100 unprocessed punches pending.
          </p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
            <thead>
              <tr style="background:#f5f5f5;border-bottom:2px solid #ddd;">
                <th style="padding:8px 12px;text-align:left;">Client</th>
                <th style="padding:8px 12px;text-align:left;">Code</th>
                <th style="padding:8px 12px;text-align:left;">Cluster</th>
                <th style="padding:8px 12px;text-align:left;">Pending Punches</th>
                <th style="padding:8px 12px;text-align:left;">Last Update Time</th>
              </tr>
            </thead>
            <tbody>${rowLinesHtml}</tbody>
          </table>
          <hr style="border:none;border-top:1px solid #eee;margin:16px 0;">
          <p style="color:#888;font-size:12px;">Sent by ${escHtml(appName)} to: ${recipients.map(escHtml).join(', ')}</p>
        </div>
      </div>`;
  return { subject, html };
}

/** Sample data for /dev/email-preview — mirrors a typical Notify Team email. */
export function buildSampleNotifyEmails(appName = 'WFM Control-M'): Array<{
  id: string;
  label: string;
  description: string;
  subject: string;
  html: string;
}> {
  const sentAt = new Date('2026-06-05T10:30:00.000Z');
  const recipients = ['wfm-ops@zebra.com', 'oncall@zebra.com'];

  const queueRows = [
    `<tr>
        <td style="padding: 6px 12px; font-weight: bold;">CVS Health</td>
        <td style="padding: 6px 12px; font-family: monospace;">CVS</td>
        <td style="padding: 6px 12px; font-family: monospace; font-weight: 600;">CVS_SCHEDULE_GEN</td>
        <td style="padding: 6px 12px;">Weekly</td>
        <td style="padding: 6px 12px; color: #c62828; font-weight: bold;">14</td>
        <td style="padding: 6px 12px;">22</td>
        <td style="padding: 6px 12px; color: #666; font-size: 12px;">6/5/2026, 8:50:00 AM</td>
      </tr>`,
    `<tr>
        <td style="padding: 6px 12px; font-weight: bold;">Walgreens</td>
        <td style="padding: 6px 12px; font-family: monospace;">WAG</td>
        <td style="padding: 6px 12px; font-family: monospace; font-weight: 600;">WAG_PAYROLL_EXPORT</td>
        <td style="padding: 6px 12px;">Daily</td>
        <td style="padding: 6px 12px; color: #c62828; font-weight: bold;">9</td>
        <td style="padding: 6px 12px;">9</td>
        <td style="padding: 6px 12px; color: #666; font-size: 12px;">6/5/2026, 8:25:00 AM</td>
      </tr>`,
    `<tr>
        <td style="padding: 6px 12px; font-weight: bold;">McDonald's DE</td>
        <td style="padding: 6px 12px; font-family: monospace;">MCDDE</td>
        <td style="padding: 6px 12px; font-family: monospace; font-weight: 600;">MCDDE_FORECAST_GEN</td>
        <td style="padding: 6px 12px;">—</td>
        <td style="padding: 6px 12px; color: #c62828; font-weight: bold;">5</td>
        <td style="padding: 6px 12px;">7</td>
        <td style="padding: 6px 12px; color: #666; font-size: 12px;">6/5/2026, 9:32:00 AM</td>
      </tr>`,
  ].join('');

  const punchRows = [
    `<tr>
        <td style="padding:6px 12px;font-weight:bold;">CVS Health</td>
        <td style="padding:6px 12px;font-family:monospace;">CVS</td>
        <td style="padding:6px 12px;">US-East</td>
        <td style="padding:6px 12px;color:#c62828;font-weight:bold;">1,247</td>
        <td style="padding:6px 12px;font-family:monospace;font-size:12px;color:#666;">2026-06-05 09:15:00</td>
      </tr>`,
    `<tr>
        <td style="padding:6px 12px;font-weight:bold;">Walgreens</td>
        <td style="padding:6px 12px;font-family:monospace;">WAG</td>
        <td style="padding:6px 12px;">US-Central</td>
        <td style="padding:6px 12px;color:#c62828;font-weight:bold;">384</td>
        <td style="padding:6px 12px;font-family:monospace;font-size:12px;color:#666;">2026-06-05 09:02:00</td>
      </tr>`,
  ].join('');

  const queue = buildQueueBuildupNotifyEmail({
    appName,
    clientCount: 3,
    alertLinesHtml: queueRows,
    recipients,
    sentAt,
  });

  const punch = buildPunchNotifyEmail({
    appName,
    clientCount: 2,
    rowLinesHtml: punchRows,
    recipients,
    sentAt,
  });

  return [
    {
      id: 'queue-buildup',
      label: 'Queue Buildup',
      description: 'Sent when you click Notify Team on stale pending job alerts.',
      subject: queue.subject,
      html: queue.html,
    },
    {
      id: 'unprocessed-punch',
      label: 'Unprocessed Punch',
      description: 'Sent when you click Notify Team on unprocessed punch alerts.',
      subject: punch.subject,
      html: punch.html,
    },
  ];
}
