import type { PermissionMode } from '@clauder/shared';

const MODE_OPTIONS: { value: PermissionMode; label: string; shortLabel: string; color: string }[] = [
  { value: 'bypassPermissions', label: 'Bypass Permissions', shortLabel: 'Bypass', color: 'text-red-400' },
  { value: 'dontAsk', label: "Don't Ask (v2)", shortLabel: "No Ask", color: 'text-orange-400' },
  { value: 'auto', label: 'Auto (v2)', shortLabel: 'Auto', color: 'text-yellow-400' },
  { value: 'acceptEdits', label: 'Accept Edits', shortLabel: 'Edits', color: 'text-amber-400' },
  { value: 'default', label: 'Default (Ask in chat)', shortLabel: 'Ask', color: 'text-green-400' },
  { value: 'plan', label: 'Plan Only', shortLabel: 'Plan', color: 'text-blue-400' },
];

interface PermissionModeSelectorProps {
  mode: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  compact?: boolean;
}

export function PermissionModeSelector({ mode, onChange, compact = false }: PermissionModeSelectorProps) {
  const current = MODE_OPTIONS.find(o => o.value === mode) || MODE_OPTIONS[0];

  return (
    <select
      value={mode}
      onChange={(e) => onChange(e.target.value as PermissionMode)}
      onClick={(e) => e.stopPropagation()}
      className={`bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] font-medium ${current.color} focus:outline-none focus:border-blue-500 cursor-pointer`}
      title="Permission mode"
    >
      {MODE_OPTIONS.map(opt => (
        <option key={opt.value} value={opt.value}>
          {compact ? opt.shortLabel : opt.label}
        </option>
      ))}
    </select>
  );
}
