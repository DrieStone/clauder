import { useState } from 'react';
import { RichMarkdown } from './RichMarkdown';
import type { PendingPlanInfo } from '../context/SessionContext';

interface PlanBannerProps {
  plan: PendingPlanInfo;
  onAccept: (feedback?: string) => void;
  onReject: (feedback?: string) => void;
}

export function PlanBanner({ plan, onAccept, onReject }: PlanBannerProps) {
  const [expanded, setExpanded] = useState(true);
  const [feedback, setFeedback] = useState('');

  return (
    <div className="mx-4 mt-2 rounded border border-purple-700 bg-purple-950/40 shrink-0">
      <div className="px-3 py-2 flex items-center justify-between gap-2 border-b border-purple-800/60">
        <div className="flex items-center gap-2 text-purple-200 text-xs font-medium">
          <span>📋</span>
          <span>Plan ready for review</span>
        </div>
        <button
          onClick={() => setExpanded(e => !e)}
          className="text-purple-300 hover:text-purple-100 text-xs"
        >
          {expanded ? 'Hide' : 'Show'}
        </button>
      </div>
      {expanded && (
        <>
          <div className="px-3 py-2 text-xs text-purple-100 max-h-[40vh] overflow-y-auto prose prose-invert prose-sm max-w-none [&_pre]:bg-purple-900/40 [&_pre]:border [&_pre]:border-purple-800 [&_code]:text-xs">
            <RichMarkdown>{plan.plan}</RichMarkdown>
          </div>
          <div className="px-3 py-2 border-t border-purple-800/60 flex flex-col gap-2">
            <input
              type="text"
              value={feedback}
              onChange={e => setFeedback(e.target.value)}
              placeholder="Optional feedback (sent with your decision)"
              className="text-xs bg-purple-900/30 border border-purple-800 rounded px-2 py-1 text-purple-100 placeholder-purple-400 focus:outline-none focus:border-purple-500"
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => onReject(feedback.trim() || undefined)}
                className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors"
              >
                Reject
              </button>
              <button
                onClick={() => onAccept(feedback.trim() || undefined)}
                className="px-3 py-1 text-xs bg-purple-700 hover:bg-purple-600 text-white rounded transition-colors font-medium"
              >
                Accept &amp; Execute
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
