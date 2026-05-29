import { useEffect, useRef } from 'react';
import type { UIMessage } from '@clauder/shared';
import { MessageBubble } from './MessageBubble';

export function MessageList({ messages, sessionId }: { messages: UIMessage[]; sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
        Send a message to start the conversation
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto p-4 space-y-3">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} sessionId={sessionId} />
      ))}
    </div>
  );
}
