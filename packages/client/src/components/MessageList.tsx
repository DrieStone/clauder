import { memo, useRef, useState, useCallback, useLayoutEffect, Fragment } from 'react';
import type { UIMessage, StatusReport } from '@clauder/shared';
import { MessageBubble } from './MessageBubble';
import { StatusNoteCard } from './StatusNote';
import { RichMarkdown } from './RichMarkdown';
import { useSessionActions } from '../context/SessionContext';
import { useGuestMode } from '../lib/guestMode';

/** Scrolled up by more than this and the chat stays put (no jumping to new messages). */
const NEAR_BOTTOM_PX = 24;

/** A pinned message's own full-content copy, shown at the top of the chat instead of in the
 *  scrollable history — same open/close pattern as PlanBanner. Each pin has its own
 *  expand/collapse state (defaults open) so several pins don't force each other in lockstep. */
function PinnedMessage({ message, sessionId }: { message: UIMessage; sessionId: string }) {
  const { pinMessage } = useSessionActions();
  const guestMode = useGuestMode();
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="border-b border-amber-900/30 last:border-b-0">
      <div className="px-3 py-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs text-amber-300 font-medium min-w-0">
          <span className="shrink-0">📌</span>
          <span className="truncate">{expanded ? 'Pinned' : (message.content ? message.content.slice(0, 60) : '[tool use]')}</span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button onClick={() => setExpanded(e => !e)} className="text-amber-400/80 hover:text-amber-200 text-[11px]">
            {expanded ? 'Hide' : 'Show'}
          </button>
          {!guestMode && <button onClick={() => pinMessage(sessionId, message.id, false)} className="text-amber-500/70 hover:text-amber-300 text-xs" title="Unpin">
            ✕
          </button>}
        </div>
      </div>
      {expanded && (
        <div className="px-3 pb-2 text-xs text-amber-50/90 max-h-[30vh] overflow-y-auto prose prose-invert prose-sm max-w-none [&_pre]:bg-gray-900 [&_pre]:border [&_pre]:border-gray-700 [&_pre]:rounded [&_code]:text-xs">
          {message.content
            ? <RichMarkdown>{message.content}</RichMarkdown>
            : <span className="italic text-amber-200/60">[tool use only — no text content]</span>}
        </div>
      )}
    </div>
  );
}

/** Memoized on `messages`, whose identity changes only when this session's messages do.
 *  `statusReport` (this task's status note, if any) is drawn where it was written: after the
 *  last message before it. */
