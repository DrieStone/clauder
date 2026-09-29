import type { WsOutboundMessage } from '@clauder/shared';
import type { SessionManager } from './session-manager.js';
import type { TriggerManager } from './triggers.js';
import type { ManagedSession } from './session.js';
import { getRateLimitInfo } from './rate-limits.js';

/**
 * GoalSupervisor — the server-side half of "Goal Mode". Wired into the composed broadcast
 * (index.ts) exactly like ProjectRunner, it watches `state_change` events and acts only on
 * sessions that have an active `config.goal`.
 *
 * The decision tree runs when a goal-mode session goes idle (mirrors the user's "secondary
 * reviewer"): deadline? → out of credits? → already scheduled? → actually done? → nudge or
 * escalate. Crucially, a rate-limit block SLEEPS until the window resets and does NOT consume
 * a nudge, so a multi-hour goal never dies to a burst of check-ins during an outage.
 */
export class GoalSupervisor {
  /** Sessions with a superviseIdle() in flight — guards against overlapping async checks. */
  private supervising = new Set<string>();

  constructor(
    private sessionManager: SessionManager,
    private getTriggers: () => TriggerManager,
    private broadcast: (msg: WsOutboundMessage) => void,
  ) {}

  /** After a server restart, resume supervision of any still-active goals. Restored sessions
   *  are idle and never emit a state_change, so without this an active goal would sit untouched
   *  until the user messaged it. Sleeping goals need nothing here — their persisted resume
   *  trigger re-fires on its own. Called once at startup after sessions + triggers are loaded. */
  kickstartActiveGoals(): void {
    for (const state of this.sessionManager.getAllSessions()) {
      if (state.config.goal?.status !== 'active') continue;
      const session = this.sessionManager.getSession(state.id);
      if (session && session.status === 'idle') {
        console.log(`[GoalSupervisor] Resuming active goal on ${session.id} after restart`);
        this.superviseIdle(session).catch(err =>
          console.error(`[GoalSupervisor] kickstart failed for ${session.id}:`, err));
      }
    }
  }

  /** Hook into the broadcast stream. Acts only on sessions with an active goal. */
  onEvent(msg: WsOutboundMessage): void {
    if (msg.type !== 'state_change') return;
    const session = this.sessionManager.getSession(msg.sessionId);
    const goal = session?.config.goal;
    if (!session || !goal) return;

    if (msg.status === 'working') {
      // Any real activity un-sleeps a rate-limited goal (the resume trigger fired, or the
      // user sent a message). From here normal idle-driven supervision takes over again.
      if (goal.status === 'sleeping') session.updateGoal(g => { g.status = 'active'; });
      return;
    }

    if (goal.status !== 'active') return; // sleeping → waiting on trigger; terminal → done

    if (msg.status === 'idle') {
      this.superviseIdle(session).catch(err =>
        console.error(`[GoalSupervisor] supervise failed for ${session.id}:`, err));
    } else if (msg.status === 'error') {
      this.handleError(session);
    }
  }

  /** On error, only handle the out-of-credits case (sleep until reset). Other errors surface
   *  through the normal error UI; the goal stays active and resumes when the session next idles. */
  private handleError(session: ManagedSession): void {
    const rl = getRateLimitInfo();
    if (rl.session?.status === 'rejected') {
      this.sleepUntilReset(session, rl.session?.resetsAt ?? rl.weekly?.resetsAt ?? null);
    }
  }

