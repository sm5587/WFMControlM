import {
  validateRemoteLogPath,
  validateRemoteCronFilePath,
  sanitizePgrepSearchTerm,
  sanitizeGrepKey,
  shellQuote,
  defaultLogPathAllowPrefixes,
} from '../../src/utils/remote-path';

const PREFIXES = defaultLogPathAllowPrefixes('/mount/RWS4');

describe('validateRemoteLogPath', () => {
  it('accepts valid WFM log paths', () => {
    expect(
      validateRemoteLogPath('/mount/RWS4/logs/batch/job.log', { allowedPrefixes: PREFIXES }),
    ).toBe('/mount/RWS4/logs/batch/job.log');
    expect(
      validateRemoteLogPath('/mount/backup/cronEntry.out', { allowedPrefixes: PREFIXES }),
    ).toBe('/mount/backup/cronEntry.out');
  });

  it('rejects path traversal and sensitive paths', () => {
    expect(
      validateRemoteLogPath('/mount/RWS4/logs/../../etc/shadow', { allowedPrefixes: PREFIXES }),
    ).toBeNull();
    expect(
      validateRemoteLogPath('/etc/shadow', { allowedPrefixes: PREFIXES }),
    ).toBeNull();
  });

  it('rejects shell metacharacters', () => {
    expect(
      validateRemoteLogPath('/mount/RWS4/logs/a;rm -rf.log', { allowedPrefixes: PREFIXES }),
    ).toBeNull();
    expect(
      validateRemoteLogPath('/mount/RWS4/logs/$(id).log', { allowedPrefixes: PREFIXES }),
    ).toBeNull();
  });

  it('rejects paths outside allowlist', () => {
    expect(
      validateRemoteLogPath('/tmp/evil.log', { allowedPrefixes: PREFIXES }),
    ).toBeNull();
  });

  it('can allow paths without log extension when configured', () => {
    expect(
      validateRemoteLogPath('/mount/RWS4/logs/output', {
        allowedPrefixes: PREFIXES,
        requireLogExtension: false,
      }),
    ).toBe('/mount/RWS4/logs/output');
  });
});

describe('validateRemoteCronFilePath', () => {
  it('accepts cron entry under /mount/backup', () => {
    expect(
      validateRemoteCronFilePath('/mount/backup/cronEntry', ['/mount/backup']),
    ).toBe('/mount/backup/cronEntry');
  });

  it('rejects traversal', () => {
    expect(
      validateRemoteCronFilePath('/mount/backup/../etc/passwd', ['/mount/backup']),
    ).toBeNull();
  });
});

describe('sanitizePgrepSearchTerm', () => {
  it('accepts safe script names', () => {
    expect(sanitizePgrepSearchTerm('RunBatch.sh')).toBe('RunBatch.sh');
  });

  it('rejects injection', () => {
    expect(sanitizePgrepSearchTerm("foo'; id #")).toBeNull();
  });
});

describe('sanitizeGrepKey', () => {
  it('accepts WFM script paths', () => {
    expect(sanitizeGrepKey('/mount/RWS4/batch_jobs/foo.sh', '/mount/RWS4')).toBe(
      '/mount/RWS4/batch_jobs/foo.sh',
    );
  });

  it('rejects paths outside prefix', () => {
    expect(sanitizeGrepKey('/etc/passwd', '/mount/RWS4')).toBeNull();
  });
});

describe('shellQuote', () => {
  it('escapes single quotes', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});
