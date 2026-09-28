export type ExternalTool = {
  label: string;
  url: string;
  icon?: string;
  enabled?: boolean;
  /**
   * Profile IDs allowed to see this tool.
   * Empty / omitted = visible to every authenticated user.
   */
  profileIds?: string[];
};

export const EXTERNAL_TOOL_ICON_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'link', label: 'Link' },
  { value: 'globe', label: 'Globe / Global' },
  { value: 'ticket', label: 'Ticket / JIRA' },
  { value: 'headset', label: 'Support / ServiceNow' },
  { value: 'github', label: 'GitHub' },
  { value: 'book', label: 'Wiki / Docs' },
  { value: 'search', label: 'Search / Sonar' },
  { value: 'box', label: 'Artifactory' },
  { value: 'server', label: 'Server / Polarion' },
  { value: 'shield', label: 'Security' },
  { value: 'wrench', label: 'Tools' },
  { value: 'chat', label: 'Chat / GPT' },
  { value: 'grid', label: 'Apps' },
];

function normalizeProfileIds(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const ids = raw
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map((id) => id.trim());
  return ids.length > 0 ? [...new Set(ids)] : undefined;
}

function normalizeTool(row: Record<string, unknown>): ExternalTool | null {
  if (typeof row.label !== 'string' || !row.label.trim()) return null;
  if (typeof row.url !== 'string' || !row.url.trim()) return null;
  const profileIds = normalizeProfileIds(row.profileIds);
  return {
    label: row.label.trim(),
    url: row.url.trim(),
    icon: typeof row.icon === 'string' ? row.icon.trim() : undefined,
    enabled: row.enabled === false ? false : true,
    ...(profileIds ? { profileIds } : {}),
  };
}

/** Parse for waffle menu — skips disabled / invalid entries. */
export function parseExternalTools(raw: string | undefined | null): ExternalTool[] {
  return parseExternalToolsForEdit(raw).filter((t) => t.enabled !== false);
}

/** Parse for Admin editor — keeps disabled tools. */
export function parseExternalToolsForEdit(raw: string | undefined | null): ExternalTool[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const tools: ExternalTool[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const tool = normalizeTool(item as Record<string, unknown>);
      if (tool) tools.push(tool);
    }
    return tools;
  } catch {
    return [];
  }
}

export function serializeExternalTools(tools: ExternalTool[]): string {
  const cleaned = tools.map((t) => {
    const row: ExternalTool = {
      label: t.label.trim(),
      url: t.url.trim(),
      enabled: t.enabled !== false,
    };
    if (t.icon?.trim()) row.icon = t.icon.trim();
    if (t.profileIds?.length) row.profileIds = [...new Set(t.profileIds.filter(Boolean))];
    return row;
  });
  return JSON.stringify(cleaned);
}

/** Whether a tool should appear for the current user. */
export function isExternalToolVisibleToUser(
  tool: ExternalTool,
  userProfileIds: string[] | undefined,
  isMaster?: boolean,
): boolean {
  if (tool.enabled === false) return false;
  if (isMaster) return true;
  if (!tool.profileIds?.length) return true;
  if (!userProfileIds?.length) return false;
  const allowed = new Set(tool.profileIds);
  return userProfileIds.some((id) => allowed.has(id));
}
