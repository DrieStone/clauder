import { spawn } from 'child_process';
import { v4 as uuid } from 'uuid';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { WsOutboundMessage, ProjectRun, RunContract, RunBudget } from '@clauder/shared';
import type { SessionManager } from './session-manager.js';
import { getRateLimitInfo } from './rate-limits.js';
import { saveRuns, loadRuns } from './project-runs.js';

const DEFAULT_EXECUTOR_MODEL = 'claude-sonnet-5-5';
const QUESTION_TIMEOUT_SECONDS = 45;          // executor never stalls waiting on a human
const RESET_EVERY_CYCLES = 12;                // refresh executor context periodically
const MAX_CYCLES = 250;                        // backstop against a no-progress loop
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_WEEKLY_PCT = 50;

/** Lifecycle-aware system prompt for the executor session. Covers both negotiation and
 *  autonomous execution; the run transitions phases via the messages the runner sends. */
const SYSTEM_PROMPT = `You are the autonomous executor for an overnight Clauder "Project Run". You work in the project repo unsupervised for hours, then a human reviews in the morning. Two phases:

PHASE 1 — NEGOTIATION (you are here until told "Begin autonomous execution"):
Your job is to make the run bulletproof BEFORE it starts, while the human is present. Do a pre-flight risk review:
- Inspect the repo and the stated goal.
- Enumerate EVERYTHING that could block, stall, or derail an unsupervised run: missing credentials/secrets/env vars, external dependencies (APIs, paid services, accounts), ambiguous or underspecified requirements, decisions with multiple reasonable paths, anything needing access you won't have overnight, destructive/irreversible operations, and assumptions that would be costly if wrong.
- For each, ASK the human now and incorporate their answer. Keep asking until nothing foreseeable is unresolved.
Then write CONTRACT.md in the repo with these sections: Scope (task list + out-of-bounds), Done/Verify (the exact shell command(s) that prove done, or "stage for review" where subjective), Budget+Deadline, Decision Authority (what you may decide vs must defer), and Anticipated Blockers & Resolutions (each risk with the human's resolution or the pre-authorized default).
Finally, emit a machine-readable contract on its own line:
<<contract>>{"verifyCommands":["<shell cmd>", ...]}<<>>
Then tell the human the contract is ready for approval and STOP.

PHASE 2 — AUTONOMOUS EXECUTION (after "Begin autonomous execution"):
- Maintain the ledger in the repo: PLAN.md (task checkboxes "- [ ]"/"- [x]" + acceptance), STATE.json (current task, attempts, spend), DECISIONS.md (every call you made on your own + why).
- Each turn: read the ledger, do the NEXT unchecked task, update the ledger, then STOP. The supervisor will prompt you to continue.
- NEVER stall. At any fork, follow CONTRACT.md's Decision Authority: decide and log to DECISIONS.md, or — only if the contract says defer — emit <<run-blocked: short reason>> and stop.
- Do NOT claim done until the verify commands genuinely pass. When all tasks are checked and verification should pass, emit <<run-complete>> and stop.`;

export class ProjectRunner {
  private runs = new Map<string, ProjectRun>();
  private resumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stepping = new Set<string>();   // guards against overlapping supervise steps per run

  constructor(
    private sessionManager: SessionManager,
    private broadcast: (msg: WsOutboundMessage) => void,
  ) {}

  /** Restore runs after a server restart; re-arm resume timers for paused runs. */
  restoreFromDisk(): void {
    for (const run of loadRuns()) {
      this.runs.set(run.id, run);
      if (run.status === 'paused' && run.resumeAt) this.armResumeTimer(run);
    }
    if (this.runs.size) console.log(`[ProjectRunner] Restored ${this.runs.size} run(s) from disk`);
  }

