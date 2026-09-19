import fs from 'fs';
import os from 'os';
import path from 'path';
import { getAppVersion, resetAppVersionCache } from '../../src/utils/app-version';

describe('getAppVersion', () => {
  afterEach(() => {
    resetAppVersionCache();
  });

  it('reads the repo VERSION file', () => {
    const repoVersionPath = path.resolve(__dirname, '../../../VERSION');
    const expected = fs.readFileSync(repoVersionPath, 'utf-8').trim().split('+')[0];
    expect(getAppVersion()).toBe(expected);
  });

  it('prefers VERSION in cwd when present', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfm-version-'));
    try {
      fs.writeFileSync(path.join(dir, 'VERSION'), '9.9.9\n');
      const prev = process.cwd();
      process.chdir(dir);
      resetAppVersionCache();
      expect(getAppVersion()).toBe('9.9.9');
      process.chdir(prev);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
