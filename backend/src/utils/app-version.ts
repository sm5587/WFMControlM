import fs from 'fs';
import path from 'path';

let cached: string | undefined;

function readVersionFile(filePath: string): string | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) return null;
    // Support full build labels like 1.0.0+acbafac.20260616T062000Z
    const base = raw.split('+')[0].split('\n')[0].trim();
    return base || null;
  } catch {
    return null;
  }
}

function readPackageVersion(): string | null {
  try {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : null;
  } catch {
    return null;
  }
}

/** App release version — reads repo VERSION file, falls back to backend package.json. */
export function getAppVersion(): string {
  if (cached) return cached;

  const candidates = [
    path.resolve(process.cwd(), 'VERSION'),
    path.resolve(__dirname, '../../../VERSION'),
    path.resolve(__dirname, '../../VERSION'),
  ];

  for (const candidate of candidates) {
    const version = readVersionFile(candidate);
    if (version) {
      cached = version;
      return version;
    }
  }

  cached = readPackageVersion() || '0.0.0';
  return cached;
}

/** Test helper — clears module-level cache between test cases. */
export function resetAppVersionCache(): void {
  cached = undefined;
}
