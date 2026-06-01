import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfig } from '../contexts/ConfigContext';

/**
 * useResizablePanel — drag-to-resize a sidebar panel.
 *
 * @param storageKey  localStorage key to persist the width
 * @param defaultPx   fallback width in pixels
 * @param minPx       minimum draggable width (overridden by config)
 * @param maxPx       maximum draggable width (overridden by config)
 * @param side        'left' (drag handle on right edge) | 'right' (drag handle on left edge, inverse direction)
 * @returns { width, dragHandleProps }  — apply dragHandleProps to the divider element
 */
export function useResizablePanel(
  storageKey: string,
  defaultPx: number,
  minPx = 160,
  maxPx = 700,
  side: 'left' | 'right' = 'left',
) {
  const { getInt } = useConfig();
  const resolvedMin = getInt('display.panelMinWidth', minPx);
  const resolvedMax = getInt('display.panelMaxWidth', maxPx);
  const stored = typeof window !== 'undefined' ? localStorage.getItem(storageKey) : null;
  const [width, setWidth] = useState<number>(stored ? Number(stored) : defaultPx);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - startX.current;
      const adjusted = side === 'right' ? -delta : delta;
      const next = Math.min(resolvedMax, Math.max(resolvedMin, startWidth.current + adjusted));
      setWidth(next);
    },
    [resolvedMin, resolvedMax, side],
  );

  const onMouseUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    setWidth(w => {
      localStorage.setItem(storageKey, String(w));
      return w;
    });
  }, [storageKey]);

  useEffect(() => {
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [onMouseMove, onMouseUp]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      startX.current = e.clientX;
      startWidth.current = width;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width],
  );

  const dragHandleProps = {
    onMouseDown,
    style: {
      cursor: 'col-resize',
      width: '5px',
      flexShrink: 0,
    } as React.CSSProperties,
    className:
      'w-1.5 flex-shrink-0 bg-transparent hover:bg-zebra-300 active:bg-zebra-400 transition-colors cursor-col-resize select-none',
  };

  return { width, dragHandleProps };
}
