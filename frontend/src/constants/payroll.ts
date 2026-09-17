export const FREQUENCY_ORDER = ['WK', 'BW', 'SM', 'GM'] as const;

export const FREQUENCY_LABELS: Record<string, { label: string; color: string }> = {
  WK: { label: 'Weekly', color: 'bg-blue-500' },
  BW: { label: 'Bi-Weekly', color: 'bg-indigo-500' },
  SM: { label: 'Semi-Monthly', color: 'bg-purple-500' },
  GM: { label: 'Gregorian Month', color: 'bg-teal-500' },
};

export function normalizeFrequency(raw: string | null | undefined): string {
  const u = (raw || '').trim().toUpperCase();
  if (!u) return '';
  if (u === 'WK' || u === 'WEEKLY') return 'WK';
  if (u === 'BW' || u === 'BI-WEEKLY' || u === 'BIWEEKLY') return 'BW';
  if (u === 'SM' || u === 'SEMI-MONTHLY' || u === 'SEMIMONTHLY') return 'SM';
  if (u === 'GM' || u === 'MONTHLY' || u === 'QUARTERLY' || u === 'GREGORIAN MONTH') return 'GM';
  return u;
}

export function parseFrequencies(raw: string | null | undefined, list?: string[]): string[] {
  const source = list && list.length ? list.join(',') : raw;
  const parts = (source || '')
    .split(/[,|;/\s]+/)
    .map(p => normalizeFrequency(p))
    .filter(Boolean);
  const unique = [...new Set(parts)];
  const ordered = FREQUENCY_ORDER.filter(k => unique.includes(k));
  const extra = unique.filter(k => !(FREQUENCY_ORDER as readonly string[]).includes(k));
  return ordered.length || extra.length ? [...ordered, ...extra] : ['WK'];
}

export function formatYyyymmdd(ymd: string): string {
  const s = toYyyymmdd(ymd);
  if (!/^\d{8}$/.test(s)) return ymd || '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[parseInt(s.slice(4, 6), 10) - 1] || s.slice(4, 6);
  return `${s.slice(6, 8)} ${month} ${s.slice(0, 4)}`;
}

function toYyyymmdd(raw: string | null | undefined): string {
  const s = (raw || '').trim();
  if (!s) return '';
  if (/^\d{8}$/.test(s)) return s;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}${iso[2]}${iso[3]}`;
  const digits = s.replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(0, 8) : '';
}

export function fileGenLabel(value: string | null | undefined): string {
  const u = (value || '').trim().toUpperCase();
  if (u === 'SINGLE_STORE') return 'Single store';
  if (u === 'ALL_STORE') return 'All stores';
  return u || '—';
}