  list(): ProjectRun[] { return [...this.runs.values()]; }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  createRun(input: { name: string; repoPath: string; goal: string; budget?: RunBudget; executorModel?: string }): ProjectRun {
    if (!existsSync(input.repoPath)) throw new Error(`repoPath does not exist: ${input.repoPath}`);
    const executorModel = input.executorModel || DEFAULT_EXECUTOR_MODEL;
    const session = this.sessionManager.createSession({
      name: `Run: ${input.name}`,
      cwd: input.repoPath,
      model: executorModel,
      systemPrompt: SYSTEM_PROMPT,
      questionTimeoutSeconds: QUESTION_TIMEOUT_SECONDS,
      permissionMode: 'bypassPermissions',
    });
    const run: ProjectRun = {
      id: uuid(),
      name: input.name,
      repoPath: input.repoPath,
      goal: input.goal,
      executorSessionId: session.id,
      status: 'negotiating',
      contract: {
        verifyCommands: [],
        budget: input.budget ?? { maxWeeklyPercent: DEFAULT_MAX_WEEKLY_PCT, hardStopAt: null },
        executorModel,
      },
      contractApproved: false,
      cycleCount: 0,
      resumeAt: null,
      resumeTriggerId: null,
      lastError: null,
      lastNote: 'Negotiating contract — answer the setup questions, then approve.',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    this.runs.set(run.id, run);
    this.emit(run);
    // Kick off the pre-flight negotiation.
    this.dispatch(run, `Goal for this overnight run:\n\n${input.goal}\n\nBegin PHASE 1 negotiation now: do the pre-flight risk review, ask me about every foreseeable blocker, then write CONTRACT.md and emit the machine-readable contract.`);
    return run;
  }

  /** Approve the negotiated contract and start the autonomous loop. */
  approveRun(runId: string, opts?: { budget?: RunBudget; verifyCommands?: string[] }): ProjectRun {
    const run = this.mustGet(runId);
    if (run.status !== 'negotiating') throw new Error(`Run ${runId} is not in negotiation (status: ${run.status})`);
    const parsed = this.extractContract(run.executorSessionId);
    run.contract = {
      verifyCommands: opts?.verifyCommands ?? parsed?.verifyCommands ?? run.contract.verifyCommands,
      budget: opts?.budget ?? run.contract.budget,
      executorModel: run.contract.executorModel,
    };
    run.contractApproved = true;
    run.status = 'running';
    run.startedAt = new Date().toISOString();
    run.lastNote = 'Contract approved — autonomous execution started.';
    this.emit(run);
    this.dispatch(run, 'Begin autonomous execution. Set up the ledger (PLAN.md, STATE.json, DECISIONS.md) from CONTRACT.md, then do the first task, update the ledger, and stop.');
    return run;
  }

  cancelRun(runId: string): void {
    const run = this.mustGet(runId);
    this.clearResumeTimer(runId);
    run.status = 'cancelled';
    run.finishedAt = new Date().toISOString();
    run.lastNote = 'Cancelled by user.';
    this.emit(run);
  }

  // ─── Supervise loop ───────────────────────────────────────────────────────────

  /** Hook into the broadcast stream. Acts only on the executor of a RUNNING run going idle. */
  onEvent(msg: WsOutboundMessage): void {
    if (msg.type !== 'state_change') return;
    const run = [...this.runs.values()].find(r => r.executorSessionId === msg.sessionId);
    if (!run || run.status !== 'running') return;
    if (msg.status === 'idle') {
      this.superviseStep(run).catch(err => console.error(`[ProjectRunner] step failed for ${run.id}:`, err));
    } else if (msg.status === 'error') {
      this.handleExecutorError(run);
    }
  }

  private async superviseStep(run: ProjectRun): Promise<void> {
    if (this.stepping.has(run.id)) return;
    this.stepping.add(run.id);
    try {
      if (run.status !== 'running') return;
      const session = this.sessionManager.getSession(run.executorSessionId!);
      if (!session) return this.fail(run, 'Executor session disappeared');

      // 1. Budget gate — pause and schedule resume if at/over the limit.
      const rl = getRateLimitInfo();
      const rejected = rl.session?.status === 'rejected';
      const cap = run.contract.budget.maxWeeklyPercent;
      const overWeekly = cap != null && rl.weekly?.usedPercent != null && rl.weekly.usedPercent >= cap;
      if (rejected || overWeekly) {
        const resetsAt = (rejected ? rl.session?.resetsAt : rl.weekly?.resetsAt) ?? rl.session?.resetsAt ?? null;
        return this.pauseForBudget(run, resetsAt, rejected ? 'usage limit reached' : `weekly budget cap (${cap}%) reached`);
      }

      // 2. Deadline gate.
      if (run.contract.budget.hardStopAt && Date.now() >= new Date(run.contract.budget.hardStopAt).getTime()) {
        await this.dispatchReport(run);
        return this.finish(run, 'done', 'Reached hard-stop deadline — wrapping up.');
      }

      // 3. Read the executor's signals from its last turn.
      const lastText = this.lastAssistantText(session);
      const blocked = lastText.match(/<<run-blocked:\s*([^>]*)>>/);
      if (blocked) return this.block(run, (blocked[1] || 'unspecified').trim());

      const claimsDone = /<<run-complete>>/.test(lastText) || this.allTasksChecked(run);
      if (claimsDone) {
        const result = await this.runVerification(run);
        if (run.status !== 'running') return; // could have been cancelled mid-verify
        if (result.ok) {
          await this.dispatchReport(run);
          return this.finish(run, 'done', 'Verified complete.');
        }
        run.cycleCount++;
        this.setNote(run, `Verification failed (cycle ${run.cycleCount}) — continuing.`);
        return this.dispatch(run, `Verification failed:\n\n${result.output}\n\nFix these issues, update the ledger, and continue. Do not emit <<run-complete>> until every verify command passes.`);
      }

      // 4. Not done — advance to the next task.
      if (run.cycleCount >= MAX_CYCLES) {
        return this.fail(run, `Exceeded ${MAX_CYCLES} cycles without completing — stopping to avoid a runaway loop.`);
      }
      run.cycleCount++;
      this.maybeReset(run);
      this.setNote(run, `Working — cycle ${run.cycleCount}.`);
      this.dispatch(run, 'Continue: read the ledger, do the next unchecked task in PLAN.md, update the ledger, then stop. Emit <<run-complete>> when all tasks are done and verification will pass.');
    } finally {
      this.stepping.delete(run.id);
    }
  }

  private handleExecutorError(run: ProjectRun): void {
    const session = this.sessionManager.getSession(run.executorSessionId!);
    const err = session?.error ?? 'unknown error';
    // Auth/usage errors → pause for budget if we can; otherwise surface as failed.
    const rl = getRateLimitInfo();
    if (rl.session?.status === 'rejected') {
      return this.pauseForBudget(run, rl.session.resetsAt ?? null, 'usage limit reached');
    }
    this.fail(run, `Executor error: ${err}`);
  }

  // ─── Budget pause / resume ──────────────────────────────────────────────────

  private pauseForBudget(run: ProjectRun, resetsAt: string | null, reason: string): void {
    run.status = 'paused';
    run.resumeAt = resetsAt;
    run.lastNote = `Paused: ${reason}.` + (resetsAt ? ` Resuming ${new Date(resetsAt).toLocaleString()}.` : ' Awaiting reset.');
    this.emit(run);
    if (resetsAt) this.armResumeTimer(run);
  }

  private armResumeTimer(run: ProjectRun): void {
    this.clearResumeTimer(run.id);
    if (!run.resumeAt) return;
    // Add 60-second buffer so we fire after the window has fully reset
    const delay = Math.max(1000, new Date(run.resumeAt).getTime() - Date.now()) + 60_000;
    this.resumeTimers.set(run.id, setTimeout(() => this.resumeRun(run.id), delay));
  }

  private resumeRun(runId: string): void {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'paused') return;
    this.clearResumeTimer(runId);
    run.status = 'running';
    run.resumeAt = null;
    this.setNote(run, 'Usage window reset — resuming.');
    this.dispatch(run, 'Resuming after the usage window reset. Read the ledger and continue with the next unchecked task.');
  }

