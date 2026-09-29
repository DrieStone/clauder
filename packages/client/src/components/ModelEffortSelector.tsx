import type { EffortLevel } from '@clauder/shared';

interface ModelOption {
  id: string;     // full model ID, pinned to current version
  label: string;
  color: string;
}

// Full model IDs so "Sonnet 5.5" actually runs claude-sonnet-5-5, not whatever
// alias the CLI defaults to. Update when Anthropic ships new model versions.
// Exported so PromptInput's per-message "Send with" override can reuse the same IDs/labels/colors.
export const MODELS: ModelOption[] = [
  { id: 'claude-fable-5-1',          label: 'Fable 5.1', color: 'text-purple-400' },
  { id: 'claude-opus-5-5',           label: 'Opus 5.5',  color: 'text-orange-300' },
  { id: 'claude-sonnet-5-5',         label: 'Sonnet 5.5', color: 'text-yellow-400' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', color: 'text-green-400'  },
];

const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// A session can be pinned to a model that's no longer on offer — an old session, or an ID we
// retired. Show it as its own (greyed) option instead of falling back to the default: the picker
// must never name a model the session isn't actually running. Switching away from it is one-way.
const RETIRED_LABELS: Record<string, string> = { 'claude-opus-5': 'Opus 5', 'claude-opus-4-8': 'Opus 4.8', 'claude-sonnet-5': 'Sonnet 5' };
const unlistedOption = (id: string): ModelOption =>
  ({ id, label: RETIRED_LABELS[id] ?? id, color: 'text-gray-400' });

// Pinned by id (not index) so reordering/adding models can't silently change the default.
const DEFAULT_MODEL = MODELS.find(m => m.id === 'claude-sonnet-5-5')!;  // Sonnet 5.5 — same as the server's (models.ts)
const DEFAULT_EFFORT: EffortLevel = 'medium';

interface Props {
  model: string | undefined;
  effort: string | undefined;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: EffortLevel | undefined) => void;
}

export function ModelEffortSelector({ model, effort, onModelChange, onEffortChange }: Props) {
  const options = model && !MODELS.some(m => m.id === model) ? [...MODELS, unlistedOption(model)] : MODELS;
  const currentModel = options.find(m => m.id === model) ?? DEFAULT_MODEL;
  const currentEffort = EFFORTS.includes(effort as EffortLevel) ? (effort as EffortLevel) : DEFAULT_EFFORT;

  const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    e.stopPropagation();
    onModelChange(e.target.value);
  };

  const handleEffortChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    e.stopPropagation();
    onEffortChange(e.target.value as EffortLevel);
  };

  return (
    <div className="flex items-center gap-1">
      <select
        value={model && options.some(m => m.id === model) ? model : DEFAULT_MODEL.id}
        onChange={handleModelChange}
        onClick={(e) => e.stopPropagation()}
        className={`bg-gray-800 border border-gray-700 rounded px-1.5 py-1.5 sm:py-0.5 text-[10px] font-medium ${currentModel.color} focus:outline-none focus:border-blue-500 cursor-pointer`}
        title="Model"
      >
        {options.map(m => (
          <option key={m.id} value={m.id}>{m.label}</option>
        ))}
      </select>
      <select
        value={currentEffort}
        onChange={handleEffortChange}
        onClick={(e) => e.stopPropagation()}
        className="bg-gray-800 border border-gray-700 rounded px-1.5 py-1.5 sm:py-0.5 text-[10px] font-medium text-gray-300 focus:outline-none focus:border-blue-500 cursor-pointer"
        title="Reasoning effort"
      >
        {EFFORTS.map(e => (
          <option key={e} value={e}>{e}</option>
        ))}
      </select>
    </div>
  );
}
