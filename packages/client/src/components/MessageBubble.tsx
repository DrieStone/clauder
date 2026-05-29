import type { UIMessage, ToolUseInfo } from '@clauder/shared';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeExternalLinks from 'rehype-external-links';
import { ToolUseAccordion } from './ToolUseAccordion';

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

export function MessageBubble({ message, sessionId }: { message: UIMessage; sessionId: string }) {
  if (message.role === 'system') {
    return (
      <div className="text-center text-xs text-gray-500 py-1">
        {message.content}
      </div>
    );
  }

  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm break-words overflow-hidden ${
          isUser
            ? 'bg-blue-600 text-white'
            : 'bg-gray-800 text-gray-100 border border-gray-700'
        }`}
      >
        {message.toolUses && message.toolUses.length > 0 && (
          <div className="flex flex-col gap-1 mb-1.5">
            {message.toolUses.map((tool) => (
              <ToolUseAccordion key={tool.id} tool={tool} sessionId={sessionId} />
            ))}
          </div>
        )}
        {message.images && message.images.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {message.images.map((img, i) => (
              <img
                key={i}
                src={`data:${img.mimeType};base64,${img.data}`}
                alt={`Attached image ${i + 1}`}
                className="max-w-[200px] max-h-[200px] rounded object-contain cursor-pointer"
                onClick={() => window.open(`data:${img.mimeType};base64,${img.data}`, '_blank')}
              />
            ))}
          </div>
        )}
        {message.content ? (
          <div className="prose prose-invert prose-sm max-w-none break-words [&_pre]:bg-gray-900 [&_pre]:border [&_pre]:border-gray-700 [&_pre]:rounded [&_pre]:overflow-x-auto [&_code]:text-xs [&_code]:break-all [&_table]:border-collapse [&_table]:text-xs [&_th]:border [&_th]:border-gray-600 [&_th]:bg-gray-900 [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-gray-700 [&_td]:px-2 [&_td]:py-1 [&_tr:nth-child(even)]:bg-gray-900/40 [&_a]:text-blue-400 [&_a]:underline [&_a]:break-all [&_table]:display-table [&_.table-wrapper]:overflow-x-auto">
            <Markdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[[rehypeExternalLinks, { target: '_blank', rel: ['noopener', 'noreferrer'] }]]}
              components={{
                table: ({ children }) => (
                  <div className="overflow-x-auto my-2">
                    <table className="border-collapse text-xs min-w-full">{children}</table>
                  </div>
                ),
              }}
            >{message.content}</Markdown>
          </div>
        ) : null}
        {message.isStreaming && (
          <span className="inline-block w-1.5 h-4 bg-gray-400 animate-pulse ml-0.5 align-text-bottom" />
        )}
      </div>
      {message.timestamp && (
        <div className={`text-[10px] text-gray-600 mt-0.5 ${isUser ? 'text-right' : 'text-left'}`}>
          {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      )}
    </div>
  );
}
