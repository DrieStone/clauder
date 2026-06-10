import type { EffortLevel } from '@clauder/shared';

interface Preset {
  label: string;
  model: string;       // full model ID, pinned to current version
  effort: EffortLevel;
  color: string;
}

// Full model IDs so "Opus 4.8" actually runs claude-opus-4-8, not whatever
// alias the CLI defaults to. Update when Anthropic ships new model versions.
const PRESETS: Preset[] = [
  { label: 'Opus 4.8 — Max',    model: 'claude-opus-4-8',            effort: 'max',    color: 'text-red-400'    },
  { label: 'Sonnet 4.6 — Med',  model: 'claude-sonnet-4-6',          effort: 'medium', color: 'text-yellow-400' },
  { label: 'Haiku 4.5 — Med',   model: 'claude-haiku-4-5-20251001',  effort: 'medium', color: 'text-green-400'  },
];

const DEFAULT_PRESET = PRESETS[1]; // Sonnet 4.6 — Med

const encode = (model: string, effort: string) => `${model}|${effort}`;
const decode = (v: string) => { const [model, effort] = v.split('|'); return { model, effort }; };

function matchPreset(model: string | undefined, effort: string | undefined): Preset {
  return PRESETS.find(p => p.model === (model || '') && p.effort === (effort || ''))
    ?? DEFAULT_PRESET;
}

interface Props {
  model: string | undefined;
  effort: string | undefined;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: EffortLevel | undefined) => void;
}

export function ModelEffortSelector({ model, effort, onModelChange, onEffortChange }: Props) {
  const current = matchPreset(model, effort);
  // If the session has an unrecognised model/effort combo, show the default option selected
  // but don't change anything until the user explicitly picks something.
  const currentValue = PRESETS.some(p => p.model === (model || '') && p.effort === (effort || ''))
    ? encode(model || '', effort || '')
    : encode(DEFAULT_PRESET.model, DEFAULT_PRESET.effort);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    e.stopPropagation();
    const { model: newModel, effort: newEffort } = decode(e.target.value);
    onModelChange(newModel);
    onEffortChange(newEffort as EffortLevel);
  };

  return (
    <select
      value={currentValue}
      onChange={handleChange}
      onClick={(e) => e.stopPropagation()}
      className={`bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] font-medium ${current.color} focus:outline-none focus:border-blue-500 cursor-pointer`}
      title={current.label}
    >
      {PRESETS.map(p => (
        <option key={encode(p.model, p.effort)} value={encode(p.model, p.effort)}>
          {p.label}
        </option>
      ))}
    </select>
  );
}
