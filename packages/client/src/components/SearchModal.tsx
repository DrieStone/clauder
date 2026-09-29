import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { SearchResponse, SearchScope, SessionHit, FileHit } from '@clauder/shared';
import { useSessions } from '../context/SessionContext';
import { fetchSearch } from '../lib/search';
import { FileViewer } from './FileViewer';

interface Props { onClose: () => void }

const DEBOUNCE_MS = 250;

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}
function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

type Row =
  | { kind: 'session'; hit: SessionHit }
  | { kind: 'file'; hit: FileHit };

function highlightMs(tookMs: number): string {
  return tookMs < 1000 ? `${tookMs}ms` : `${(tookMs / 1000).toFixed(1)}s`;
}

function SessionRow({ hit, active, onOpen }: { hit: SessionHit; active: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`w-full text-left px-3 py-2.5 min-h-[44px] flex flex-col gap-0.5 border-b border-gray-800/60 last:border-b-0 transition-colors ${
        active ? 'bg-blue-900/30' : 'hover:bg-gray-800/60'
      }`}
    >
      <div className="flex items-center gap-2 text-sm">
        <span className="text-gray-100 font-medium truncate">{hit.sessionName}</span>
        {hit.role && <span className="text-[10px] text-gray-600 shrink-0">{hit.role}</span>}
      </div>
      <div className="text-xs text-gray-400 truncate">{hit.snippet}</div>
      {hit.reason && <div className="text-[11px] text-purple-300/90 italic truncate">✨ {hit.reason}</div>}
    </button>
  );
}

function FileRow({
  hit, active, onOpen, onCopyPath, onInsertPath,
}: {
  hit: FileHit; active: boolean; onOpen: () => void; onCopyPath: () => void; onInsertPath: () => void;
}) {
  return (
    <div className={`flex items-center gap-1 border-b border-gray-800/60 last:border-b-0 transition-colors ${active ? 'bg-blue-900/30' : 'hover:bg-gray-800/60'}`}>
      <button type="button" onClick={onOpen} className="flex-1 min-w-0 text-left px-3 py-2.5 min-h-[44px] flex flex-col gap-0.5">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-100 font-medium truncate">{hit.name}</span>
          {hit.source === 'grep' && hit.line != null && <span className="text-[10px] text-gray-600 shrink-0">:{hit.line}</span>}
        </div>
        <div className="text-xs text-gray-500 truncate">{hit.dir}</div>
        {hit.snippet && <div className="text-xs text-gray-400 truncate font-mono">{hit.snippet}</div>}
        {hit.reason && <div className="text-[11px] text-purple-300/90 italic truncate">✨ {hit.reason}</div>}
      </button>
      <div className="flex items-center gap-1 pr-2 shrink-0">
        <button type="button" onClick={onCopyPath} title="Copy path" className="p-2 min-h-[44px] min-w-[36px] text-gray-500 hover:text-gray-200 text-xs">📋</button>
        <button type="button" onClick={onInsertPath} title="Insert path into chat" className="p-2 min-h-[44px] min-w-[36px] text-gray-500 hover:text-gray-200 text-xs">↩</button>
      </div>
    </div>
  );
}

