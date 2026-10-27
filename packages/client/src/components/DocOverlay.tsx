import { useEffect } from 'react';
import { createPortal } from 'react-dom';

// A document (PDF or text) opened from the chat, shown over Clauder with a close button that's
// always there. Opening it in a browser tab of its own left no way back in the home-screen app on
// a phone. Escape closes it too.

export function DocOverlay({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div
      className="fixed inset-0 z-[100] bg-gray-950 flex flex-col"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
      role="dialog"
      aria-label={name}
    >
      <div className="flex items-center gap-3 px-3 py-2 border-b border-gray-800 shrink-0">
        <button
          onClick={onClose}
          className="min-h-[44px] px-3 -ml-1 rounded-lg text-sm text-gray-200 bg-gray-800 hover:bg-gray-700 shrink-0"
        >
          ✕ Close
        </button>
        <span className="text-sm text-gray-300 truncate font-medium flex-1 min-w-0">{name}</span>
        <a href={url} download={name} className="text-xs text-gray-500 hover:text-gray-300 shrink-0" title={`Download ${name}`}>
          Download ↓
        </a>
      </div>
      {/* iOS draws a PDF frame at the document's full height, so the box around it scrolls. */}
      <div className="flex-1 min-h-0 overflow-auto [-webkit-overflow-scrolling:touch] bg-white">
        <iframe src={url} title={name} className="w-full h-full border-0 block" />
      </div>
    </div>,
    document.body,
  );
}