  private async superviseIdle(session: ManagedSession): Promise<void> {
    if (this.supervising.has(session.id)) return;
    this.supervising.add(session.id);
    try {
      const goal = session.config.goal;
      if (!goal || goal.status !== 'active') return;

      // A model plan is driving this session's turns right now — let it finish before goal
      // supervision resumes, so the two don't both send messages on the same idle.
      if (session.config.modelPlan?.status === 'running') return;

      // 1. Deadline reached → stop.
      if (Date.now() > new Date(goal.deadlineAt).getTime()) {
        session.completeGoal(`Deadline reached (${new Date(goal.deadlineAt).toLocaleString()}).`, 'expired');
        return;
      }

      // 2. Out of credits / rate-limited → sleep until reset. Does NOT burn a nudge.
      const rl = getRateLimitInfo();
      if (rl.session?.status === 'rejected') {
        this.sleepUntilReset(session, rl.session?.resetsAt ?? rl.weekly?.resetsAt ?? null);
        return;
      }

      // 3. The session already scheduled its own check-in (ScheduleWakeup or a trigger) →
      //    it will resume itself; leave it alone.
      const hasWakeup = !!session.pendingWakeup;
      const hasTrigger = this.getTriggers().list({ sessionId: session.id }).some(t => t.enabled);
      if (hasWakeup || hasTrigger) return;

      // 4. Maybe it quietly finished without declaring it — verify before nudging. Runs a
      //    cheap Haiku check through the CLI (subscription auth; no API key, no extra $).
      if (await session.reviewGoalMet(goal.text)) {
        session.completeGoal('Verified complete by the goal reviewer.', 'complete');
        return;
      }

      // 5. Did real work (tool calls) since the last check? If so, it's making progress —
      //    reset the no-progress counter so a working session is never falsely marked stuck.
      const toolUses = countToolUses(session);
      if (toolUses > goal.progressMark) {
        session.updateGoal(g => { g.nudgeCount = 0; g.progressMark = toolUses; });
      }

      // 6. Too many no-progress check-ins → escalate to the user.
      if (session.config.goal!.nudgeCount >= goal.maxNudges) {
        session.markGoalStuck();
        return;
      }

      // 7. Nudge: continue, schedule a check-in, complete, or ask for help.
      session.updateGoal(g => {
        g.nudgeCount += 1;
        g.lastNudgeAt = new Date().toISOString();
        g.progressMark = toolUses;
      });
      const g = session.config.goal!;
      const nudge =
        `[Goal-mode check-in] You're in goal mode working toward:\n"${g.text}"\n\n` +
        `It doesn't look complete and nothing is scheduled. Do ONE of these now:\n` +
        `- If a long-running process is still in flight, call the ScheduleWakeup tool (~${g.checkEveryMin} min) to check back on it, then end the turn — don't stop and wait.\n` +
        `- If there's more work to do, continue with it now.\n` +
        `- If the goal is actually complete, emit on its own line: <<goal_complete>>{"summary":"<what was accomplished>"}<<>>\n` +
        `- If you're truly blocked and need me (credentials, an irreversible call), say so plainly and stop.\n` +
        `(check-in ${g.nudgeCount}/${g.maxNudges} — I'll keep checking until the goal is met or the deadline passes)`;
      this.sessionManager.sendMessage(session.id, nudge, [], { internal: true }).catch(err =>
        console.error(`[GoalSupervisor] nudge send failed for ${session.id}:`, err.message));
    } finally {
      this.supervising.delete(session.id);
    }
  }

  /** Sleep the goal through a rate-limit window: mark it sleeping and schedule a persisted
   *  one-shot trigger to resume just after the window resets. The trigger survives restarts
   *  and self-deletes after firing. No nudge is consumed. */
  private sleepUntilReset(session: ManagedSession, resetsAt: string | null): void {
    // The session-level auto-resume (session.ts sleepUntilRateLimitReset — armed for EVERY
    // rate-limited session) may already have a wakeup pending; don't schedule a duplicate.
    // The goal still flips to 'sleeping' below so supervision resumes on the next activity.
    if (session.pendingWakeup) {
      session.updateGoal(g => { g.status = 'sleeping'; });
      return;
    }
    const resetMs = resetsAt ? new Date(resetsAt).getTime() : NaN;
    const at = !isNaN(resetMs) && resetMs > Date.now()
      ? new Date(resetMs + 60_000).toISOString()          // +60s buffer past the reset boundary
      : new Date(Date.now() + 60 * 60_000).toISOString();  // fallback: try again in 1h

    // Don't stack duplicate resume triggers if we sleep again before the first fires.
    const already = this.getTriggers()
      .list({ sessionId: session.id })
      .some(t => t.enabled && t.description === RESUME_DESC);

    session.updateGoal(g => { g.status = 'sleeping'; });

    if (!already) {
      this.getTriggers().create({
        sessionId: session.id,
        description: RESUME_DESC,
        source: 'scheduled',
        schedule: { type: 'once', at },
        message: `[Goal-mode resume] The rate-limit window has reset. Continue working toward your goal: "${session.config.goal?.text ?? ''}".`,
      });
    }
    session.emitSystemMessage(`💤 Rate limit reached — sleeping until ${new Date(at).toLocaleString()}, then resuming the goal automatically.`);
    console.log(`[GoalSupervisor] ${session.id} sleeping until ${at} (rate limit)`);
  }
}

const RESUME_DESC = 'Resume goal after rate-limit reset';

function countToolUses(session: ManagedSession): number {
  let n = 0;
  for (const m of session.messages) if (m.toolUses) n += m.toolUses.length;
  return n;
}
