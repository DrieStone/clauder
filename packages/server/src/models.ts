/** Model IDs Clauder no longer offers, and what each one becomes.
 *
 *  Dropping an ID from the picker isn't enough on its own: a session persists the model it was
 *  configured with, so it would go on running the retired model while the UI — finding no
 *  matching option — displayed the default instead. Retired IDs are therefore rewritten when a
 *  session is restored from disk: its own model, each parked task's, and any pinned model-plan
 *  step. Sessions pinned to still-older IDs we never mapped keep running them, and the picker
 *  shows the real ID rather than pretending otherwise. */
const RETIRED_MODELS: Record<string, string> = {
  // Opus
  'claude-opus-5': 'claude-opus-5-5',     // superseded: cheaper cache reads, same tier
  'claude-opus-4-8': 'claude-opus-5-5',   // legacy Opus
  'claude-opus-4-6': 'claude-opus-5-5',
  // Sonnet
  'claude-sonnet-5': 'claude-sonnet-5-5',   // superseded: same per-token price, faster
  'claude-sonnet-4-6': 'claude-sonnet-5-5',
  // Fable
  'claude-fable-5': 'claude-fable-5-1',
  // Bare aliases. The picker deals only in pinned IDs — an alias silently follows whatever
  // the CLI currently points it at, which is exactly the drift pinning exists to prevent.
  'opus': 'claude-opus-5-5',
  'sonnet': 'claude-sonnet-5-5',
  'haiku': 'claude-haiku-4-5-20251001',
};

/** What a session runs when nothing picked a model for it: one created without a model (adopting a
 *  VS Code session sends none), or restored from before the picker had a default. With no --model
 *  flag the CLI would run its own default while the picker showed this one. Keep in step with
 *  DEFAULT_MODEL in the client's ModelEffortSelector.tsx. */
export const DEFAULT_MODEL = 'claude-sonnet-5-5';

/** The current ID for a possibly-retired one. Preserves null/undefined so it can be dropped in
 *  anywhere a model field is read. */
export function migrateModelId<T extends string | null | undefined>(model: T): T {
  if (typeof model !== 'string') return model;
  return (RETIRED_MODELS[model] ?? model) as T;
}
