import { memo, useRef, useState, useCallback, useLayoutEffect } from 'react';
import type { UIMessage } from '@clauder/shared';
import { MessageBubble } from './MessageBubble';
import { RichMarkdown } from './RichMarkdown';
import { useSessionActions } from '../context/SessionContext';
import { useGuestMode } from '../lib/guestMode';

const NEAR_BOTTOM_PX = 80;

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

/** Memoized on `messages`, whose identity changes only when this session's messages do. */
export const MessageList = memo(function MessageList({ messages, sessionId }: { messages: UIMessage[]; sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Whether we should auto-scroll on new content. Starts true; flips off the moment the
  // user scrolls away from the bottom, and back on once they scroll (or jump) back to it.
  const stickToBottomRef = useRef(true);
  const [showJumpButton, setShowJumpButton] = useState(false);

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
  const isNearBottom = (el: HTMLDivElement) => el.scrollTop < NEAR_BOTTOM_PX;

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const near = isNearBottom(el);
    stickToBottomRef.current = near;
    setShowJumpButton(!near);
  }, []);

  // Mounting fresh (switching to the Chat tab, or switching sessions while already on it)
  // always opens at the latest message, regardless of where a previous scroll was left.
  useLayoutEffect(() => {
    stickToBottomRef.current = true;
    setShowJumpButton(false);
    const el = containerRef.current;
    if (el) el.scrollTop = 0;
  }, [sessionId]);

  // Belt-and-suspenders: column-reverse should keep scrollTop natively pinned at 0 through
  // new messages and container resizes on its own, but re-asserting it here is free (0 is a
  // constant, not a stale computed value like scrollHeight was) and covers any browser-specific
  // anchoring gap without reintroducing the resize-race the old scrollHeight approach had.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = 0;
  }, [messages]);

  const scrollToBottom = () => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: 0, behavior: 'smooth' });
    stickToBottomRef.current = true;
    setShowJumpButton(false);
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
        className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4 flex flex-col-reverse gap-2 sm:gap-3"
      >
        {reversedMessages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} sessionId={sessionId} />
        ))}
      </div>
      {showJumpButton && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 right-4 w-9 h-9 rounded-full bg-gray-800 border border-gray-700 hover:bg-gray-700 text-gray-200 shadow-lg flex items-center justify-center transition-colors"
          title="Jump to latest"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
        </button>
      )}
    </div>
  );
});
