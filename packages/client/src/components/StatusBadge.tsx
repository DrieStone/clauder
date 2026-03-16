import type { SessionStatus } from '@clauder/shared';

const statusConfig: Record<SessionStatus, { label: string; color: string; pulse?: boolean }> = {
  idle: { label: 'Idle', color: 'bg-green-500' },
  working: { label: 'Working', color: 'bg-amber-500', pulse: true },
  error: { label: 'Error', color: 'bg-red-500' },
  resumable: { label: 'Resumable', color: 'bg-blue-500' },
};

export function StatusBadge({ status }: { status: SessionStatus }) {
  const config = statusConfig[status] || statusConfig.idle;

  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <span className={`h-2 w-2 rounded-full ${config.color} ${config.pulse ? 'animate-pulse' : ''}`} />
      {config.label}
    </span>
  );
}
