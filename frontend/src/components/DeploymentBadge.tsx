/** Subtitle under app name: deployment label (Local / Docker), not browser hostname. */
export function deploymentHint(label: string): string {
  const trimmed = label.trim();
  return trimmed || 'Local';
}

/** @deprecated Prefer deploymentHint(useDeploymentLabel()) — kept for port-specific tooling. */
export function instanceUrlHint(): string {
  if (typeof window === 'undefined') return '';
  const { hostname, port } = window.location;
  return port ? `${hostname}:${port}` : hostname;
}
