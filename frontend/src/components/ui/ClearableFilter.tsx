import React from 'react';
import { Search, X } from 'lucide-react';

const DEFAULT_INPUT =
  'w-full py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zebra-300 bg-white';

type ClearableSearchInputProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  title?: string;
  /** Wrapper class (sizing, margins). */
  className?: string;
  /** Override input classes; left/right padding for icons is applied automatically. */
  inputClassName?: string;
  showSearchIcon?: boolean;
  /** Icon size: default 16 (w-4), use 14 for denser bars. */
  iconSize?: number;
};

/** Text/filter text input with an X to clear when non-empty. */
export function ClearableSearchInput({
  value,
  onChange,
  placeholder,
  title,
  className = '',
  inputClassName,
  showSearchIcon = true,
  iconSize = 16,
}: ClearableSearchInputProps) {
  const hasValue = value.length > 0;
  const iconCls = iconSize <= 14 ? 'w-3.5 h-3.5' : 'w-4 h-4';
  const leftPad = showSearchIcon ? (iconSize <= 14 ? 'pl-8' : 'pl-10') : 'pl-3';
  const rightPad = hasValue ? 'pr-8' : 'pr-3';

  return (
    <div className={`relative ${className}`.trim()}>
      {showSearchIcon && (
        <Search
          className={`absolute left-3 top-1/2 -translate-y-1/2 ${iconCls} text-gray-400 pointer-events-none`}
        />
      )}
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        title={title}
        className={inputClassName
          ? `${inputClassName} ${leftPad} ${rightPad}`
          : `${DEFAULT_INPUT} ${leftPad} ${rightPad}`}
      />
      {hasValue && (
        <button
          type="button"
          onClick={() => onChange('')}
          title="Clear filter"
          aria-label="Clear filter"
          className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

type ClearableFilterSelectProps = {
  value: string;
  onChange: (value: string) => void;
  /** Value that means “no filter” (cleared). Default ''. */
  emptyValue?: string;
  className?: string;
  selectClassName?: string;
  title?: string;
  'aria-label'?: string;
  children: React.ReactNode;
};

/** Filter `<select>` with an X to reset to emptyValue when a filter is active. */
export function ClearableFilterSelect({
  value,
  onChange,
  emptyValue = '',
  className = '',
  selectClassName =
    'px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-zebra-300 bg-white',
  title,
  children,
  ...rest
}: ClearableFilterSelectProps) {
  const filtered = value !== emptyValue;
  return (
    <div className={`inline-flex items-center gap-1 ${className}`.trim()}>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        title={title}
        aria-label={rest['aria-label']}
        className={selectClassName}
      >
        {children}
      </select>
      {filtered && (
        <button
          type="button"
          onClick={() => onChange(emptyValue)}
          title="Clear filter"
          aria-label="Clear filter"
          className="p-1.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 shrink-0"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
