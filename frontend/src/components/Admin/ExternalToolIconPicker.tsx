import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { EXTERNAL_TOOL_ICON_OPTIONS } from '../../utils/externalTools';
import { resolveExternalToolIcon } from '../../utils/externalToolIcons';

type Props = {
  value: string;
  onChange: (value: string) => void;
};

type MenuPos = { top: number; left: number; width: number };

/** Icon dropdown that shows the actual Lucide glyph for each option. */
export default function ExternalToolIconPicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const selected = useMemo(
    () => EXTERNAL_TOOL_ICON_OPTIONS.find((o) => o.value === value) ?? EXTERNAL_TOOL_ICON_OPTIONS[0],
    [value],
  );
  const SelectedIcon = resolveExternalToolIcon(selected.value);

  const updatePosition = () => {
    const btn = buttonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const menuHeight = Math.min(256, EXTERNAL_TOOL_ICON_OPTIONS.length * 40 + 8);
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < menuHeight && rect.top > spaceBelow;
    setPos({
      top: openUp ? rect.top - menuHeight - 4 : rect.bottom + 4,
      left: rect.left,
      width: Math.max(rect.width, 180),
    });
  };

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    updatePosition();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onReposition = () => updatePosition();
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 bg-white border border-gray-200 rounded px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-zebra-400 hover:bg-gray-50"
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className="w-6 h-6 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center flex-shrink-0">
          <SelectedIcon className="w-3.5 h-3.5" />
        </span>
        <span className="truncate flex-1 text-left text-gray-700">{selected.label}</span>
        <ChevronDown className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
      </button>

      {open &&
        pos &&
        createPortal(
          <ul
            ref={menuRef}
            role="listbox"
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              width: pos.width,
              zIndex: 9999,
            }}
            className="max-h-64 overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg py-1"
          >
            {EXTERNAL_TOOL_ICON_OPTIONS.map((opt) => {
              const Icon = resolveExternalToolIcon(opt.value);
              const isSelected = opt.value === selected.value;
              return (
                <li key={opt.value} role="option" aria-selected={isSelected}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 text-sm text-left hover:bg-gray-50 ${
                      isSelected ? 'bg-zebra-50 text-zebra-800' : 'text-gray-700'
                    }`}
                  >
                    <span className="w-7 h-7 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center flex-shrink-0">
                      <Icon className="w-3.5 h-3.5" />
                    </span>
                    <span className="flex-1 truncate">{opt.label}</span>
                    {isSelected && <Check className="w-3.5 h-3.5 text-zebra-600 flex-shrink-0" />}
                  </button>
                </li>
              );
            })}
          </ul>,
          document.body,
        )}
    </div>
  );
}
