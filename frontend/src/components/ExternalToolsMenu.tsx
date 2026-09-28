import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Grid3x3 } from 'lucide-react';
import { useConfig } from '../contexts/ConfigContext';
import {
  DEFAULT_EXTERNAL_TOOLS_JSON,
  EXTERNAL_TOOLS_KEY,
} from '../constants/app-display';
import { parseExternalTools, isExternalToolVisibleToUser } from '../utils/externalTools';
import { resolveExternalToolIcon } from '../utils/externalToolIcons';
import { useAuth } from '../context/AuthContext';

export default function ExternalToolsMenu() {
  const { getString } = useConfig();
  const { user } = useAuth();
  const raw = getString(EXTERNAL_TOOLS_KEY, DEFAULT_EXTERNAL_TOOLS_JSON);
  const tools = useMemo(() => {
    const all = parseExternalTools(raw);
    return all.filter((tool) =>
      isExternalToolVisibleToUser(tool, user?.profileIds, user?.isMaster),
    );
  }, [raw, user?.profileIds, user?.isMaster]);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (tools.length === 0) return null;

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Apps & tools"
        aria-expanded={open}
        aria-haspopup="menu"
        className={`p-1.5 rounded-md transition-colors flex-shrink-0 ${
          open
            ? 'bg-zebra-50 text-zebra-700'
            : 'text-gray-400 hover:text-gray-700 hover:bg-gray-100'
        }`}
      >
        <Grid3x3 className="w-4 h-4" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-2 z-50 w-72 rounded-lg border border-gray-200 bg-white shadow-lg overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-gray-100">
            <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
              Apps & tools
            </p>
          </div>
          <div className="p-2 grid grid-cols-3 gap-1 max-h-80 overflow-y-auto">
            {tools.map((tool) => {
              const Icon = resolveExternalToolIcon(tool.icon);
              return (
                <a
                  key={`${tool.label}:${tool.url}`}
                  href={tool.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  role="menuitem"
                  onClick={() => setOpen(false)}
                  className="flex flex-col items-center gap-1.5 rounded-md px-2 py-2.5 text-center hover:bg-gray-50 transition-colors"
                  title={tool.url}
                >
                  <span className="w-9 h-9 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center">
                    <Icon className="w-4 h-4" />
                  </span>
                  <span className="text-[11px] font-medium text-gray-700 leading-tight line-clamp-2">
                    {tool.label}
                  </span>
                </a>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
