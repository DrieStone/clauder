import { memo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { UIMessage, ToolUseInfo } from '@clauder/shared';
import { ToolUseAccordion } from './ToolUseAccordion';
import { RichMarkdown } from './RichMarkdown';
import { ZoomableImage } from './ZoomableImage';
import { ErrorBoundary } from './ErrorBoundary';
import { useSessions, useSessionActions } from '../context/SessionContext';

/** Open base64 content in a new tab via a blob URL. Browsers block top-level navigation to
 *  data: URLs (yields a blank tab), so we must materialize a blob URL instead. */
function openBase64InTab(base64: string, mime: string): void {
  try {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } catch { /* malformed base64 — nothing to open */ }
}

export function summarizeToolUse(tool: ToolUseInfo): string {
  const input = tool.input;
  switch (tool.name) {
    case 'Bash':
      return String(input.command || '').slice(0, 80);
    case 'Read':
    case 'Write':
    case 'Edit':
      return String(input.file_path || '').split('/').slice(-2).join('/');
    case 'Glob':
      return String(input.pattern || '');
    case 'Grep':
      return String(input.pattern || '');
    case 'Task':
      return String(input.description || '');
    case 'TodoWrite':
      return 'Updating task list';
    default:
      return '';
  }
}

const CANDIDATE_RE = /\[CLAUDE\.md candidate:\s*([^\]]+)\]/g;

function extractCandidates(content: string): string[] {
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(CANDIDATE_RE.source, 'g');
  while ((m = re.exec(content)) !== null) {
    matches.push(m[1].trim());
  }
  return matches;
}

