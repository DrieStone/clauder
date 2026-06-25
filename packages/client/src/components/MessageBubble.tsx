import { useState } from 'react';
import type { UIMessage, ToolUseInfo } from '@clauder/shared';
import { ToolUseAccordion } from './ToolUseAccordion';
import { RichMarkdown } from './RichMarkdown';
import { useSessions } from '../context/SessionContext';

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
                className="max-w-[200px] max-h-[200px] rounded object-contain cursor-pointer hover:opacity-90 transition-opacity"
                title="Click to open full size"
                onClick={() => window.open(`data:${img.mimeType};base64,${img.data}`, '_blank')}
              />
            ))}
          </div>
        )}
        {message.files && message.files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {message.files.map((f, i) => (
              <button
                key={i}
                title={`Click to view ${f.name}`}
                onClick={() => {
                  if (f.kind === 'document') {
                    window.open(`data:${f.mimeType};base64,${f.content}`, '_blank');
                  } else {
                    const blob = new Blob([f.content], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    window.open(url, '_blank');
                    setTimeout(() => URL.revokeObjectURL(url), 10000);
                  }
                }}
                className="flex items-center gap-1 px-2 py-1 bg-blue-800/40 border border-blue-600/50 rounded text-xs text-blue-200 hover:bg-blue-700/40 hover:border-blue-500 transition-colors cursor-pointer"
              >
                <span>{f.kind === 'document' ? '📄' : '📝'}</span>
                <span className="max-w-[160px] truncate">{f.name}</span>
              </button>
            ))}
          </div>
        )}
        {message.content ? (
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
      {message.timestamp && (
        <div className={`text-[10px] text-gray-600 mt-0.5 ${isUser ? 'text-right' : 'text-left'}`}>
          {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      )}
    </div>
  );
}
