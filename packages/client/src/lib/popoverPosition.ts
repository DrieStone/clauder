import { useLayoutEffect, useState, type RefObject } from 'react';

/** Horizontal placement for a popover hanging below an anchor: right-aligned to the anchor like
 *  `right-0`, but clamped so the whole panel stays on screen. A plain `absolute right-0` panel runs
 *  off the LEFT edge of a phone when its anchor sits mid-row (the tag editor did exactly that).
 *  Returns `left`/`width` relative to the anchor wrapper (the popover's `relative` parent) rather
 *  than viewport coords, so it still lines up inside App's visual-viewport `transform`, where
 *  `position: fixed` would be offset. Null until measured — callers keep their `right-0` classes
 *  as the fallback, and the layout effect corrects it before first paint. */
export function usePopoverPlacement(
  wrapRef: RefObject<HTMLElement | null>,
  open: boolean,
  width: number,
  margin = 8,
): { left: number; width: number } | null {
  const [placement, setPlacement] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) { setPlacement(null); return; }
    const compute = () => {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const w = Math.min(width, vw - margin * 2);
      const viewportLeft = Math.max(margin, Math.min(r.right - w, vw - w - margin));
      setPlacement({ left: viewportLeft - r.left, width: w });
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [wrapRef, open, width, margin]);

  return placement;
}
