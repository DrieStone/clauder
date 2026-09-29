import { useState } from 'react';
import { RichMarkdown } from './RichMarkdown';
import type { PendingPlanInfo } from '../context/SessionContext';

interface PlanBannerProps {
  plan: PendingPlanInfo;
  onAccept: (feedback?: string) => void;
  onReject: (feedback?: string) => void;
}

interface PlanStep {
  model: string;
  effort?: string;
  task: string;
}

/** Short label + accent color per model, so the step table reads at a glance. Falls back to the
 *  raw id for anything unrecognized. */
const MODEL_META: Record<string, { label: string; color: string }> = {
  'claude-fable-5-1': { label: 'Fable 5.1', color: 'text-fuchsia-300' },
  'claude-fable-5': { label: 'Fable 5', color: 'text-fuchsia-300' },
  'claude-opus-5-5': { label: 'Opus 5.5', color: 'text-red-300' },
  'claude-opus-5': { label: 'Opus 5', color: 'text-red-300' },
  'claude-opus-4-8': { label: 'Opus 4.8', color: 'text-red-300' },
  'claude-sonnet-5-5': { label: 'Sonnet 5.5', color: 'text-sky-300' },
  'claude-sonnet-5': { label: 'Sonnet 5', color: 'text-sky-300' },
  'claude-haiku-4-5-20251001': { label: 'Haiku 4.5', color: 'text-emerald-300' },
};
const modelMeta = (id: string) => MODEL_META[id] ?? { label: id.replace(/^claude-/, ''), color: 'text-purple-200' };

/** Pull the machine-readable clauder-steps block out of the plan text (same shape the server
 *  parses on accept). Returns [] if absent/malformed — the banner just shows prose then. */
function parseSteps(planText: string): PlanStep[] {
  const m = /```clauder-steps\s*([\s\S]*?)```/.exec(planText);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[1].trim());
    if (Array.isArray(parsed.steps)) {
      return parsed.steps
        .filter((s: any) => s && typeof s.task === 'string')
        .map((s: any) => ({ model: String(s.model ?? ''), effort: s.effort ? String(s.effort) : undefined, task: String(s.task) }));
    }
  } catch { /* malformed — fall through */ }
  return [];
}

export function PlanBanner({ plan, onAccept, onReject }: PlanBannerProps) {
  const [expanded, setExpanded] = useState(true);
  const [feedback, setFeedback] = useState('');

  // Custom Plan: strip the machine-readable clauder-steps block from the prose display, and
  // surface it as a proper table instead. The accept handler reads the original text server-side.
  const steps = parseSteps(plan.plan);
  const displayPlan = plan.plan.replace(/```clauder-steps[\s\S]*?```/g, '').trim();

  return (
    <div className="mx-4 mt-2 rounded border border-purple-700 bg-purple-950/40 shrink-0">
      <div className="px-3 py-2 flex items-center justify-between gap-2 border-b border-purple-800/60">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-purple-200 text-xs font-medium">
            <span>📋</span>
            <span>Plan ready for review</span>
          </div>
          {steps.length > 0 && (
            <div className="text-purple-300 text-xs">
              {steps.length} step{steps.length !== 1 ? 's' : ''} · runs automatically, switching models per step
            </div>
          )}
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
          {/* Step-by-step table: what runs, on which model, in order */}
          {steps.length > 0 && (
            <div className="px-3 py-2 border-b border-purple-800/60 max-h-[32vh] overflow-y-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="text-purple-300 text-left">
                    <th className="py-1 pr-2 font-medium w-6">#</th>
                    <th className="py-1 pr-3 font-medium whitespace-nowrap">Model</th>
                    <th className="py-1 font-medium">Task</th>
                  </tr>
                </thead>
                <tbody className="align-top">
                  {steps.map((s, i) => {
                    const meta = modelMeta(s.model);
                    return (
                      <tr key={i} className="border-t border-purple-800/40">
                        <td className="py-1 pr-2 text-purple-400 tabular-nums">{i + 1}</td>
                        <td className="py-1 pr-3 whitespace-nowrap">
                          <span className={`font-medium ${meta.color}`}>{meta.label}</span>
                          {s.effort && <span className="text-purple-500 ml-1">· {s.effort}</span>}
                        </td>
                        <td className="py-1 text-purple-100">{s.task}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Plan prose (context / rationale / risks), block already stripped */}
          {displayPlan && (
            <div className="px-3 py-2 text-xs text-purple-100 max-h-[40vh] overflow-y-auto prose prose-invert prose-sm max-w-none [&_pre]:bg-purple-900/40 [&_pre]:border [&_pre]:border-purple-800 [&_code]:text-xs">
              <RichMarkdown>{displayPlan}</RichMarkdown>
            </div>
          )}
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
