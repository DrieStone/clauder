// Background work that dies with its turn: warning line + recovery message.
import os from 'os'; import fs from 'fs'; import path from 'path'; import crypto from 'crypto';
import { EventEmitter } from 'events'; import { PassThrough } from 'stream';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'clbg-')); process.env.HOME = ROOT;
fs.mkdirSync(path.join(ROOT, '.clauder'), { recursive: true }); const WORK = path.join(ROOT, 'w'); fs.mkdirSync(WORK);
const DIST = '/Users/jsweet/clauder/packages/server/dist/';
const { ManagedSession } = await import(DIST + 'session.js');
const { SessionManager } = await import(DIST + 'session-manager.js');
const { BackgroundTracker } = await import(DIST + 'background-tasks.js');
const calls = []; let script = () => ({});
ManagedSession.prototype.spawnClaudeProcess = function (extraArgs, stdinPayload) {
  const proc = new EventEmitter(); proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.exitCode = null;
  let done = false; const finish = () => { if (done) return; done = true; proc.stdout.end(); proc.exitCode = 0; setImmediate(() => proc.emit('close', 0)); }; proc.kill = () => { finish(); return true; };
  const stdin = JSON.parse(stdinPayload).message.content; calls.push({ id: this.id, stdin: typeof stdin === 'string' ? stdin : JSON.stringify(stdin) });
  const b = script(calls.length, calls.at(-1)) ?? {};
  setTimeout(() => {
    const sid = 'sdk-' + this.id; const line = (o) => proc.stdout.write(JSON.stringify(o) + '\n');
    line({ type: 'system', subtype: 'init', model: 'm', session_id: sid });
    let n = 0;
    for (const step of b.steps ?? []) {
      if (step.notify) { line({ type: 'user', message: { role: 'user', content: step.notify }, session_id: sid }); continue; }
      const id = step.id ?? ('tu' + (++n) + crypto.randomUUID().slice(0, 4));
      line({ type: 'assistant', message: { id: 'm' + crypto.randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id, name: step.name, input: step.input }] }, session_id: sid });
      if (step.result) line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: step.result }] }, session_id: sid });
    }
    if (b.text) line({ type: 'assistant', message: { id: 'm' + crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text: b.text }] }, session_id: sid });
    if (b.interrupt) { finish(); return; }
    line({ type: 'result', subtype: 'success', is_error: false, result: b.text ?? '', session_id: sid, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 5, num_turns: 1 });
    finish();
  }, b.delay ?? 5);
  return proc;
};
const sm = new SessionManager(() => {}); sm.broadcast = (m) => sm.onEvent(m);
let pass = 0, fail = 0; const ok = (c, l, x) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l, x !== undefined ? JSON.stringify(x).slice(0, 400) : ''); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const S = (id) => sm.getSession(id);
const settle = async (id) => { await sleep(120); for (let i = 0; i < 100 && (S(id).status === 'working' || S(id).activeProcess); i++) await sleep(20); await sleep(120); for (let i = 0; i < 100 && (S(id).status === 'working'); i++) await sleep(20); await sleep(80); };
const sys = (id) => S(id).messages.filter(m => m.role === 'system').map(m => m.content);
const mk = (name = 'T', extra = {}) => sm.createSession({ name, cwd: WORK, model: 'claude-sonnet-5-5', ...extra }).id;
const BG = { name: 'Bash', input: { command: 'npm run long-build', description: 'long build', run_in_background: true }, result: 'Command running in background with ID: bk12ab. Output is being written to: /tmp/x.output. You will be notified when it completes.' };
const AG = { name: 'Agent', input: { description: 'check the docs', prompt: 'x', run_in_background: true }, result: 'Async agent launched successfully.\nagentId: a1b2c3 (internal ID)' };

console.log('unit: tracker');
{
  const t = new BackgroundTracker();
  t.onToolUse({ id: 'u1', name: 'Bash', input: { command: 'sleep 99', run_in_background: true } }); t.onToolResult('u1', 'Command running in background with ID: bx1. Output...');
  t.onToolUse({ id: 'u2', name: 'Agent', input: { prompt: 'dig', run_in_background: true } }); t.onToolResult('u2', 'agentId: ag9 (x)');
  t.onToolUse({ id: 'u3', name: 'Bash', input: { command: 'ls' } });
  ok(t.outstanding().length === 2 && t.outstanding()[0].id === 'bx1' && t.outstanding()[1].id === 'ag9', 'ids read from results; foreground ignored', t.outstanding());
  t.onToolUse({ id: 'u4', name: 'TaskOutput', input: { task_id: 'bx1', block: true } });
  ok(t.outstanding().length === 1 && t.outstanding()[0].id === 'ag9', 'waiting on one handles it');
  t.onToolUse({ id: 'u5', name: 'TaskStop', input: { task_id: '' } });
  ok(t.outstanding().length === 0, 'an empty id covers all');
}

console.log('turn ends with background work');
{
  const id = mk();
  script = (n) => n === 1 ? { steps: [BG], text: 'Started the build.' } : { text: 'Re-running with nohup.' };
  await sm.sendMessage(id, 'build it'); await settle(id);
  const lines = sys(id);
  ok(lines.some(x => x.startsWith('⚠️ A background task was still running when this turn ended') && x.includes('command: long build')), 'warning line', lines);
  ok(calls.length === 2, 'Claude was told', calls.length);
  ok(calls[1]?.stdin.includes('[Clauder] Your last turn ended while this background work was still running') && calls[1].stdin.includes('- command: long build') && calls[1].stdin.includes('nohup'), 'recovery message names the task and the fix');
  ok(S(id).messages.filter(m => m.role === 'user').length === 2, 'it appears as an internal message');
}