  private clearResumeTimer(runId: string): void {
    const t = this.resumeTimers.get(runId);
    if (t) { clearTimeout(t); this.resumeTimers.delete(runId); }
  }

  // ─── Terminal states ──────────────────────────────────────────────────────────

  private finish(run: ProjectRun, status: 'done', note: string): void {
    this.clearResumeTimer(run.id);
    run.status = status;
    run.finishedAt = new Date().toISOString();
    run.lastNote = note;
    this.emit(run);
  }

  private block(run: ProjectRun, reason: string): void {
    this.clearResumeTimer(run.id);
    run.status = 'blocked';
    run.lastNote = `Blocked — needs you: ${reason}`;
    this.emit(run);
  }

  private fail(run: ProjectRun, message: string): void {
    this.clearResumeTimer(run.id);
    run.status = 'failed';
    run.lastError = message;
    run.lastNote = `Failed: ${message}`;
    run.finishedAt = new Date().toISOString();
    this.emit(run);
  }

  // ─── Verification ─────────────────────────────────────────────────────────────

  private async runVerification(run: ProjectRun): Promise<{ ok: boolean; output: string }> {
    const cmds = run.contract.verifyCommands;
    if (!cmds.length) return { ok: true, output: '(no verify commands configured)' };
    for (const cmd of cmds) {
      const { code, output } = await this.runOne(cmd, run.repoPath);
      if (code !== 0) return { ok: false, output: `$ ${cmd}\n(exit ${code})\n${output}` };
    }
    return { ok: true, output: '' };
  }

