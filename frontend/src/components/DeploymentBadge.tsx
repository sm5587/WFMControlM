/** Full host:port for the current instance (e.g. localhost:3005 vs localhost:3015). */
export function instanceUrlHint(): string {
  if (typeof window === 'undefined') return '';
  const { hostname, port } = window.location;
  return port ? `${hostname}:${port}` : hostname;
}