console.log('no false alarms');
{
  // waited for within the turn
  let id = mk('waited'); calls.length = 0;
  script = () => ({ steps: [BG, { name: 'TaskOutput', input: { task_id: 'bk12ab', block: true }, result: 'done' }], text: 'Build finished.' });
  await sm.sendMessage(id, 'go'); await settle(id);
  ok(calls.length === 1 && !sys(id).some(x => x.startsWith('⚠️')), 'waited on: nothing said, nothing sent', sys(id));
  // wakeup scheduled
  id = mk('woke'); calls.length = 0;
  script = () => ({ steps: [BG, { name: 'ScheduleWakeup', input: { delaySeconds: 300, reason: 'check build', prompt: 'check' }, result: 'ok' }], text: 'Will check back.' });
  await sm.sendMessage(id, 'go'); await settle(id);
  ok(calls.length === 1 && !sys(id).some(x => x.startsWith('⚠️')), 'a wakeup is coming back for it: nothing said', sys(id));
  S(id).cancelWakeup();
  // monitor sentinel
  id = mk('mon'); calls.length = 0;
  script = () => ({ steps: [BG], text: 'Watching. <<monitor>>{"command":"sleep 60","description":"build"}<<>>' });
  await sm.sendMessage(id, 'go'); await settle(id);
  ok(calls.length === 1 && !sys(id).some(x => x.startsWith('⚠️')), 'a monitor is on it: nothing said', [calls.length, sys(id)]);
  await sm.destroySession(id); await sleep(200);
  // interrupted turn (no result)
  id = mk('stopped'); calls.length = 0;
  script = () => ({ steps: [BG], interrupt: true });
  await sm.sendMessage(id, 'go'); await settle(id);
  ok(calls.length === 1 && !sys(id).some(x => x.startsWith('⚠️')), 'a stopped turn: nothing said');
  // plain turn
  id = mk('plain'); calls.length = 0; script = () => ({ steps: [{ name: 'Bash', input: { command: 'ls' }, result: 'a' }], text: 'ok' });
  await sm.sendMessage(id, 'go'); await settle(id);
  ok(calls.length === 1, 'ordinary turn untouched');
}

console.log('an agent that reports back by itself is not stranded');
{
  const id = mk('reported'); calls.length = 0;
  const done = (tid, toolId) => `<task-notification>\n<task-id>${tid}</task-id>\n<tool-use-id>${toolId}</tool-use-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>`;
  script = () => ({ steps: [{ ...AG, id: 'toolu_A1' }, { notify: done('a1b2c3', 'toolu_A1') }], text: 'All agents reported; here is the report.' });
  await sm.sendMessage(id, 'research'); await settle(id);
  ok(calls.length === 1 && !sys(id).some(x => x.startsWith('⚠️')), 'finished agent: no warning, no redo message', [calls.length, sys(id)]);
  // one finished, one still running: only the running one is reported
  const id2 = mk('half'); calls.length = 0;
  script = (k) => k === 1 ? ({ steps: [{ ...AG, id: 'toolu_B1' }, { ...BG, id: 'toolu_B2' }, { notify: done('a1b2c3', 'toolu_B1') }], text: 'one back' }) : { text: 'ok' };
  await sm.sendMessage(id2, 'go'); await settle(id2);
  const w = sys(id2).find(x => x.startsWith('⚠️')) ?? '';
  ok(w.includes('command: long build') && !w.includes('agent:'), 'only the unfinished one is reported', w);
}

console.log('loop guard, queue, goal');
{
  let id = mk('loop'); calls.length = 0;
  script = () => ({ steps: [BG], text: 'Started.' });  // keeps starting background work every turn
  await sm.sendMessage(id, 'go'); await sleep(1200); await settle(id);
  ok(calls.length === 3, 'told twice, then stops (1 + 2 recoveries)', calls.length);
  ok(sys(id).filter(x => x.startsWith('⚠️')).length === 3, 'each turn still warns');
  // a person writing resets it
  calls.length = 0; await sm.sendMessage(id, 'again please'); await sleep(1200); await settle(id);
  ok(calls.length === 3, 'a person writing starts the count over', calls.length);

  // queued person message goes first; no recovery sent over it
  id = mk('queue'); calls.length = 0;
  script = (n) => n === 1 ? { steps: [BG], text: 'Started.', delay: 300 } : { text: 'ok' };
  const p = sm.sendMessage(id, 'go'); await sleep(60); await sm.sendMessage(id, 'second from me');
  await p; await settle(id);
  const users = S(id).messages.filter(m => m.role === 'user').map(m => m.content);
  ok(users[1] === 'second from me' && !users.some(u => u.includes('[Clauder] Your last turn ended')), 'a queued message from a person goes first and the recovery is dropped', users.map(u => u.slice(0, 40)));
  ok(sys(id).some(x => x.startsWith('⚠️')), 'but the warning still shows');

  // goal mode drives itself: warn, don't send
  id = mk('goal', { goal: { text: 'ship it', status: 'active', startedAt: new Date().toISOString(), nudgeCount: 0, maxNudges: 0 } }); calls.length = 0;
  script = () => ({ steps: [BG], text: 'Started.' });
  await sm.sendMessage(id, 'go'); await settle(id);
  ok(!calls.slice(1).some(c => c.stdin.includes('[Clauder] Your last turn ended')) && sys(id).some(x => x.startsWith('⚠️')), 'goal mode: warns, does not message');
}
console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(ROOT, { recursive: true, force: true }); process.exit(fail ? 1 : 0);
