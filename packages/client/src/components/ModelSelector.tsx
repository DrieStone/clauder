const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];

interface ModelSelectorProps {
  model: string | undefined;
  onChange: (model: string) => void;
}

export function ModelSelector({ model, onChange }: ModelSelectorProps) {
  return (
    <select
      value={model || ''}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] font-medium text-cyan-400 focus:outline-none focus:border-blue-500 cursor-pointer"
      title="Model"
    >
      {MODEL_OPTIONS.map(opt => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
