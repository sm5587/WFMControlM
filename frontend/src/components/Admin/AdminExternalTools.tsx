import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  GripVertical,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';
import { adminApi, configApi } from '../../services/api';
import { useConfig } from '../../contexts/ConfigContext';
import { EXTERNAL_TOOLS_KEY } from '../../constants/app-display';
import {
  type ExternalTool,
  parseExternalToolsForEdit,
  serializeExternalTools,
} from '../../utils/externalTools';
import ExternalToolIconPicker from './ExternalToolIconPicker';
import ExternalToolProfilesPicker from './ExternalToolProfilesPicker';

const COLLAPSE_STORAGE_KEY = 'wfm.admin.externalTools.collapsed';

type DraftTool = ExternalTool & { id: string };

function newId(): string {
  return `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function toDraft(tools: ExternalTool[]): DraftTool[] {
  return tools.map((t) => ({
    id: newId(),
    label: t.label,
    url: t.url,
    icon: t.icon || 'link',
    enabled: t.enabled !== false,
    profileIds: t.profileIds ?? [],
  }));
}

function emptyDraft(): DraftTool {
  return { id: newId(), label: '', url: '', icon: 'link', enabled: true, profileIds: [] };
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export default function AdminExternalTools() {
  const queryClient = useQueryClient();
  const { reload: reloadConfig } = useConfig();
  const [drafts, setDrafts] = useState<DraftTool[]>([]);
  const [baseline, setBaseline] = useState('[]');
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['admin-config'],
    queryFn: async () => {
      const res = await configApi.getAll();
      const data = res.data;
      if (data && !Array.isArray(data)) return Object.values(data) as Array<{ key: string; value: string }>;
      return (data ?? []) as Array<{ key: string; value: string }>;
    },
  });

  const { data: profiles = [] } = useQuery({
    queryKey: ['admin-profiles'],
    queryFn: async () => {
      const res = await adminApi.getProfiles();
      return (res.data ?? []).map((p) => ({ id: p.id, name: p.name }));
    },
  });

  const storedValue = useMemo(() => {
    const row = rows.find((r) => r.key === EXTERNAL_TOOLS_KEY);
    return row?.value ?? '[]';
  }, [rows]);

  useEffect(() => {
    setBaseline(storedValue);
    setDrafts(toDraft(parseExternalToolsForEdit(storedValue)));
  }, [storedValue]);

  const serialized = useMemo(
    () =>
      serializeExternalTools(
        drafts.map(({ label, url, icon, enabled, profileIds }) => ({
          label,
          url,
          icon,
          enabled,
          profileIds: profileIds?.length ? profileIds : undefined,
        })),
      ),
    [drafts],
  );

  const dirty = serialized !== baseline;

  const saveMutation = useMutation({
    mutationFn: () => configApi.update([{ key: EXTERNAL_TOOLS_KEY, value: serialized }]),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-config'] });
      reloadConfig();
      setBaseline(serialized);
      setToast({ type: 'success', msg: 'External tools saved.' });
      setTimeout(() => setToast(null), 4000);
    },
    onError: (err: any) => {
      setToast({
        type: 'error',
        msg: err?.message || err?.response?.data?.error || 'Save failed',
      });
      setTimeout(() => setToast(null), 6000);
    },
  });

  const updateDraft = (id: string, patch: Partial<DraftTool>) => {
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  };

  const removeDraft = (id: string) => {
    setDrafts((prev) => prev.filter((d) => d.id !== id));
  };

  const handleSave = () => {
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i];
      if (!d.label.trim()) {
        setToast({ type: 'error', msg: `Row ${i + 1}: Label is required` });
        setTimeout(() => setToast(null), 5000);
        return;
      }
      if (!d.url.trim()) {
        setToast({ type: 'error', msg: `Row ${i + 1}: URL is required` });
        setTimeout(() => setToast(null), 5000);
        return;
      }
      if (!/^https?:\/\//i.test(d.url.trim())) {
        setToast({
          type: 'error',
          msg: `Row ${i + 1}: URL must start with http:// or https://`,
        });
        setTimeout(() => setToast(null), 5000);
        return;
      }
    }
    saveMutation.mutate();
  };

  const onDragStart = (index: number) => setDragIndex(index);
  const onDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (dragIndex === null || dragIndex === index) return;
    setDrafts((prev) => {
      const next = [...prev];
      const [moved] = next.splice(dragIndex, 1);
      next.splice(index, 0, moved);
      return next;
    });
    setDragIndex(index);
  };
  const onDragEnd = () => setDragIndex(null);

  if (isLoading) return null;

  const enabledCount = drafts.filter((d) => d.enabled !== false).length;
  const summary =
    drafts.length === 0
      ? 'No tools configured'
      : `${drafts.length} tool${drafts.length === 1 ? '' : 's'}${
          enabledCount !== drafts.length ? ` · ${enabledCount} shown` : ''
        }`;

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div
        className={`px-4 py-3 flex items-center justify-between gap-3 flex-wrap ${
          collapsed ? '' : 'border-b border-gray-100'
        }`}
      >
        <button
          type="button"
          onClick={toggleCollapsed}
          className="flex items-start gap-2 text-left min-w-0 flex-1 hover:opacity-90"
          aria-expanded={!collapsed}
        >
          <span className="mt-0.5 text-gray-400 flex-shrink-0">
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-gray-800 flex items-center gap-2 flex-wrap">
              <ExternalLink className="w-4 h-4 text-zebra-600 flex-shrink-0" />
              External Tools Menu
              <span className="text-[11px] font-medium text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">
                {summary}
              </span>
              {dirty && (
                <span className="text-[11px] font-medium text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">
                  Unsaved
                </span>
              )}
            </h2>
            {!collapsed && (
              <p className="text-xs text-gray-500 mt-0.5">
                Links shown in the top-bar apps grid. Restrict each tool to selected profiles, or leave as All users.
              </p>
            )}
          </div>
        </button>
        <div className="flex items-center gap-2">
          {!collapsed && (
            <button
              type="button"
              onClick={() => setDrafts((prev) => [...prev, emptyDraft()])}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium border border-gray-200 text-gray-700 hover:bg-gray-50"
            >
              <Plus className="w-3.5 h-3.5" />
              Add tool
            </button>
          )}
          {dirty && (
            <button
              type="button"
              onClick={handleSave}
              disabled={saveMutation.isPending}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium bg-zebra-500 text-white hover:bg-zebra-600 disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />
              {saveMutation.isPending ? 'Saving…' : 'Save tools'}
            </button>
          )}
        </div>
      </div>

      {!collapsed && toast && (
        <div
          className={`mx-4 mt-3 flex items-center gap-2 px-3 py-2 rounded text-xs border ${
            toast.type === 'success'
              ? 'bg-green-50 text-green-700 border-green-200'
              : 'bg-red-50 text-red-700 border-red-200'
          }`}
        >
          {toast.type === 'success' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
          {toast.msg}
        </div>
      )}

      {!collapsed && (
      <div className="p-4">
        {drafts.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-6">
            No tools yet. Click <span className="font-medium">Add tool</span> to wire your first link.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="hidden lg:grid grid-cols-[28px_minmax(120px,1fr)_minmax(160px,1.4fr)_140px_minmax(140px,1fr)_72px_36px] gap-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
              <span />
              <span>Label</span>
              <span>URL</span>
              <span>Icon</span>
              <span>Profiles</span>
              <span>Show</span>
              <span />
            </div>
            {drafts.map((draft, index) => (
              <div
                key={draft.id}
                draggable
                onDragStart={() => onDragStart(index)}
                onDragOver={(e) => onDragOver(e, index)}
                onDragEnd={onDragEnd}
                className={`grid grid-cols-1 lg:grid-cols-[28px_minmax(120px,1fr)_minmax(160px,1.4fr)_140px_minmax(140px,1fr)_72px_36px] gap-2 items-center rounded-md border px-2 py-2 ${
                  dragIndex === index ? 'border-zebra-300 bg-zebra-50/40' : 'border-gray-100 bg-gray-50/50'
                }`}
              >
                <button
                  type="button"
                  className="justify-self-center text-gray-300 hover:text-gray-500 cursor-grab active:cursor-grabbing p-1"
                  title="Drag to reorder"
                  aria-label="Drag to reorder"
                >
                  <GripVertical className="w-4 h-4" />
                </button>

                <input
                  type="text"
                  value={draft.label}
                  onChange={(e) => updateDraft(draft.id, { label: e.target.value })}
                  placeholder="e.g. Globalisation Tool"
                  className="w-full bg-white border border-gray-200 rounded px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-zebra-400"
                />

                <input
                  type="url"
                  value={draft.url}
                  onChange={(e) => updateDraft(draft.id, { url: e.target.value })}
                  placeholder="http://10.123.33.40:8501"
                  className="w-full bg-white border border-gray-200 rounded px-2 py-1.5 text-sm font-mono outline-none focus:ring-1 focus:ring-zebra-400"
                />

                <ExternalToolIconPicker
                  value={draft.icon || 'link'}
                  onChange={(icon) => updateDraft(draft.id, { icon })}
                />

                <ExternalToolProfilesPicker
                  value={draft.profileIds ?? []}
                  options={profiles}
                  onChange={(profileIds) => updateDraft(draft.id, { profileIds })}
                />

                <label className="flex items-center gap-1.5 text-xs text-gray-600 justify-self-start lg:justify-self-center">
                  <input
                    type="checkbox"
                    checked={draft.enabled !== false}
                    onChange={(e) => updateDraft(draft.id, { enabled: e.target.checked })}
                    className="rounded border-gray-300 text-zebra-600 focus:ring-zebra-500"
                  />
                  On
                </label>

                <button
                  type="button"
                  onClick={() => removeDraft(draft.id)}
                  title="Remove tool"
                  className="justify-self-center p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      )}
    </div>
  );
}
