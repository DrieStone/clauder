import { useState, useRef, useCallback, type HTMLAttributes } from 'react';
import type { UIMessage, ToolUseInfo } from '@clauder/shared';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeExternalLinks from 'rehype-external-links';
import { ToolUseAccordion } from './ToolUseAccordion';
import { useSessions } from '../context/SessionContext';

function CodeBlock({ children, ...props }: HTMLAttributes<HTMLPreElement>) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const handleCopy = useCallback(() => {
    const text = preRef.current?.textContent ?? '';
    if (!text) return;
    navigator.clipboard.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {/* clipboard write blocked — fail silently */});
  }, []);

  return (
    <div className="relative group">
      <pre ref={preRef} {...props}>{children}</pre>
      <button
        type="button"
        onClick={handleCopy}
        aria-label="Copy code"
        className="absolute top-1.5 right-1.5 px-1.5 py-0.5 text-[10px] bg-gray-700/80 hover:bg-gray-600 text-gray-200 rounded opacity-40 group-hover:opacity-100 transition-opacity"
      >
        {copied ? '✓ Copied' : 'Copy'}
      </button>
    </div>
  );
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
  const { applyClaudeMdCandidate } = useSessions();
  const [applied, setApplied] = useState<Set<string>>(new Set());

  return (
    <div className="mt-2 flex flex-col gap-1">
      {candidates.map((c, i) => (
        <div key={i} className="flex items-start gap-2 bg-yellow-950/40 border border-yellow-700/50 rounded px-2 py-1 text-xs">
          <span className="text-yellow-400 font-medium shrink-0">CLAUDE.md</span>
          <span className="text-yellow-100 flex-1">{c}</span>
          <button
            disabled={applied.has(c)}
            onClick={() => {
              applyClaudeMdCandidate(sessionId, c);
              setApplied(prev => new Set(prev).add(c));
            }}
            className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-yellow-700 hover:bg-yellow-600 text-white disabled:opacity-40 disabled:cursor-default transition-colors"
          >
            {applied.has(c) ? 'Applied' : 'Apply'}
          </button>
        </div>
      ))}
    </div>
  );
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
  const candidates = !isUser && message.content ? extractCandidates(message.content) : [];

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
                pre: CodeBlock,
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
        {candidates.length > 0 && (
          <ClaudeMdCandidates candidates={candidates} sessionId={sessionId} />
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
