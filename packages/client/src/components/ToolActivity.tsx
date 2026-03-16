import type { ToolActivity as ToolActivityType } from '@clauder/shared';

export function ToolActivity({ activity }: { activity: ToolActivityType | null }) {
  if (!activity) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-800/50 border border-gray-700 rounded text-xs text-gray-400">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
      <span className="font-medium text-gray-300">{activity.toolName}</span>
      <span className="truncate">{activity.description}</span>
    </div>
  );
}
