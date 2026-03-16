import { useState, useRef, useEffect } from 'react';
import type { DebugLogEntry, DebugLogEntryType } from '@clauder/shared';

const TYPE_COLORS: Record<DebugLogEntryType, string> = {
  tool_start: 'bg-blue-900/50 text-blue-300',
  tool_result: 'bg-green-900/50 text-green-300',
  stderr: 'bg-amber-900/50 text-amber-300',
  sdk_event: 'bg-purple-900/50 text-purple-300',
  api_error: 'bg-red-900/50 text-red-300',
};

const FILTER_OPTIONS: { value: DebugLogEntryType | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'tool_start', label: 'Tool Start' },
  { value: 'tool_result', label: 'Tool Result' },
  { value: 'stderr', label: 'stderr' },
  { value: 'sdk_event', label: 'SDK Event' },
  { value: 'api_error', label: 'API Error' },
];

export function DebugLogView({ entries }: { entries: DebugLogEntry[] }) {
  const [filter, setFilter] = useState<DebugLogEntryType | 'all'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  const filtered = filter === 'all' ? entries : entries.filter((e) => e.type === filter);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filtered.length]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 40;
  };

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Filter bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 shrink-0 flex-wrap">
        {FILTER_OPTIONS.map((opt) => {
          const count = opt.value === 'all' ? entries.length : entries.filter((e) => e.type === opt.value).length;
          return (
            <button
              key={opt.value}
              onClick={() => setFilter(opt.value)}
              className={`text-[11px] px-2 py-0.5 rounded transition-colors ${
                filter === opt.value
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {opt.label} ({count})
            </button>
          );
        })}
      </div>

      {/* Entries */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        {filtered.length === 0 ? (
          <div className="text-center text-sm text-gray-600 py-8">No entries</div>
        ) : (
          <div className="divide-y divide-gray-800/50">
            {filtered.map((entry) => {
              const isExpanded = expandedId === entry.id;
              return (
                <div key={entry.id} className="hover:bg-gray-900/30">
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                    className="w-full text-left px-4 py-1.5 flex items-center gap-2 text-xs"
                  >
                    <span className="text-gray-600 font-mono text-[10px] shrink-0">{formatTime(entry.timestamp)}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${TYPE_COLORS[entry.type]}`}>
                      {entry.type}
                    </span>
                    <span className="text-gray-400 font-medium shrink-0">{entry.label}</span>
                    <span className="text-gray-600 truncate flex-1">
                      {entry.content.slice(0, 100).replace(/\n/g, ' ')}
                    </span>
                    <span className="text-gray-700 text-[10px] shrink-0">{isExpanded ? '\u25BC' : '\u25B6'}</span>
                  </button>
                  {isExpanded && (
                    <div className="px-4 pb-2">
                      <pre className="text-[11px] text-gray-300 bg-gray-900 rounded p-2 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-all">
                        {entry.content}
                      </pre>
                      {entry.originalLength && (
                        <div className="text-[10px] text-gray-600 mt-1">
                          Showing {entry.content.length.toLocaleString()} of {entry.originalLength.toLocaleString()} chars
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
