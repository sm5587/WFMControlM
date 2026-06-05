import React from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';

interface SortableHeaderProps {
  column: string;
  label: string;
  sortColumn: string;
  sortDirection: 'asc' | 'desc';
  onSort: (col: string) => void;
  className?: string;
  align?: 'left' | 'right' | 'center';
}

/**
 * Shared sortable <th> element.
 * Click once → ascending, click again → descending.
 */
export function SortableHeader({
  column,
  label,
  sortColumn,
  sortDirection,
  onSort,
  className = '',
  align = 'left',
}: SortableHeaderProps) {
  const isActive = sortColumn === column;
  const alignClass = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';

  return (
    <th
      className={`px-3 py-2 ${alignClass} text-xs font-semibold text-gray-500 uppercase cursor-pointer select-none hover:text-gray-700 transition-colors ${className}`}
      onClick={() => onSort(column)}
    >
      <span className={`inline-flex items-center gap-0.5 ${align === 'right' ? 'justify-end w-full' : ''}`}>
        {label}
        {isActive ? (
          sortDirection === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronDown className="w-3 h-3 opacity-20" />
        )}
      </span>
    </th>
  );
}

/**
 * Minimal hook to manage sort column + direction state.
 * Toggle: same column → flip direction. New column → asc.
 */
export function useSortState(defaultColumn: string, defaultDir: 'asc' | 'desc' = 'asc') {
  const [sort, setSort] = React.useState({ column: defaultColumn, direction: defaultDir });

  const handleSort = React.useCallback((col: string) => {
    setSort((prev) =>
      prev.column === col
        ? { column: col, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { column: col, direction: 'asc' as const }
    );
  }, []);

  return { sortColumn: sort.column, sortDirection: sort.direction, handleSort };
}
