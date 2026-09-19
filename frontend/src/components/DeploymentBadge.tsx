/** Subtitle under app name: deployment label (Local / Docker), not browser hostname. */
export function deploymentHint(label: string): string {
  const trimmed = label.trim();
  return trimmed || 'Local';
}

/** Subtitle with optional release version, e.g. "Docker · v1.0.0". */
export function appSubtitle(label: string, version?: string): string {
  const hint = deploymentHint(label);
  const v = version?.trim();
  return v ? `${hint} · v${v}` : hint;
}

/** @deprecated Prefer deploymentHint(useDeploymentLabel()) — kept for port-specific tooling. */
export function instanceUrlHint(): string {
  if (typeof window === 'undefined') return '';
  const { hostname, port } = window.location;
  return port ? `${hostname}:${port}` : hostname;
}
