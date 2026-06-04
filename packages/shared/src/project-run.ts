// Types for the overnight Project Runner — a server-side supervise loop that drives one
// autonomous executor session to completion against a negotiated contract.

export type RunStatus =
  | 'negotiating'  // setup chat in progress; producing/approving the contract
  | 'running'      // autonomous loop active
  | 'paused'       // hit the usage limit / budget cap; will resume at resumeAt
  | 'blocked'      // hit something it was told to defer; needs human input
  | 'done'         // verification passed, all tasks complete
  | 'failed'       // unrecoverable error
  | 'cancelled';   // stopped by the user

/** Budget/limit guardrails — the deterministic part the supervise loop enforces. */
export interface RunBudget {
  /** Pause the run if the weekly subscription window exceeds this percent (leave headroom
   *  for daytime sessions). Null = don't gate on weekly. */
  maxWeeklyPercent: number | null;
  /** Hard wall-clock stop (ISO). The run finishes and reports no matter what after this. */
  hardStopAt: string | null;
}

/** The machine-readable contract the runner enforces. The human-readable rationale,
 *  scope detail, and anticipated-blocker resolutions live in CONTRACT.md in the repo. */
export interface RunContract {
  /** Executable checks that define "done" — run in repoPath; all must exit 0.
   *  Empty means done is purely task-checklist based (no automated gate). */
  verifyCommands: string[];
  budget: RunBudget;
  /** Model for the executor's routine cycles (e.g. 'claude-sonnet-4-6'); Opus reserved
   *  for tasks the plan flags hard. */
  executorModel: string;
}

/** A persisted project run. Reconstructable from disk on restart. */
export interface ProjectRun {
  id: string;
  name: string;
  repoPath: string;
  goal: string;
  /** The executor session driving the work (also the negotiation session in phase 0). */
  executorSessionId: string | null;
  status: RunStatus;
  contract: RunContract;
  /** True once the user has approved the contract; the loop won't start until then. */
  contractApproved: boolean;
  cycleCount: number;
  /** When paused on budget: ISO time to resume + the trigger scheduled to do it. */
  resumeAt: string | null;
  resumeTriggerId: string | null;
  lastError: string | null;
  /** Short human-readable note on the latest supervise decision (shown in the UI). */
  lastNote: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
