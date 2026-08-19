import { buildSshConnectOptions, validateRemoteCommand } from '../../src/utils/ssh-client';

describe('ssh-client', () => {
  const baseCreds = {
    username: 'wfmwatch',
    password: 'secret',
    totpSecret: '',
  };

  describe('buildSshConnectOptions', () => {
    it('uses password auth for service accounts', () => {
      const opts = buildSshConnectOptions('appserver.example', baseCreds, 15000);
      expect(opts.password).toBe('secret');
      expect(opts.authHandler).toEqual(['password', 'keyboard-interactive']);
    });
  });

  describe('validateRemoteCommand', () => {
    it('allows read-only monitoring commands', () => {
      expect(() => validateRemoteCommand("tail -300 '/mount/RWS4/logs/job.log'")).not.toThrow();
      expect(() => validateRemoteCommand('db2 connect reset')).not.toThrow();
      expect(() => validateRemoteCommand('bash -lc \'find /mount/RWS4 -maxdepth 1\'')).not.toThrow();
    });

    it('rejects interactive or destructive commands', () => {
      expect(() => validateRemoteCommand('rm -rf /')).toThrow(/not permitted/);
      expect(() => validateRemoteCommand('bash -i')).toThrow(/not permitted/);
      expect(() => validateRemoteCommand('')).toThrow(/Empty SSH command/);
    });
  });
});
