/** Normalize ticket-style `{0}` placeholders to app-style `{{username}}`. */
export function normalizeLdapUsernamePlaceholder(template: string): string {
  return template.replace(/\{0\}/g, '{{username}}');
}

export function escapeLdapFilter(value: string): string {
  return value.replace(/[\\*()\0]/g, (ch) => {
    const hex = ch.charCodeAt(0).toString(16).padStart(2, '0');
    return `\\${hex}`;
  });
}

/** Apply username to filter or DN pattern. Filters escape LDAP metacharacters; DNs do not. */
export function applyLdapUsernameTemplate(
  template: string,
  username: string,
  options?: { escapeFilter?: boolean },
): string {
  const normalized = normalizeLdapUsernamePlaceholder(template);
  const bare = username.trim().includes('@') ? username.trim().split('@')[0] : username.trim();
  const safe = options?.escapeFilter === false ? bare : escapeLdapFilter(bare);
  return normalized.replace(/\{\{username\}\}/g, safe);
}

export function applyLdapDnPattern(pattern: string, username: string): string {
  return applyLdapUsernameTemplate(pattern, username, { escapeFilter: false });
}
