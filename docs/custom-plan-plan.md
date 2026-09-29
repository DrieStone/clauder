# Implementation Plan: Custom Plan (Fable/Opus planning → per-step model execution)

**Status:** ready to implement. Written by a session that knows this codebase; each phase is
self-contained. Follow existing repo patterns (see `docs/archive-project-plan.md` for tone).

## Goal

Replace the built-in Plan behavior. New flow:

1. User hits **Plan** (or Cmd/Ctrl+Enter) → that one turn runs on **`claude-fable-5`**
   (falling back to **`claude-opus-4-8`** if Fable isn't available on this subscription),
   in plan mode, regardless of the session's configured model.
2. A planning system prompt makes the planner produce steps where each step names the
   **cheapest Claude model that can accomplish it**, minimizing human interaction, and embeds
   a machine-readable steps block in the plan.
3. The plan surfaces through the existing `pending_plan` → PlanBanner accept/reject UI.
4. On **Accept**, the server parses the steps block out of the plan and starts a model plan
   directly (`setModelPlan`) — the existing `ModelPlanRunner` executes it, switching models
   per step. No extra turn on the expensive planning model.
5. When the model plan finishes (or is stopped), the session's **pre-plan model/effort are
   restored** (locked decision).

Locked decisions: try-Fable-then-Opus; restore pre-plan model; full replacement (no legacy
plain-plan path in the UI).

## Machine-readable steps block (the contract between planner and server)

The planner must embed, inside the ExitPlanMode plan text, exactly one fenced block:

    ```clauder-steps
    {"steps":[{"model":"claude-haiku-4-5-20251001","effort":"medium","task":"..."}, ...]}
    ```

- Extraction regex (server + client): /```clauder-steps\s*([\s\S]*?)```/
- Allowed models: claude-fable-5, claude-opus-4-8, claude-sonnet-5, claude-haiku-4-5-20251001.
- `setModelPlan` already validates/normalizes models+efforts and caps steps at 20 — reuse it.
- If the block is missing/unparseable at accept time → graceful fallback: behave exactly like
  the legacy accept (send "Plan approved. Proceed…" message). Never hard-fail an accept.

---

## Phase 1 — ModelPlan restore support  (model: Sonnet / medium)

`packages/shared/src/session.ts` — extend `ModelPlan`:

```ts
/** Model/effort the session had before the plan started; restored when the plan
 *  finishes or is stopped. Absent on plans started before this field existed. */
restoreModel?: string;
restoreEffort?: EffortLevel;
```

`packages/server/src/session.ts`:
- `setModelPlan(...)`: capture `restoreModel: this.config.model ?? 'claude-sonnet-5'` and
  `restoreEffort: (this.config.effort as EffortLevel) ?? 'medium'` into the plan object.
- `takeNextPlanStep()` finish branch (cursor >= steps.length): BEFORE clearing the plan,
  stash restoreModel/restoreEffort; after clearing + broadcasting, call
  `this.setModel(restoreModel)` / `this.setEffort(restoreEffort)` when present.
- `stopModelPlan()`: same restore before clearing.

Build: `npm run build -w packages/shared && npm run build -w packages/server`.

## Phase 2 — Planning turn: model override + fallback + prompt  (model: Opus / high — trickiest server logic; session.ts is the load-bearing file, read the relevant regions first)

All in `packages/server/src/session.ts`:

### 2a. Transient fallback flag
Class field `private planFallbackToOpus = false;` (NOT persisted — resets on restart, which
is fine; Fable being unavailable will just be re-detected once).

### 2b. Model override for plan turns
In `sendMessage`, where flags are built: the existing code pushes `--model this.config.model`.
Change to: for `opts?.planMode` turns use
`this.planFallbackToOpus ? 'claude-opus-4-8' : 'claude-fable-5'` and `--effort high`;
otherwise unchanged. Do NOT touch `this.config.model` — the override is per-turn only, so the
session's configured model is untouched by planning (restore concern is only for execution,
Phase 1).

### 2c. Fallback detection + auto-retry
In BOTH error surfaces (the `case 'result':` !success branch and the catch block), add: if the
failed turn was a planMode turn (thread `opts?.planMode` into a local before the try), AND
`!this.planFallbackToOpus`, AND the error text matches
`/not_found_error|no such model|model.*not.*(available|found|exist)|invalid model|unknown model|404/i`
→ set `planFallbackToOpus = true`, emit a system message
("Fable not available — planning with Opus instead."), remove the just-pushed user message
from history (mirror the transient-retry resend pattern already in the catch block), set
status idle, and re-send the same message with `{ planMode: true }`. Take care not to loop:
the flag guarantees at most one retry.

### 2d. Planning system prompt
Where `systemParts` is assembled, when `opts?.planMode` push an additional part (plan turns
only — do not leak into normal turns):

