import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Users } from 'lucide-react';

export type ProfileOption = { id: string; name: string };

type Props = {
  value: string[];
  options: ProfileOption[];
  onChange: (profileIds: string[]) => void;
  disabled?: boolean;
};

type MenuPos = { top: number; left: number; width: number };

/**
 * Multi-select for which profiles may see an external tool.
 * Empty selection = all authenticated users.
 */
export default function ExternalToolProfilesPicker({
  value,
  options,
  onChange,
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = new Set(value);
  const allUsers = value.length === 0;

  const label = allUsers
    ? 'All users'
    : value.length === 1
      ? (options.find((o) => o.id === value[0])?.name ?? '1 profile')
      : `${value.length} profiles`;

  const updatePosition = () => {
    const btn = buttonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const menuHeight = Math.min(280, 48 + options.length * 36);
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < menuHeight && rect.top > spaceBelow;
    setPos({
      top: openUp ? rect.top - menuHeight - 4 : rect.bottom + 4,
      left: rect.left,
      width: Math.max(rect.width, 220),
    });
  };

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    updatePosition();
  }, [open, options.length]);

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

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  };

  return (
    <div className="relative min-w-0">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 bg-white border border-gray-200 rounded px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-zebra-400 hover:bg-gray-50 disabled:opacity-50"
        aria-expanded={open}
        aria-haspopup="listbox"
        title={allUsers ? 'Visible to all authenticated users' : `Visible to: ${label}`}
      >
        <Users className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
        <span className="truncate flex-1 text-left text-gray-700">{label}</span>
        <ChevronDown className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-multiselectable
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              width: pos.width,
              zIndex: 9999,
            }}
            className="max-h-70 overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg py-1"
          >
            <button
              type="button"
              onClick={() => onChange([])}
              className={`w-full flex items-center gap-2 px-2 py-1.5 text-sm text-left hover:bg-gray-50 ${
                allUsers ? 'bg-zebra-50 text-zebra-800' : 'text-gray-700'
              }`}
            >
              <span className="flex-1">All users</span>
              {allUsers && <Check className="w-3.5 h-3.5 text-zebra-600 flex-shrink-0" />}
            </button>
            <div className="border-t border-gray-100 my-1" />
            {options.length === 0 ? (
              <p className="px-2 py-2 text-xs text-gray-400">No profiles loaded</p>
            ) : (
              options.map((opt) => {
                const isSelected = selected.has(opt.id);
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => toggle(opt.id)}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 text-sm text-left hover:bg-gray-50 ${
                      isSelected ? 'bg-zebra-50 text-zebra-800' : 'text-gray-700'
                    }`}
                  >
                    <span className="flex-1 truncate">{opt.name}</span>
                    {isSelected && <Check className="w-3.5 h-3.5 text-zebra-600 flex-shrink-0" />}
                  </button>
                );
              })
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
