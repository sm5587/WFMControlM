// ============================================================
// CSRF token store — synchronizer token for cookie-authenticated requests
// ============================================================

export const CSRF_HEADER_NAME = 'X-CSRF-Token';

const MUTATING_METHODS = new Set(['post', 'put', 'patch', 'delete']);

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null | undefined): void {
  csrfToken = token?.trim() ? token.trim() : null;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

export function clearCsrfToken(): void {
  csrfToken = null;
}

export function isMutatingMethod(method?: string): boolean {
  return MUTATING_METHODS.has((method || 'get').toLowerCase());
}

export function getCsrfHeaders(): Record<string, string> {
  if (!csrfToken) return {};
  return { [CSRF_HEADER_NAME]: csrfToken };
}
