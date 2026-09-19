import { buildStartupBanner } from '../../src/utils/startup-banner';

describe('buildStartupBanner', () => {
  const base = {
    appName: 'WFM Watch',
    port: 4005,
    deploymentLabel: 'Docker',
  };

  it('shows localhost URLs and email preview in development', () => {
    const banner = buildStartupBanner({ ...base, nodeEnv: 'development' });
    expect(banner).toContain('http://localhost:4005');
    expect(banner).toContain('/dev/email-preview');
    expect(banner).not.toContain('PUBLIC_API_URL');
  });

  it('shows listen address and hint when production without PUBLIC_API_URL', () => {
    const banner = buildStartupBanner({ ...base, nodeEnv: 'production' });
    expect(banner).toContain('Listen:    0.0.0.0:4005');
    expect(banner).toContain('Set PUBLIC_API_URL in .env for external URL');
    expect(banner).toContain('Deployment: Docker');
    expect(banner).not.toContain('localhost');
    expect(banner).not.toContain('/dev/email-preview');
  });

  it('shows public URLs when production with PUBLIC_API_URL', () => {
    const banner = buildStartupBanner({
      ...base,
      nodeEnv: 'production',
      publicApiUrl: 'http://z182sp-usc1wstmon01:4015',
    });
    expect(banner).toContain('HTTP:      http://z182sp-usc1wstmon01:4015');
    expect(banner).toContain('WebSocket: ws://z182sp-usc1wstmon01:4015');
    expect(banner).toContain('API:       http://z182sp-usc1wstmon01:4015/api');
    expect(banner).toContain('Health:    http://z182sp-usc1wstmon01:4015/health');
    expect(banner).not.toContain('localhost');
  });
});