  private runOne(cmd: string, cwd: string): Promise<{ code: number; output: string }> {
    return new Promise((resolve) => {
      const child = spawn(cmd, { cwd, shell: true });
      let out = '';
      const onData = (d: Buffer) => { out += d.toString(); if (out.length > 20000) out = out.slice(-20000); };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: 124, output: out + '\n[verify command timed out]' }); }, VERIFY_TIMEOUT_MS);
      child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, output: out }); });
      child.on('error', (err) => { clearTimeout(timer); resolve({ code: 1, output: String(err) }); });
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private maybeReset(run: ProjectRun): void {
    if (run.cycleCount > 0 && run.cycleCount % RESET_EVERY_CYCLES === 0 && run.executorSessionId) {
      // Refresh context — the ledger on disk is the source of truth, and the continue
      // prompt re-grounds the executor from it.
      this.sessionManager.resetSession(run.executorSessionId).catch(err =>
        console.error(`[ProjectRunner] reset failed for ${run.id}:`, err));
    }
  }

  private dispatchReport(run: ProjectRun): void {
    this.dispatch(run, 'Write REPORT.md in the repo: what was completed, what verification passed, the key decisions you made on your own (from DECISIONS.md), anything left or blocked for review, and the approximate cost/effort. Be concise.');
  }

  private dispatch(run: ProjectRun, prompt: string): void {
    if (!run.executorSessionId) return;
    // internal: programmatic, so it skips task-switch classification and doesn't cancel itself.
    this.sessionManager.sendMessage(run.executorSessionId, prompt, [], { internal: true }).catch(err =>
      console.error(`[ProjectRunner] dispatch failed for ${run.id}:`, err));
    this.emit(run);
  }

  private allTasksChecked(run: ProjectRun): boolean {
    try {
      const planPath = join(run.repoPath, 'PLAN.md');
      if (!existsSync(planPath)) return false;
      const plan = readFileSync(planPath, 'utf-8');
      const hasChecked = /- \[x\]/i.test(plan);
      const hasUnchecked = /- \[ \]/.test(plan);
      return hasChecked && !hasUnchecked;
    } catch {
      return false;
    }
  }

  private lastAssistantText(session: ReturnType<SessionManager['getSession']>): string {
    if (!session) return '';
    const msgs = (session as any).messages as Array<{ role: string; content: unknown }>;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant' && typeof msgs[i].content === 'string') return msgs[i].content as string;
    }
    return '';
  }

  private extractContract(sessionId: string | null): { verifyCommands: string[] } | null {
    if (!sessionId) return null;
    const session = this.sessionManager.getSession(sessionId);
    if (!session) return null;
    const msgs = (session as any).messages as Array<{ role: string; content: unknown }>;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const c = msgs[i].content;
      if (typeof c !== 'string') continue;
      const m = c.match(/<<contract>>\s*(\{[\s\S]*?\})\s*<<>>/);
      if (m) {
        try {
          const parsed = JSON.parse(m[1]);
          if (Array.isArray(parsed.verifyCommands)) {
            return { verifyCommands: parsed.verifyCommands.filter((x: unknown) => typeof x === 'string') };
          }
        } catch { /* ignore malformed */ }
      }
    }
    return null;
  }

  private mustGet(runId: string): ProjectRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    return run;
  }

  private setNote(run: ProjectRun, note: string): void {
    run.lastNote = note;
    this.emit(run);
  }

  private emit(run: ProjectRun): void {
    this.broadcast({ type: 'project_run_update', run });
    saveRuns([...this.runs.values()]);
  }
}
