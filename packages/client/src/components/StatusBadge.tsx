import type { SessionStatus } from '@clauder/shared';

const statusConfig: Record<SessionStatus, { label: string; color: string; pulse?: boolean }> = {
  idle: { label: 'Idle', color: 'bg-green-500' },
  working: { label: 'Working', color: 'bg-amber-500', pulse: true },
  error: { label: 'Error', color: 'bg-red-500' },
  resumable: { label: 'Resumable', color: 'bg-blue-500' },
};

const waitingLabels: Record<string, string> = {
  question: 'Waiting — question',
  permission: 'Waiting — permission',
  input: 'Waiting — input',
  goal: '🎯 Goal stalled',
};

/** `compact`: below `sm` show just the dot (label kept for screen readers and as a tooltip) — the
 *  session header on a phone can't spare the width. A "waiting" state always keeps its label,
 *  since that one needs you. */
export function StatusBadge({ status, waitingFor, compact = false }: { status: SessionStatus; waitingFor?: string | null; compact?: boolean }) {
  if (waitingFor) {
    const label = waitingLabels[waitingFor] ?? `Waiting — ${waitingFor}`;
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-300 shrink-0" title={label}>
        <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
        {label}
      </span>
    );
  }
  const config = statusConfig[status] || statusConfig.idle;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium shrink-0" title={config.label}>
      <span className={`h-2 w-2 rounded-full ${config.color} ${config.pulse ? 'animate-pulse' : ''}`} />
      <span className={compact ? 'sr-only sm:not-sr-only' : undefined}>{config.label}</span>
    </span>
  );
}