function ClaudeMdCandidates({ candidates, sessionId }: { candidates: string[]; sessionId: string }) {
  const { applyClaudeMdCandidate, state } = useSessions();
  const [clicked, setClicked] = useState<Set<string>>(new Set());

  return (
    <div className="mt-2 flex flex-col gap-1">
      {candidates.map((c, i) => {
        // Candidates are auto-applied server-side; the button is just a manual fallback.
        const applied = state.appliedClaudeMd.has(c.trim()) || clicked.has(c);
        return (
          <div key={i} className="flex items-start gap-2 bg-yellow-950/40 border border-yellow-700/50 rounded px-2 py-1 text-xs">
            <span className="text-yellow-400 font-medium shrink-0">CLAUDE.md</span>
            <span className="text-yellow-100 flex-1">{c}</span>
            <button
              disabled={applied}
              onClick={() => {
                applyClaudeMdCandidate(sessionId, c);
                setClicked(prev => new Set(prev).add(c));
              }}
              className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-yellow-700 hover:bg-yellow-600 text-white disabled:opacity-40 disabled:cursor-default transition-colors"
            >
              {applied ? 'Applied' : 'Apply'}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** A progress note: the text of a thinking block (see UIMessage.thinking). Muted, so narration
 *  between tool calls doesn't read as an answer. Long ones start clamped; older models could
 *  think at length. */
function ProgressNote({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 600;
  return (
    <div className="min-w-0 border-l-2 border-gray-700 pl-2.5 text-xs italic text-gray-400 break-words">
      <div className={`whitespace-pre-wrap ${long && !expanded ? 'line-clamp-4' : ''}`}>{text}</div>
      {long && (
        <button onClick={() => setExpanded(e => !e)} className="mt-0.5 not-italic text-[11px] text-gray-500 hover:text-gray-300">
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

/** Memoized: the reducer keeps an unchanged message's object identity, so a bubble re-renders only
 *  when its own message does. It used to read the whole context, so every WS message re-rendered
 *  every bubble and re-parsed its markdown. */
export const MessageBubble = memo(function MessageBubble({ message, sessionId }: { message: UIMessage; sessionId: string }) {
  const { pinMessage } = useSessionActions();
  const [lightbox, setLightbox] = useState<string | null>(null);

  if (message.role === 'system') {
    return (
      <div className="text-center text-xs text-gray-500 py-1">
        {message.content}
      </div>
    );
  }

  const isUser = message.role === 'user';
  const candidates = !isUser && message.content ? extractCandidates(message.content) : [];
  const pinned = !!message.pinned;
  const hasText = !!message.content?.trim();
  const hasAttachments = !!message.images?.length || !!message.files?.length;
  const hasTools = !!message.toolUses?.length;
  const hasThinking = !!message.thinking?.trim();
  // Nothing to render (e.g. a turn whose only text was a sentinel the server stripped) — this used
  // to draw an empty pill with a lone timestamp. Streaming placeholders still show. A message that
  // is only a progress note renders as a muted line rather than a bubble.
  if (!hasText && !hasAttachments && !hasTools && !message.isStreaming) {
    return hasThinking ? (
      <div id={`msg-${message.id}`} className="flex justify-start">
        <div className="max-w-[85%] min-w-0 py-0.5">
          <ProgressNote text={message.thinking!} />
        </div>
      </div>
    ) : null;
  }
  // Tool-call-only turns (the bulk of a busy transcript) get tighter padding.
  const toolOnly = hasTools && !hasText && !hasAttachments && !message.isStreaming;

  return (
    <div id={`msg-${message.id}`} className={`group flex items-end gap-1.5 ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] min-w-0 rounded-lg ${toolOnly ? 'px-2 py-1.5' : 'px-3 py-2'} text-sm break-words overflow-hidden ${
          isUser
            ? 'bg-blue-600 text-white'
            : pinned
              ? 'bg-gray-800 text-gray-100 border border-amber-600/60'
              : 'bg-gray-800 text-gray-100 border border-gray-700'
        }`}
      >
        {hasThinking && (
          <div className="mb-1.5">
            <ProgressNote text={message.thinking!} />
          </div>
        )}
        {message.toolUses && message.toolUses.length > 0 && (
          <div className={`flex flex-col gap-1 ${toolOnly ? '' : 'mb-1.5'}`}>
            {message.toolUses.map((tool) => (
              <ToolUseAccordion key={tool.id} tool={tool} sessionId={sessionId} />
            ))}
          </div>
        )}
        {message.images && message.images.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {message.images.map((img, i) => {
              // Stored history arrives with `src` instead of base64 (see the server's client-view):
              // the browser fetches those and caches them, so a reload re-downloads nothing.
              const src = img.data ? `data:${img.mimeType};base64,${img.data}` : (img.src ?? '');
              return (
                <img
                  key={i}
                  src={src}
                  alt={`Attached image ${i + 1}`}
                  loading="lazy"
                  className="max-w-[200px] max-h-[200px] rounded object-contain cursor-pointer hover:opacity-90 transition-opacity"
                  title="Click to view full size"
                  onClick={() => setLightbox(src)}
                />
              );
            })}
          </div>
        )}
        {message.files && message.files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {message.files.map((f, i) => {
              // 'binary' files (XLS, docx, zip) are saved to disk server-side and their base64
              // is dropped from history, so there's nothing to open client-side — render a
              // plain, non-clickable chip. text/document chips stay click-to-view.
              const icon = f.kind === 'document' ? '📄' : f.kind === 'binary' ? '📎' : '📝';
              if (f.kind === 'binary') {
                return (
                  <span
                    key={i}
                    title={`${f.name} (saved to disk for Claude to read)`}
                    className="flex items-center gap-1 px-2 py-1 bg-gray-700/40 border border-gray-600/50 rounded text-xs text-gray-300"
                  >
                    <span>{icon}</span>
                    <span className="max-w-[160px] truncate">{f.name}</span>
                  </span>
                );
              }
              return (
                <button
                  key={i}
                  title={`Click to view ${f.name}`}
                  onClick={() => {
                    // Stored history carries a URL instead of the bytes — just open it.
                    if (!f.content && f.src) { window.open(f.src, '_blank'); return; }
                    // Open via a blob URL, never a data: URL — browsers block top-level
                    // navigation to data: URLs (which just yields a blank tab).
                    if (f.kind === 'document') {
                      openBase64InTab(f.content, f.mimeType);
                    } else {
                      const blob = new Blob([f.content], { type: 'text/plain' });
                      const url = URL.createObjectURL(blob);
                      window.open(url, '_blank');
                      setTimeout(() => URL.revokeObjectURL(url), 30000);
                    }
                  }}
                  className="flex items-center gap-1 px-2 py-1 bg-blue-800/40 border border-blue-600/50 rounded text-xs text-blue-200 hover:bg-blue-700/40 hover:border-blue-500 transition-colors cursor-pointer"
                >
                  <span>{icon}</span>
                  <span className="max-w-[160px] truncate">{f.name}</span>
                </button>
              );
            })}
          </div>
        )}
        {hasText ? (
          <div className="prose prose-invert prose-sm max-w-none break-words [&_pre]:bg-gray-900 [&_pre]:border [&_pre]:border-gray-700 [&_pre]:rounded [&_pre]:overflow-x-auto [&_code]:text-xs [&_code]:break-all [&_table]:border-collapse [&_table]:text-xs [&_th]:border [&_th]:border-gray-600 [&_th]:bg-gray-900 [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-gray-700 [&_td]:px-2 [&_td]:py-1 [&_tr:nth-child(even)]:bg-gray-900/40 [&_a]:text-blue-400 [&_a]:underline [&_a]:break-all [&_table]:display-table [&_.table-wrapper]:overflow-x-auto">
            <RichMarkdown>{message.content}</RichMarkdown>
          </div>
        ) : null}
        {message.isStreaming && (
          <span className="inline-block w-1.5 h-4 bg-gray-400 animate-pulse ml-0.5 align-text-bottom" />
        )}
        {candidates.length > 0 && (
          <ClaudeMdCandidates candidates={candidates} sessionId={sessionId} />
        )}
      </div>
      {(message.timestamp || !isUser) && (
        <div className={`shrink-0 whitespace-nowrap flex items-center gap-1.5 text-[10px] text-gray-600 pb-1 ${isUser ? 'text-right justify-end' : 'text-left'}`}>
          {message.timestamp && (
            <span>{new Date(message.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
          )}
          {!isUser && (
            <button
              onClick={() => pinMessage(sessionId, message.id, !pinned)}
              className={`transition-opacity ${pinned ? 'opacity-100 text-amber-400' : 'opacity-40 group-hover:opacity-70 hover:!opacity-100 text-gray-500'}`}
              title={pinned ? 'Unpin this message' : 'Pin this message to the top of the chat'}
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5h14l-4.091-4.091a2.25 2.25 0 01-.659-1.591V3.104M12 14.5v6" />
              </svg>
            </button>
          )}
        </div>
      )}
      {lightbox && (
        // A crash inside the zoom viewer just closes it instead of taking the whole app down.
        <ErrorBoundary label="image viewer" fallback={() => null} onError={() => setLightbox(null)}>
          {createPortal(
            <div
              className="fixed inset-0 z-[100] bg-black/85 flex items-center justify-center p-4 cursor-zoom-out"
              // Close only on a tap of the backdrop itself — panning/zooming the image
              // fires on the inner element and must not bubble up to close.
              onClick={(e) => { if (e.target === e.currentTarget) setLightbox(null); }}
            >
              <ZoomableImage
                src={lightbox}
                alt="Full size"
                className="max-w-full max-h-full object-contain rounded shadow-2xl"
                onDismiss={() => setLightbox(null)}
              />
              <button
                onClick={() => setLightbox(null)}
                className="fixed z-[110] w-11 h-11 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center text-2xl leading-none shadow-lg ring-1 ring-white/30 backdrop-blur-sm cursor-pointer"
                style={{ top: 'calc(env(safe-area-inset-top, 0px) + 12px)', right: 'calc(env(safe-area-inset-right, 0px) + 12px)' }}
                aria-label="Close"
              >
                ✕
              </button>
            </div>,
            document.body,
          )}
        </ErrorBoundary>
      )}
    </div>
  );
});