- You are planning, not executing. Produce a concrete step-by-step plan.
- Model catalog + selection rule: claude-haiku-4-5-20251001 (fast/cheap — mechanical edits,
  renames, boilerplate, config churn), claude-sonnet-5 (standard implementation work),
  claude-opus-4-8 (hard debugging, safety-critical or architectural work),
  claude-fable-5 (only for exceptionally hard reasoning; it costs 2× Opus). For EACH step pick
  the CHEAPEST model that can accomplish it well. Prefer more, smaller steps on cheap models
  over fewer steps on expensive ones.
- Design steps to run WITHOUT human interaction wherever possible: no questions mid-step, no
  "ask the user"; steps should verify their own work (build/tests) instead.
- The plan MUST include the ```clauder-steps fenced JSON block (format above; ≤20 steps), and
  each step's `task` must be self-contained enough to execute cold.
- Still call ExitPlanMode with the full plan (prose + block) as usual.

### 2e. Capture plan text for the accept handler
In the ExitPlanMode detection block (search "ExitPlanMode detected"), store the plan on the
instance: public field `lastPlanText: string | null = null;` set it there. (Transient; not
persisted — an accept after a server restart falls back to legacy behavior, acceptable.)

Build: `npm run build -w packages/server`.

## Phase 3 — Accept → start the model plan  (model: Sonnet / medium)

- `packages/server/src/model-plan-runner.ts`: no change needed — `kickstartActivePlans()` is
  already public and scans idle sessions for running plans.
- `packages/server/src/index.ts`: thread the runner into the WS layer with a lazy getter,
  exactly like `getTriggers`/`getProjectRunner` (note `setupWebSocket` is called before the
  runner is constructed — the getter pattern handles that).
- `packages/server/src/ws.ts` (`plan_response` case, `decision === 'accept'`): before the
  legacy behavior, check `session.lastPlanText`:
  - Extract the clauder-steps block with the regex; JSON.parse; if `steps` is a non-empty
    array → `session.setModelPlan(steps)`; clear `session.lastPlanText`; broadcast
    `plan_resolved` (as today); emit a system message like
    "▶️ Executing plan — N steps with automatic model switching."; then
    `getModelPlanRunner().kickstartActivePlans()` to start step 1 (session is idle; no
    state_change will fire on its own).
  - Else (no block / bad JSON / restart wiped lastPlanText) → legacy path unchanged
    ("Plan approved. Proceed with the plan as described." message).
  - Reject path: clear `session.lastPlanText`, otherwise unchanged.

Build: `npm run build -w packages/server`.

## Phase 4 — Client: hide the machine block  (model: Haiku / medium — trivial, contained)

`packages/client/src/components/PlanBanner.tsx`: before rendering `plan.plan`, strip the
fenced block: `plan.plan.replace(/```clauder-steps[\s\S]*?```/g, '').trim()` (display only —
the accept flow reads the ORIGINAL text server-side, so nothing else changes). Optionally add
a small line under the header when the block was present: "Steps will run with automatic
model switching." Keep everything else identical. Build: `npm run build -w packages/client`.

## Phase 5 — Verification  (model: Opus / high — the gate)

1. Full `npm run build` (all packages) — must exit clean.
2. Node test against compiled dist (pattern: the archive Phase-6 harness): import
   `dist/session.js`'s ManagedSession? — heavyweight; instead test the two pure behaviors:
   a. **Extraction**: run the clauder-steps regex + JSON.parse against (i) a realistic plan
      text containing prose + a valid block (expect steps out), (ii) text with no block
      (expect null), (iii) a block with malformed JSON (expect graceful null). Test the SAME
      regex string used in ws.ts (read it from the source to avoid drift).
   b. **Restore**: construct a ManagedSession via `Object.create` or the class with a no-op
      broadcast, call `setModelPlan([{model:'claude-haiku-4-5-20251001',effort:'low',task:'x'}])`
      with config.model='claude-opus-4-8', effort='high'; drain takeNextPlanStep() twice;
      assert config.model/effort are restored to opus/high afterward. Same for stopModelPlan.
3. Grep-audit that plan turns can't leak the planning prompt into normal turns
   (the planning systemParts push must be inside an `opts?.planMode` guard).
4. Report clear pass/FAIL. Do NOT restart the server — tell Jonathan to run
   `launchctl kickstart -k gui/$(id -u)/com.jsweet.clauder` from a standalone terminal.

## Gotchas

- session.ts is load-bearing (CLAUDE.md rule 1): read before editing; add, don't refactor.
- The fallback retry re-sends through sendMessage — preserve the existing retry idioms
  (remove the user msg from history first so it isn't duplicated; see the transient-error
  retry in the catch block for the exact pattern).
- Build order: shared → server → client.
- Never let an Accept hard-fail: every parse failure degrades to the legacy accept message.