export function SearchModal({ onClose }: Props) {
  const { requestScrollTo, appendToDraft, state, logEvent } = useSessions();
  const activeSessionId = state.activeSessionId;

  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<SearchScope>('projects');
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [smartLoading, setSmartLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [viewingFile, setViewingFile] = useState<{ cwd: string; filePath: string; fileName: string } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const runSearch = useCallback((q: string, sc: SearchScope, smart: boolean) => {
    abortRef.current?.abort();
    if (!q.trim()) { setResult(null); setLoading(false); setSmartLoading(false); setError(null); return; }
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    if (smart) setSmartLoading(true); else setLoading(true);
    fetchSearch(q, sc, smart, controller.signal)
      .then((r) => {
        // Ignore a response that a newer request has superseded — otherwise a slow query
        // (grep can run for seconds) can overwrite the results of the query the user is
        // actually looking at now.
        if (abortRef.current !== controller) return;
        setResult(r); setSelectedIndex(0);
      })
      .catch((err: any) => { if (err?.name !== 'AbortError' && abortRef.current === controller) setError(err?.message ?? 'Search failed'); })
      .finally(() => { if (abortRef.current === controller) { setLoading(false); setSmartLoading(false); } });
  }, []);

  // Debounced keyword search as the user types. Loading is flipped on SYNCHRONOUSLY here (not
  // only inside runSearch, which fires after the debounce) so the modal shows a spinner the
  // instant the user types, instead of sitting on the empty-state text for 250ms + however
  // long the request takes.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim()) setLoading(true);
    debounceRef.current = setTimeout(() => runSearch(query, scope, false), DEBOUNCE_MS);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, scope]);

  const runSmart = useCallback(() => {
    if (!query.trim()) return;
    logEvent('search_smart', { scope });
    runSearch(query, scope, true);
  }, [query, scope, runSearch, logEvent]);

  const rows: Row[] = useMemo(() => {
    if (!result) return [];
    return [
      ...result.sessions.map((hit): Row => ({ kind: 'session', hit })),
      ...result.files.map((hit): Row => ({ kind: 'file', hit })),
    ];
  }, [result]);

  const openRow = useCallback((row: Row) => {
    if (row.kind === 'session') {
      logEvent('search_open_session');
      requestScrollTo(row.hit.sessionId, row.hit.messageId);
      onClose();
    } else {
      logEvent('search_open_file');
      setViewingFile({ cwd: dirname(row.hit.path), filePath: basename(row.hit.path), fileName: row.hit.name });
    }
  }, [requestScrollTo, onClose, logEvent]);

  const copyPath = useCallback((path: string) => {
    navigator.clipboard?.writeText(path).catch(() => {});
  }, []);

  const insertPath = useCallback((path: string) => {
    if (!activeSessionId) return;
    appendToDraft(activeSessionId, path);
    logEvent('search_insert_path');
    onClose();
  }, [activeSessionId, appendToDraft, onClose, logEvent]);

  // Keyboard nav + Escape/Enter, and Cmd/Ctrl+Enter for smart search from the input.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex(i => Math.min(i + 1, rows.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex(i => Math.max(i - 1, 0)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) { runSmart(); return; }
      const row = rows[selectedIndex];
      if (row) openRow(row);
    }
  };

  // Click-outside dismiss.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  const statusLine = smartLoading
    ? 'Asking Haiku…'
    : loading
      ? 'Searching…'
      : error
        ? error
        : result
          ? `${result.sessions.length} session${result.sessions.length !== 1 ? 's' : ''} · ${result.files.length} file${result.files.length !== 1 ? 's' : ''} · ${highlightMs(result.tookMs)}`
          : 'Type to search sessions and files';

  if (viewingFile) {
    return (
      <div className="fixed inset-0 bg-black/60 flex items-stretch sm:items-center justify-center z-50 sm:p-4">
        <div ref={modalRef} className="bg-gray-900 border-0 sm:border sm:border-gray-700 sm:rounded-xl w-full h-full sm:h-auto sm:max-w-2xl sm:max-h-[80vh] flex flex-col shadow-2xl">
          <FileViewer
            cwd={viewingFile.cwd}
            filePath={viewingFile.filePath}
            fileName={viewingFile.fileName}
            onBack={() => setViewingFile(null)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-stretch sm:items-start sm:justify-center z-50 sm:p-4 sm:pt-[10vh]">
      <div ref={modalRef} className="bg-gray-900 border-0 sm:border sm:border-gray-700 sm:rounded-xl w-full h-full sm:h-auto sm:max-w-xl sm:max-h-[70vh] flex flex-col shadow-2xl">
        {/* Input row */}
        <div className="flex items-center gap-2 px-3 py-3 border-b border-gray-800 shrink-0">
          <span className="text-gray-500 shrink-0">🔍</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search sessions and files…"
            className="flex-1 min-w-0 bg-transparent text-base sm:text-sm text-gray-100 placeholder-gray-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-200 text-xl leading-none w-8 h-8 min-h-[44px] sm:min-h-0 flex items-center justify-center hover:bg-gray-800 rounded shrink-0"
          >
            ×
          </button>
        </div>

        {/* Scope + smart controls */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800 shrink-0">
          <div className="flex rounded-lg overflow-hidden border border-gray-700 shrink-0">
            <button
              type="button"
              onClick={() => setScope('projects')}
              className={`px-2.5 py-1.5 min-h-[36px] text-xs font-medium transition-colors ${
                scope === 'projects' ? 'bg-gray-600 text-gray-100' : 'bg-gray-800 hover:bg-gray-700 text-gray-400'
              }`}
            >
              Projects
            </button>
            <button
              type="button"
              onClick={() => setScope('everywhere')}
              className={`px-2.5 py-1.5 min-h-[36px] text-xs font-medium border-l border-gray-700 transition-colors ${
                scope === 'everywhere' ? 'bg-gray-600 text-gray-100' : 'bg-gray-800 hover:bg-gray-700 text-gray-400'
              }`}
            >
              Everywhere
            </button>
          </div>
          <button
            type="button"
            onClick={runSmart}
            disabled={!query.trim() || smartLoading}
            title="Ask Haiku to expand your idea into related terms and rank the results (Cmd/Ctrl+Enter)"
            className="px-2.5 py-1.5 min-h-[36px] rounded-lg border border-purple-700/50 bg-purple-900/20 hover:bg-purple-900/40 disabled:opacity-40 disabled:cursor-not-allowed text-purple-300 text-xs font-medium shrink-0"
          >
            ✨ Smart
          </button>
          <div className="flex-1 min-w-0 text-right text-[11px] text-gray-500 truncate">{statusLine}</div>
        </div>

        {result?.expandedTerms && result.expandedTerms.length > 0 && (
          <div className="flex flex-wrap gap-1 px-3 py-2 border-b border-gray-800 shrink-0">
            {result.expandedTerms.map((t) => (
              <span key={t} className="text-[10px] text-gray-400 bg-gray-800 border border-gray-700 rounded-full px-2 py-0.5">{t}</span>
            ))}
          </div>
        )}

        {/* Results */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {(loading || smartLoading) && (
            <div className="flex items-center justify-center gap-2 text-sm text-gray-400 py-10 px-4">
              <span className="inline-block w-4 h-4 rounded-full border-2 border-gray-600 border-t-blue-400 animate-spin" />
              {smartLoading ? 'Asking Haiku to expand and rank…' : 'Searching…'}
            </div>
          )}
          {error && !loading && !smartLoading && (
            <div className="text-sm text-red-400 text-center py-10 px-4">{error}</div>
          )}
          {!result && !loading && !smartLoading && !error && (
            <div className="text-sm text-gray-500 text-center py-10 px-4">
              Type an idea or keyword. Press Enter or ✨ Smart to have Haiku expand it and rank the results.
            </div>
          )}
          {result && rows.length === 0 && !loading && !smartLoading && !error && (
            <div className="text-sm text-gray-500 text-center py-10 px-4">No matches for "{result.query}".</div>
          )}
          {result && result.sessions.length > 0 && (
            <div>
              <div className="sticky top-0 bg-gray-900/95 backdrop-blur text-[10px] uppercase tracking-wide text-gray-500 font-semibold px-3 py-1.5 border-b border-gray-800/60">
                Sessions
              </div>
              {result.sessions.map((hit, i) => (
                <SessionRow
                  key={`${hit.sessionId}:${hit.messageId ?? ''}`}
                  hit={hit}
                  active={selectedIndex === i}
                  onOpen={() => openRow({ kind: 'session', hit })}
                />
              ))}
            </div>
          )}
          {result && result.files.length > 0 && (
            <div>
              <div className="sticky top-0 bg-gray-900/95 backdrop-blur text-[10px] uppercase tracking-wide text-gray-500 font-semibold px-3 py-1.5 border-b border-gray-800/60">
                Files
              </div>
              {result.files.map((hit, i) => (
                <FileRow
                  key={hit.path}
                  hit={hit}
                  active={selectedIndex === result.sessions.length + i}
                  onOpen={() => openRow({ kind: 'file', hit })}
                  onCopyPath={() => copyPath(hit.path)}
                  onInsertPath={() => insertPath(hit.path)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