export const MessageList = memo(function MessageList({ messages, sessionId, statusReport, textOnly }: { messages: UIMessage[]; sessionId: string; statusReport?: StatusReport | null; textOnly?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Whether we should auto-scroll on new content. Starts true; flips off the moment the
  // user scrolls away from the bottom, and back on once they scroll (or jump) back to it.
  const stickToBottomRef = useRef(true);
  const [showJumpButton, setShowJumpButton] = useState(false);
  /** New messages arrived while scrolled up: the jump button lights up. */
  const [newBelow, setNewBelow] = useState(false);
  /** While scrolled up: how far the view's top is from the top of the conversation, so new or
   *  growing messages below don't move what you're reading. column-reverse measures scrollTop
   *  from the bottom, so content added at the bottom would otherwise slide the view (iOS Safari
   *  has no scroll anchoring to hold it). */
  const fromTopRef = useRef(0);
  const lastCountRef = useRef(messages.length);
  const contentRef = useRef<HTMLDivElement>(null);

  // The scroll container uses flex-direction: column-reverse (see the render below), with
  // messages rendered in REVERSE order. This is the standard chat-UI trick: it makes "pinned
  // to bottom" a browser-native constant — scrollTop === 0 — instead of a JS-computed value
  // (scrollHeight) that has to be recalculated by hand every time the container resizes.
  // Two prior attempts at this (re-pinning on [messages]/[sessionId] only, then adding a
  // ResizeObserver to also re-pin on container resize) both still raced the on-screen
  // keyboard's resize on iOS — the container could shrink between the observer firing and
  // the browser's next paint. column-reverse sidesteps the race entirely: the browser keeps
  // scrollTop pinned at 0 through a resize on its own, the same native mechanism it uses to
  // keep you pinned to the bottom while new content streams in. Nothing to recompute, ever.
  // scrollTop is 0 at the bottom and goes NEGATIVE as you scroll up (column-reverse), so compare its
  // size: a plain `scrollTop < N` was true at any height and kept pulling the view back down.
  const isNearBottom = (el: HTMLDivElement) => Math.abs(el.scrollTop) < NEAR_BOTTOM_PX;

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const near = isNearBottom(el);
    stickToBottomRef.current = near;
    fromTopRef.current = el.scrollHeight - el.clientHeight + el.scrollTop;
    setShowJumpButton(!near);
    if (near) setNewBelow(false);
  }, []);

  // Mounting fresh (switching to the Chat tab, or switching sessions while already on it)
  // always opens at the latest message, regardless of where a previous scroll was left.
  useLayoutEffect(() => {
    stickToBottomRef.current = true;
    setShowJumpButton(false);
    setNewBelow(false);
    const el = containerRef.current;
    if (el) el.scrollTop = 0;
  }, [sessionId]);

  // Belt-and-suspenders: column-reverse should keep scrollTop natively pinned at 0 through
  // new messages and container resizes on its own, but re-asserting it here is free (0 is a
  // constant, not a stale computed value like scrollHeight was) and covers any browser-specific
  // anchoring gap without reintroducing the resize-race the old scrollHeight approach had.
  // Scrolled up: hold the view where it is, and flag that there's more below.
  useLayoutEffect(() => {
    const el = containerRef.current;
    const grew = messages.length > lastCountRef.current;
    lastCountRef.current = messages.length;
    if (!el) return;
    if (stickToBottomRef.current) { el.scrollTop = 0; return; }
    el.scrollTop = fromTopRef.current - (el.scrollHeight - el.clientHeight);
    if (grew) setNewBelow(true);
  }, [messages, textOnly]);

  // A message can finish growing after that (markdown, images, a streamed reply), and with
  // column-reverse growth below still slides the view, so hold it on every size change too.
  useLayoutEffect(() => {
    const el = containerRef.current, content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (stickToBottomRef.current) return;
      const want = fromTopRef.current - (el.scrollHeight - el.clientHeight);
      if (Math.abs(el.scrollTop - want) > 1) el.scrollTop = want;
    });
    ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
  }, [messages.length === 0]);

  const scrollToBottom = () => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: 0, behavior: 'smooth' });
    stickToBottomRef.current = true;
    setShowJumpButton(false);
    setNewBelow(false);
  };

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
        Send a message to start the conversation
      </div>
    );
  }

  const pinnedMessages = messages.filter(m => m.pinned);
  const reversedMessages = [...messages].reverse();
  // Newest first, so the note goes just before the newest message older than it (0 = it's the latest).
  const noteAt = statusReport
    ? reversedMessages.findIndex(m => Date.parse(m.timestamp) <= Date.parse(statusReport.generatedAt))
    : -1;

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      {pinnedMessages.length > 0 && (
        <div className="shrink-0 border-b border-amber-700/40 bg-amber-950/10 max-h-[50vh] overflow-y-auto">
          {pinnedMessages.map((m) => (
            <PinnedMessage key={m.id} message={m} sessionId={sessionId} />
          ))}
        </div>
      )}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className={`flex-1 min-h-0 overflow-y-auto p-3 sm:p-4 flex flex-col-reverse [overflow-anchor:none] ${textOnly ? 'text-only' : ''}`}
      >
        <div ref={contentRef} className="flex flex-col-reverse gap-2 sm:gap-3">
          {reversedMessages.map((msg, i) => (
            <Fragment key={msg.id}>
              {i === noteAt && statusReport && <StatusNoteCard key={statusReport.generatedAt} report={statusReport} latest={i === 0} />}
              <MessageBubble message={msg} sessionId={sessionId} />
            </Fragment>
          ))}
        </div>
      </div>
      {showJumpButton && (
        <button
          onClick={scrollToBottom}
          className={`absolute bottom-4 left-1/2 -translate-x-1/2 h-10 px-3 rounded-full border shadow-lg flex items-center gap-1.5 text-xs transition-colors ${newBelow ? 'bg-blue-600 border-blue-500 text-white hover:bg-blue-500' : 'bg-gray-800 border-gray-700 text-gray-200 hover:bg-gray-700'}`}
          title="Jump to latest"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
          {newBelow ? 'New messages' : 'Latest'}
        </button>
      )}
    </div>
  );
});
