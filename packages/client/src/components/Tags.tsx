import { useState, useRef, useEffect } from 'react';
import type { SessionState, TagDef } from '@clauder/shared';
import { useSessions, useTagRegistry } from '../context/SessionContext';
import { TAG_PALETTE, DEFAULT_TAG_COLOR, tagChipStyle } from '../lib/tagColors';
import { usePopoverPlacement } from '../lib/popoverPosition';

// ─── Chip primitive ────────────────────────────────────────────────────────────

export function TagChip({
  tag,
  onRemove,
  onClick,
  active = true,
  title,
}: {
  tag: TagDef;
  onRemove?: () => void;
  onClick?: () => void;
  active?: boolean;
  title?: string;
}) {
  return (
    <span
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      className={`inline-flex items-center gap-1 max-w-[10rem] whitespace-nowrap text-[10px] leading-3 px-1.5 py-px rounded border ${onClick ? 'cursor-pointer' : ''} ${active ? '' : 'opacity-40'}`}
      style={tagChipStyle(tag.color)}
      title={title ?? tag.label}
    >
      <span className="truncate min-w-0">{tag.label}</span>
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="hover:opacity-70 -mr-0.5"
          aria-label={`Remove ${tag.label}`}
        >
          ✕
        </button>
      )}
    </span>
  );
}

// ─── Primary-tag color (first resolvable tag) — tints cards & switcher tabs ─────────

/** The color of a session's primary (first) tag, or null if it has none. Order in
 *  `config.tags` is the priority order, so the first applied tag wins. */
export function primaryTagColor(session: SessionState, tags: TagDef[]): string | null {
  const ids = session.config.tags;
  if (!ids || ids.length === 0) return null;
  for (const id of ids) {
    const def = tags.find(t => t.id === id);
    if (def) return def.color;
  }
  return null;
}

export function usePrimaryTagColor(session: SessionState): string | null {
  return primaryTagColor(session, useTagRegistry());
}

// ─── Read-only chips for a session (used on cards + header) ───────────────────────

export function SessionTagChips({ session }: { session: SessionState }) {
  const tags = useTagRegistry();
  const ids = session.config.tags;
  if (!ids || ids.length === 0) return null;
  const defs = ids.map(id => tags.find(t => t.id === id)).filter((t): t is TagDef => !!t);
  if (defs.length === 0) return null;
  return (
    <>
      {defs.map(tag => <TagChip key={tag.id} tag={tag} />)}
    </>
  );
}

// ─── Color palette picker ────────────────────────────────────────────────────────

