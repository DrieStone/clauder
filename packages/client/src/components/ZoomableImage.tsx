import { useRef, useState, useCallback, useEffect } from 'react';

/**
 * An <img> you can pinch-to-zoom (touch), wheel-zoom (desktop), double-tap to
 * toggle zoom, and drag to pan once zoomed. Gesture tracking is built on Pointer
 * Events so one code path covers touch + mouse + trackpad.
 *
 * Why hand-rolled instead of a library: the two image surfaces (the chat lightbox
 * and the file viewer) are the only consumers, and pulling in a pan/zoom dep for
 * two call sites isn't worth the bundle. The math is small and lives here.
 *
 * `touch-action: none` on the container is load-bearing — without it the browser
 * claims the pinch/drag for native page zoom/scroll and our handlers never see it.
 */

const MAX_SCALE = 6;
const MIN_SCALE = 1;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SCALE = 2.5;

interface Transform {
  scale: number;
  x: number;
  y: number;
}

const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };

export function ZoomableImage({
  src,
  alt,
  className,
  onError,
  onDismiss,
}: {
  src: string;
  alt: string;
  className?: string;
  onError?: () => void;
  /** When set, a clean single tap on the (un-zoomed) image invokes this — used by
   *  the lightbox so tapping the photo closes it, the way mobile lightboxes do. */
  onDismiss?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [t, setT] = useState<Transform>(IDENTITY);

  // Active pointers (id -> last client position) and gesture bookkeeping, all in
  // refs so mid-gesture updates don't trigger re-renders.
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStart = useRef<{ dist: number; scale: number; midX: number; midY: number; tx: number; ty: number } | null>(null);
  const panStart = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const lastTap = useRef<number>(0);
  // Pending single-tap action, held for DOUBLE_TAP_MS so a second tap can promote
  // it to a double-tap (zoom) instead. Cleared on unmount.
  const singleTapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether the gesture moved, so a clean tap is distinguished from a drag.
  const moved = useRef(false);

  // Clamp translation to the image's own scaled size: along any axis where the zoomed image is
  // larger than the viewer it keeps covering it edge to edge; where it's smaller it stays centred.
  // (Clamping against the container let a wide image be panned entirely out of view — a black
  // screen with nothing left to grab.)
  const clamp = useCallback((next: Transform): Transform => {
    const el = containerRef.current;
    const img = imgRef.current;
    if (!el || !img) return next;
    const maxX = Math.max(0, (img.offsetWidth * next.scale - el.clientWidth) / 2);
    const maxY = Math.max(0, (img.offsetHeight * next.scale - el.clientHeight) / 2);
    return {
      scale: next.scale,
      x: Math.max(-maxX, Math.min(maxX, next.x)),
      y: Math.max(-maxY, Math.min(maxY, next.y)),
    };
  }, []);

  const zoomAt = useCallback((clientX: number, clientY: number, nextScale: number, base: Transform) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    // Keep the point under the cursor fixed while scaling around the element center.
    const px = clientX - cx;
    const py = clientY - cy;
    const ratio = nextScale / base.scale;
    setT(clamp({
      scale: nextScale,
      x: px - (px - base.x) * ratio,
      y: py - (py - base.y) * ratio,
    }));
  }, [clamp]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // A primary pointer means no other finger is down, so anything still tracked is left over from
    // a pointerup/cancel we never received — drop it, or every later touch reads as a pinch.
    if (e.isPrimary) {
      pointers.current.clear();
      pinchStart.current = null;
      panStart.current = null;
    }
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved.current = false;

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      // Floored: two touches reported at ~the same point would make the pinch ratio divide by ~0.
      const dist = Math.max(8, Math.hypot(a.x - b.x, a.y - b.y));
      pinchStart.current = {
        dist,
        scale: t.scale,
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
        tx: t.x,
        ty: t.y,
      };
      panStart.current = null;
    } else if (pointers.current.size === 1 && t.scale > 1) {
      panStart.current = { x: e.clientX, y: e.clientY, tx: t.x, ty: t.y };
    }
  }, [t]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2 && pinchStart.current) {
      moved.current = true;
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const ps = pinchStart.current;
      const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, (ps.scale * dist) / ps.dist));
      zoomAt(ps.midX, ps.midY, nextScale, { scale: ps.scale, x: ps.tx, y: ps.ty });
    } else if (pointers.current.size === 1 && panStart.current) {
      // Read the ref once, here. React can run the updater below later — after a pointerup has
      // already nulled panStart — and reading the ref inside it then threw mid-render, which (with
      // no error boundary) unmounted the entire app: the black, frozen screen on iOS.
      const start = panStart.current;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved.current = true;
      setT(prev => clamp({ scale: prev.scale, x: start.tx + dx, y: start.ty + dy }));
    }
  }, [zoomAt, clamp]);

  const endPointer = useCallback((e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchStart.current = null;
    if (pointers.current.size === 0) panStart.current = null;
  }, []);

  // Double-tap / double-click toggles between fit and a fixed zoom, centered on
  // the tap. A clean single tap (no drag): when zoomed it resets to fit, otherwise
  // it dismisses (if onDismiss was given). The single-tap action is deferred by
  // DOUBLE_TAP_MS so a second tap can supersede it as a double-tap zoom.
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const wasMoved = moved.current;
    endPointer(e);
    if (wasMoved) return;
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      // Second tap → double-tap: cancel the pending single-tap action and zoom.
      lastTap.current = 0;
      if (singleTapTimer.current) { clearTimeout(singleTapTimer.current); singleTapTimer.current = null; }
      if (t.scale > 1) setT(IDENTITY);
      else zoomAt(e.clientX, e.clientY, DOUBLE_TAP_SCALE, IDENTITY);
      return;
    }
    lastTap.current = now;
    const zoomed = t.scale > 1;
    if (singleTapTimer.current) clearTimeout(singleTapTimer.current);
    singleTapTimer.current = setTimeout(() => {
      singleTapTimer.current = null;
      if (zoomed) setT(IDENTITY);
      else onDismiss?.();
    }, DOUBLE_TAP_MS);
  }, [t.scale, zoomAt, endPointer, onDismiss]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey && t.scale === 1) return; // let the page scroll when not zooming
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, t.scale * factor));
    if (nextScale === 1) setT(IDENTITY);
    else zoomAt(e.clientX, e.clientY, nextScale, t);
  }, [t, zoomAt]);

  // Reset zoom if the image source changes (e.g. navigating between files).
  useEffect(() => { setT(IDENTITY); }, [src]);

  // Don't fire a deferred single-tap after the component is gone.
  useEffect(() => () => { if (singleTapTimer.current) clearTimeout(singleTapTimer.current); }, []);

  return (
    <div
      ref={containerRef}
      className="w-full h-full flex items-center justify-center overflow-hidden"
      style={{ touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={endPointer}
      onWheel={onWheel}
    >
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        onError={onError}
        draggable={false}
        className={className}
        style={{
          transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`,
          transition: pinchStart.current || panStart.current ? 'none' : 'transform 0.15s ease-out',
          cursor: t.scale > 1 ? 'grab' : 'zoom-in',
          touchAction: 'none',
        }}
      />
    </div>
  );
}
