// ============================================================
// Dev-only email preview page — same HTML as production notify emails
// ============================================================

import { Router, Request, Response } from 'express';
import { config } from '../config';
import { configService } from '../services/config-service';
import { buildSampleNotifyEmails } from '../email/notify-email-templates';

const router = Router();

function previewUnavailable(_req: Request, res: Response): void {
  res.status(404).send('Email preview is only available in development.');
}

function renderPreviewPage(emails: ReturnType<typeof buildSampleNotifyEmails>): string {
  const nav = emails
    .map(
      (e, i) =>
        `<button type="button" class="tab${i === 0 ? ' active' : ''}" data-target="${e.id}">${e.label}</button>`
    )
    .join('');

  const panels = emails
    .map(
      (e, i) => `
    <section id="panel-${e.id}" class="panel${i === 0 ? ' active' : ''}">
      <p class="desc">${e.description}</p>
      <div class="meta"><strong>Subject:</strong> ${e.subject}</div>
      <div class="email-frame">${e.html}</div>
    </section>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Notify Email Preview</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #eef1f4;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #1f2937;
    }
    .wrap { max-width: 920px; margin: 0 auto; padding: 28px 20px 48px; }
    h1 { margin: 0 0 6px; font-size: 22px; font-weight: 600; }
    .subtitle { margin: 0 0 20px; font-size: 13px; color: #6b7280; line-height: 1.5; }
    .tabs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
    .tab {
      border: 1px solid #d1d5db;
      background: #fff;
      color: #374151;
      border-radius: 8px;
      padding: 8px 14px;
      font-size: 13px;
      cursor: pointer;
    }
    .tab.active { background: #111827; border-color: #111827; color: #fff; }
    .panel { display: none; }
    .panel.active { display: block; }
    .desc { margin: 0 0 10px; font-size: 13px; color: #4b5563; }
    .meta {
      font-size: 12px;
      color: #374151;
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 10px 14px;
      margin-bottom: 16px;
      word-break: break-word;
    }
    .email-frame {
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 24px;
    }
    .refresh {
      display: inline-block;
      margin-top: 16px;
      font-size: 12px;
      color: #2563eb;
      text-decoration: none;
    }
    .refresh:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Notify Email Preview</h1>
    <p class="subtitle">
      Live preview using the same templates as production Notify Team emails.
      Edit <code>backend/src/email/notify-email-templates.ts</code> and refresh this page.
    </p>
    <div class="tabs">${nav}</div>
    ${panels}
    <a class="refresh" href="/dev/email-preview">Refresh preview</a>
  </div>
  <script>
    document.querySelectorAll('.tab').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = btn.getAttribute('data-target');
        document.querySelectorAll('.tab').forEach(function(b) { b.classList.remove('active'); });
        document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
        btn.classList.add('active');
        document.getElementById('panel-' + id).classList.add('active');
      });
    });
  </script>
</body>
</html>`;
}

router.get('/email-preview', (req: Request, res: Response) => {
  if (config.nodeEnv === 'production') {
    previewUnavailable(req, res);
    return;
  }

  const appName = configService.getAppName();
  const emails = buildSampleNotifyEmails(appName);
  res.type('html').send(renderPreviewPage(emails));
});

router.get('/email-preview/:id', (req: Request, res: Response) => {
  if (config.nodeEnv === 'production') {
    previewUnavailable(req, res);
    return;
  }

  const appName = configService.getAppName();
  const emails = buildSampleNotifyEmails(appName);
  const match = emails.find(e => e.id === req.params.id);
  if (!match) {
    res.status(404).json({ error: 'Unknown preview id' });
    return;
  }

  res.json({
    id: match.id,
    label: match.label,
    subject: match.subject,
    html: match.html,
  });
});

export default router;