function PalettePicker({ value, onPick }: { value: string; onPick: (color: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5 sm:gap-1 max-w-[220px] sm:max-w-[168px]">
      {TAG_PALETTE.map(c => (
        <button
          key={c}
          onClick={(e) => { e.stopPropagation(); onPick(c); }}
          className={`w-5 h-5 sm:w-4 sm:h-4 rounded-full border ${value === c ? 'ring-2 ring-white/70' : 'border-black/30'}`}
          style={{ backgroundColor: c }}
          aria-label={`Color ${c}`}
        />
      ))}
    </div>
  );
}

// ─── Tag editor popover (header entry point) ──────────────────────────────────────

export function TagControl({ session }: { session: SessionState }) {
  const { state, setTags, createTag, updateTag, deleteTag } = useSessions();
  const [open, setOpen] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newColor, setNewColor] = useState<string>(DEFAULT_TAG_COLOR);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [colorPickerId, setColorPickerId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const placement = usePopoverPlacement(wrapRef, open, 256);

  const applied = new Set(session.config.tags ?? []);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const toggle = (tagId: string) => {
    const next = applied.has(tagId)
      ? (session.config.tags ?? []).filter(t => t !== tagId)
      : [...(session.config.tags ?? []), tagId];
    setTags(session.id, next);
  };

  const addTag = () => {
    const label = newLabel.trim();
    if (!label) return;
    createTag(label, newColor);
    setNewLabel('');
    // Leave color as-is so a batch of related tags can share a hue.
  };

  const count = applied.size;

  return (
    <div className="relative shrink-0" ref={wrapRef}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`text-[10px] border rounded px-1.5 py-1 sm:py-0.5 transition-colors ${count > 0 ? 'text-blue-300 border-blue-500/50' : 'text-gray-500 hover:text-blue-300 border-gray-700 hover:border-blue-500/50'}`}
        title="Tag this session"
      >
        🏷 {count > 0 ? count : 'Tags'}
      </button>

      {open && (
        <div className="absolute z-50 mt-1 right-0 w-64 bg-gray-900 border border-gray-700 rounded-lg shadow-xl p-2 text-xs" style={placement ?? undefined}>
          <div className="text-[10px] uppercase tracking-wider text-gray-500 px-1 pb-1.5">Tags</div>

          <div className="max-h-56 overflow-y-auto flex flex-col gap-0.5">
            {state.tags.length === 0 && (
              <div className="text-gray-600 px-1 py-2">No tags yet — create one below.</div>
            )}
            {state.tags.map(tag => (
              <div key={tag.id} className="flex flex-wrap items-center gap-1.5 px-1 py-1.5 sm:py-0.5 rounded hover:bg-gray-800/60 group">
                <input
                  type="checkbox"
                  checked={applied.has(tag.id)}
                  onChange={() => toggle(tag.id)}
                  className="shrink-0 accent-blue-500"
                />
                <button
                  onClick={() => setColorPickerId(id => id === tag.id ? null : tag.id)}
                  className="w-3.5 h-3.5 rounded-full border border-black/30 shrink-0"
                  style={{ backgroundColor: tag.color }}
                  title="Change color"
                />
                {editingId === tag.id ? (
                  <input
                    autoFocus
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    onBlur={() => { updateTag(tag.id, { label: editLabel }); setEditingId(null); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { updateTag(tag.id, { label: editLabel }); setEditingId(null); }
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    className="flex-1 min-w-0 bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-white outline-none focus:border-blue-500"
                  />
                ) : (
                  <button
                    onClick={() => { setEditingId(tag.id); setEditLabel(tag.label); }}
                    className="flex-1 min-w-0 text-left truncate"
                    style={{ color: tag.color }}
                    title="Click to rename"
                  >
                    {tag.label}
                  </button>
                )}
                <button
                  onClick={() => { if (confirm(`Delete tag "${tag.label}"? It will be removed from all sessions.`)) deleteTag(tag.id); }}
                  className="text-gray-600 hover:text-red-400 shrink-0 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 transition-opacity"
                  aria-label={`Delete ${tag.label}`}
                >
                  🗑
                </button>
                {colorPickerId === tag.id && (
                  <div className="basis-full pl-6 pt-1">
                    <PalettePicker value={tag.color} onPick={(c) => { updateTag(tag.id, { color: c }); setColorPickerId(null); }} />
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="border-t border-gray-800 mt-2 pt-2">
            <div className="flex items-center gap-1.5">
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addTag(); }}
                placeholder="New tag…"
                className="flex-1 min-w-0 bg-gray-800 border border-gray-600 rounded px-1.5 py-1 text-white outline-none focus:border-blue-500"
              />
              <button
                onClick={addTag}
                disabled={!newLabel.trim()}
                className="px-2 py-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded"
              >
                Add
              </button>
            </div>
            <div className="pt-1.5">
              <PalettePicker value={newColor} onPick={setNewColor} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Dashboard filter ─────────────────────────────────────────────────────────────

export function TagFilter({
  selected,
  onToggle,
  onClear,
}: {
  selected: Set<string>;
  onToggle: (tagId: string) => void;
  onClear: () => void;
}) {
  const { state } = useSessions();
  if (state.tags.length === 0) return null;
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {state.tags.map(tag => (
        <TagChip
          key={tag.id}
          tag={tag}
          active={selected.size === 0 || selected.has(tag.id)}
          onClick={() => onToggle(tag.id)}
          title={`Filter by ${tag.label}`}
        />
      ))}
      {selected.size > 0 && (
        <button
          onClick={onClear}
          className="text-[10px] text-gray-500 hover:text-gray-300 px-1"
          title="Clear tag filter"
        >
          clear
        </button>
      )}
    </div>
  );
}
