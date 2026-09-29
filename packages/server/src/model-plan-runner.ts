import type { WsOutboundMessage } from '@clauder/shared';
import type { SessionManager } from './session-manager.js';

/**
 * ModelPlanRunner — the server-side driver for multi-step "model plans". Wired into the
 * composed broadcast (index.ts) exactly like GoalSupervisor/ProjectRunner. When a session
 * with a running `config.modelPlan` goes idle, it advances one step: sets that step's model +
 * effort on the session, then sends the step's task as an internal message so that turn runs
 * on the chosen model. Repeats each idle until the plan is exhausted.
 *
 * All the plan state + step logic lives on ManagedSession (setModelPlan/takeNextPlanStep/
 * stopModelPlan); this class is just the idle trigger.
 */
export class ModelPlanRunner {
  /** Sessions with an advance() in flight — guards against overlapping idle events. */
  private advancing = new Set<string>();

  constructor(
    private sessionManager: SessionManager,
    private broadcast: (msg: WsOutboundMessage) => void,
  ) {}

  /** Hook into the broadcast stream; act only on idle sessions with a running plan. */
  onEvent(msg: WsOutboundMessage): void {
    if (msg.type !== 'state_change' || msg.status !== 'idle') return;
    const session = this.sessionManager.getSession(msg.sessionId);
    if (session?.config.modelPlan?.status === 'running') this.advance(session.id);
  }

  /** After a restart, resume any plan that was mid-run (restored sessions are idle and never
   *  emit a state_change, so without this a running plan would sit untouched). */
  kickstartActivePlans(): void {
    for (const state of this.sessionManager.getAllSessions()) {
      if (state.config.modelPlan?.status !== 'running') continue;
      const session = this.sessionManager.getSession(state.id);
      if (session && session.status === 'idle') {
        console.log(`[ModelPlanRunner] Resuming model plan on ${session.id} after restart`);
        this.advance(session.id);
      }
    }
  }

  private advance(sessionId: string): void {
    if (this.advancing.has(sessionId)) return;
    this.advancing.add(sessionId);
    try {
      const session = this.sessionManager.getSession(sessionId);
      if (!session) return;
      const step = session.takeNextPlanStep();
      if (!step) return; // plan finished (or cleared) — takeNextPlanStep handled cleanup
      session.setModel(step.model);
      session.setEffort(step.effort);
      // Send as internal so it doesn't stop the plan (a genuine user message would).
      this.sessionManager.sendMessage(sessionId, `[Model plan step] ${step.task}`, [], { internal: true })
        .catch(err => console.error(`[ModelPlanRunner] step send failed for ${sessionId}:`, err.message));
    } finally {
      this.advancing.delete(sessionId);
    }
  }
}
