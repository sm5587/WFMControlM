// Startup log banner — dev shows localhost; production uses PUBLIC_API_URL or listen address.

export interface StartupBannerOptions {
  appName: string;
  port: number;
  nodeEnv: string;
  deploymentLabel: string;
  publicApiUrl?: string;
}

function padLine(label: string, value: string): string {
  const content = `${label}${value}`;
  return `║   ${content.padEnd(52)}║`;
}

function httpBaseUrl(opts: StartupBannerOptions): string {
  const publicUrl = opts.publicApiUrl?.trim().replace(/\/$/, '');
  if (publicUrl) return publicUrl;
  if (opts.nodeEnv === 'production') return `0.0.0.0:${opts.port}`;
  return `http://localhost:${opts.port}`;
}

function wsBaseUrl(opts: StartupBannerOptions): string {
  const publicUrl = opts.publicApiUrl?.trim().replace(/\/$/, '');
  if (publicUrl) return publicUrl.replace(/^http/i, 'ws');
  if (opts.nodeEnv === 'production') return `ws://0.0.0.0:${opts.port}`;
  return `ws://localhost:${opts.port}`;
}

function apiUrl(opts: StartupBannerOptions): string {
  const publicUrl = opts.publicApiUrl?.trim().replace(/\/$/, '');
  if (publicUrl) return `${publicUrl}/api`;
  if (opts.nodeEnv === 'production') return `0.0.0.0:${opts.port}/api`;
  return `http://localhost:${opts.port}/api`;
}

function healthUrl(opts: StartupBannerOptions): string {
  const publicUrl = opts.publicApiUrl?.trim().replace(/\/$/, '');
  if (publicUrl) return `${publicUrl}/health`;
  if (opts.nodeEnv === 'production') return `0.0.0.0:${opts.port}/health`;
  return `http://localhost:${opts.port}/health`;
}

export function buildStartupBanner(opts: StartupBannerOptions): string {
  const isProd = opts.nodeEnv === 'production';
  const lines = [
    '╔══════════════════════════════════════════════════════╗',
    '║                                                      ║',
    `║   🚀 ${opts.appName} Server`.padEnd(55) + '║',
    '║                                                      ║',
  ];

  if (isProd) {
    lines.push(padLine('Deployment: ', opts.deploymentLabel));
    if (opts.publicApiUrl?.trim()) {
      lines.push(padLine('HTTP:      ', httpBaseUrl(opts)));
      lines.push(padLine('WebSocket: ', wsBaseUrl(opts)));
    } else {
      lines.push(padLine('Listen:    ', `0.0.0.0:${opts.port}`));
      lines.push(padLine('Hint:      ', 'Set PUBLIC_API_URL in .env for external URL'));
    }
  } else {
    lines.push(padLine('HTTP:      ', httpBaseUrl(opts)));
    lines.push(padLine('WebSocket: ', wsBaseUrl(opts)));
  }

  lines.push(padLine('Env:       ', opts.nodeEnv));
  lines.push('║                                                      ║');
  lines.push(padLine('API:       ', apiUrl(opts)));
  lines.push(padLine('Health:    ', healthUrl(opts)));

  if (!isProd) {
    lines.push(padLine('Email preview: ', `http://localhost:${opts.port}/dev/email-preview`));
  }

  lines.push('║                                                      ║');
  lines.push('╚══════════════════════════════════════════════════════╝');

  return lines.join('\n');
}
