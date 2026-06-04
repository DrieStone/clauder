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
};

export function StatusBadge({ status, waitingFor }: { status: SessionStatus; waitingFor?: string | null }) {
  if (waitingFor) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-300">
        <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
        {waitingLabels[waitingFor] ?? `Waiting — ${waitingFor}`}
      </span>
    );
  }
  const config = statusConfig[status] || statusConfig.idle;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <span className={`h-2 w-2 rounded-full ${config.color} ${config.pulse ? 'animate-pulse' : ''}`} />
      {config.label}
    </span>
  );
}
