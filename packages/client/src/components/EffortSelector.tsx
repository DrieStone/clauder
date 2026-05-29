import type { EffortLevel } from '@clauder/shared';

const EFFORT_OPTIONS: { value: EffortLevel | ''; label: string; color: string }[] = [
  { value: '', label: 'Default', color: 'text-gray-400' },
  { value: 'low', label: 'Low', color: 'text-green-400' },
  { value: 'medium', label: 'Med', color: 'text-yellow-400' },
  { value: 'high', label: 'High', color: 'text-orange-400' },
  { value: 'xhigh', label: 'XHigh', color: 'text-red-400' },
  { value: 'max', label: 'Max', color: 'text-red-500' },
];

interface EffortSelectorProps {
  effort: EffortLevel | undefined;
  onChange: (effort: EffortLevel | undefined) => void;
}

export function EffortSelector({ effort, onChange }: EffortSelectorProps) {
  const current = EFFORT_OPTIONS.find(o => o.value === (effort || '')) || EFFORT_OPTIONS[0];

  return (
    <select
      value={effort || ''}
      onChange={(e) => onChange(e.target.value as EffortLevel || undefined)}
      onClick={(e) => e.stopPropagation()}
      className={`bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] font-medium ${current.color} focus:outline-none focus:border-blue-500 cursor-pointer`}
      title="Effort level"
    >
      {EFFORT_OPTIONS.map(opt => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
