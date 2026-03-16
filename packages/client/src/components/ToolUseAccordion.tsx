import { useState } from 'react';
import type { ToolUseInfo } from '@clauder/shared';
import { summarizeToolUse } from './MessageBubble';

export function ToolUseAccordion({ tool }: { tool: ToolUseInfo }) {
  const [open, setOpen] = useState(false);
  const desc = summarizeToolUse(tool);

  return (
    <div className="rounded bg-gray-700/50 text-xs overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-1.5 py-0.5 w-full text-left hover:bg-gray-700/80 transition-colors"
      >
        <span className="text-gray-400 text-[10px] shrink-0">{open ? '\u25BC' : '\u25B6'}</span>
        <span className="text-gray-300 font-medium shrink-0">{tool.name}</span>
        {desc && <span className="text-gray-500 truncate">{desc}</span>}
        {tool.result && (
          <span className={`ml-auto shrink-0 text-[10px] ${tool.result.isError ? 'text-red-400' : 'text-green-400/60'}`}>
            {tool.result.isError ? 'error' : 'ok'}
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-gray-600/50 px-2 py-1.5 space-y-2">
          {/* Input */}
          <div>
            <div className="text-[10px] text-gray-500 mb-0.5">Input</div>
            <pre className="text-[11px] text-gray-300 bg-gray-900 rounded p-1.5 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-all">
              {JSON.stringify(tool.input, null, 2)}
            </pre>
          </div>
          {/* Result */}
          <div>
            <div className="text-[10px] text-gray-500 mb-0.5">
              Result
              {tool.result?.originalLength && (
                <span className="text-gray-600 ml-1">
                  (showing {tool.result.content.length.toLocaleString()} of {tool.result.originalLength.toLocaleString()} chars)
                </span>
              )}
            </div>
            {tool.result ? (
              <pre className={`text-[11px] rounded p-1.5 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-all ${
                tool.result.isError
                  ? 'text-red-300 bg-red-950/40 border border-red-900/50'
                  : 'text-gray-300 bg-gray-900'
              }`}>
                {tool.result.content || '(empty)'}
              </pre>
            ) : (
              <div className="text-[11px] text-gray-500 italic">pending...</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
