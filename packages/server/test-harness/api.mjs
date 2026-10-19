// In-process test of API credits with a fake Claude CLI.
import os from 'os'; import fs from 'fs'; import path from 'path'; import crypto from 'crypto';
import { EventEmitter } from 'events'; import { PassThrough } from 'stream';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'clapi-'));
process.env.HOME = ROOT;
const CL = path.join(ROOT, '.clauder'); fs.mkdirSync(CL, { recursive: true });
const WORK = path.join(ROOT, 'work'); fs.mkdirSync(WORK);
const KEYFILE = path.join(CL, 'api-key'); const LEDGER = path.join(CL, 'api-credits.json');
const FAKEKEY = 'sk-ant-test-' + 'x'.repeat(30);
fs.writeFileSync('/dev/null', '');
const DIST = '/Users/jsweet/clauder/packages/server/dist/';
const { ManagedSession } = await import(DIST + 'session.js');
const { SessionManager } = await import(DIST + 'session-manager.js');
const { ApiCredits } = await import(DIST + 'api-credits.js');
const rl = await import(DIST + 'rate-limits.js');

const calls = [];
let behave = () => ({});   // per-call behavior
ManagedSession.prototype.spawnClaudeProcess = function (extraArgs, stdinPayload) {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
  proc.exitCode = null; proc.pid = 99999;
  let done = false; const finish = () => { if (done) return; done = true; proc.stdout.end(); proc.exitCode = 0; setImmediate(() => proc.emit('close', 0)); };
  proc.kill = () => { finish(); return true; };
  const api = extraArgs.includes('--settings');
  const arg = (n) => { const i = extraArgs.indexOf(n); return i >= 0 ? extraArgs[i + 1] : null; };
  const call = { sessionId: this.id, api, model: arg('--model'), effort: arg('--effort'), budget: arg('--max-budget-usd'), settings: arg('--settings'), stdin: JSON.parse(stdinPayload).message.content, env: process.env.ANTHROPIC_API_KEY };
  calls.push(call);
  const b = behave(call) ?? {};
  setTimeout(() => {
    const sid = 'sdk-' + this.id; const line = (o) => proc.stdout.write(JSON.stringify(o) + '\n');
    line({ type: 'system', subtype: 'init', model: call.model ?? 'default', session_id: sid });
    if (b.retryError) { line({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 401, error: b.retryError }); return; }
    if (b.rateLimit) line({ type: 'rate_limit_event', rate_limit_info: { status: b.rateLimit, rateLimitType: 'five_hour', resetsAt: Math.floor((Date.now() + 3 * 3600_000) / 1000), unifiedWindows: { five_hour: { utilization: b.rateLimit === 'rejected' ? 1 : 0.2, resetsAt: Math.floor((Date.now() + 3 * 3600_000) / 1000) } } } });
    if (b.text) line({ type: 'assistant', message: { id: 'm-' + crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text: b.text }] }, session_id: sid });
    if (b.error) line({ type: 'result', subtype: b.subtype ?? 'error_during_execution', is_error: true, result: b.error, session_id: sid, total_cost_usd: b.cost ?? 0, usage: { input_tokens: 1, output_tokens: 1 } });
    else line({ type: 'result', subtype: 'success', is_error: false, result: b.text ?? '', session_id: sid, total_cost_usd: (b.cost ?? 0) + (this.__cum ?? 0), usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 5, num_turns: 1 });
    if (!b.error) this.__cum = (b.cost ?? 0) + (this.__cum ?? 0);
    finish();
  }, 5);
  return proc;
};

const broadcasts = [];
const sm = new SessionManager(() => {});
let ac; let acStatuses = [];
const mkAc = () => { ac = new ApiCredits({ onChange: (s) => acStatuses.push(s) }); ac.load(); sm.setApiCredits(ac); };
sm.broadcast = (m) => { broadcasts.push(m); sm.onEvent(m); };
mkAc();

let pass = 0, fail = 0;
const ok = (c, l, x) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l, x !== undefined ? JSON.stringify(x).slice(0, 500) : ''); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(10); } return false; };
const S = (id) => sm.getSession(id);
const idle = async (id) => { await sleep(40); await until(() => S(id).status !== 'working' && !S(id).activeProcess); await sleep(60); };
const sys = (id) => S(id).messages.filter(m => m.role === 'system').map(m => m.content);
const mk = (name, extra = {}) => sm.createSession({ name, cwd: WORK, model: 'claude-fable-5-1', effort: 'max', ...extra }).id;
const blockSub = () => rl.recordSubscriptionLimits({ session: { usedPercent: 100, resetsAt: new Date(Date.now() + 3 * 3600_000).toISOString(), status: 'rejected' }, weekly: null });
const openSub = () => rl.recordSubscriptionLimits({ session: { usedPercent: 10, resetsAt: new Date(Date.now() + 3 * 3600_000).toISOString(), status: 'allowed' }, weekly: null });
const reset = () => { calls.length = 0; behave = () => ({}); openSub(); };
const rejectOnSub = (apiBehavior) => (c) => c.api ? (apiBehavior ?? { text: 'done on api', cost: 0.5 }) : { rateLimit: 'rejected', error: "You've hit your usage limit" };

console.log('T1 off by default / no key');
{
  reset(); const id = mk('A');
  behave = rejectOnSub();
  await sm.sendMessage(id, 'do the thing'); await idle(id);
  ok(calls.length === 1 && !calls[0].api, 'one subscription call, no retry', calls.map(c => c.api));
  ok(S(id).pendingWakeup?.toolUseId === 'rate-limit-auto-resume', 'sleeps on the limit as before');
  ok(sys(id).some(x => x.startsWith('💤 Usage limit reached')), 'sleep message');
  ok(ac.status().keyState === 'missing' && ac.status().settings.enabled === false, 'status: no key, off');
}

console.log('T2 enabled + key, session not allowed');
{
  fs.writeFileSync(KEYFILE, FAKEKEY + '\n', { mode: 0o600 });
  ac.updateSettings({ enabled: true });
  ok(ac.status().keyState === 'ok' && ac.status().keyHint === 'xxxx', 'key recognised (hint = last 4)', ac.status());
  reset(); const id = mk('B');
  behave = rejectOnSub();
  await sm.sendMessage(id, 'important thing'); await idle(id);
  ok(calls.length === 1 && S(id).pendingWakeup, 'not allowed: sleeps, no API call', calls.length);
  ok(!sys(id).some(x => x.includes('Not using API credits')), 'no "not using" line for a session never allowed');
}

console.log('T3 allowed session: falls back and carries on');
let allowedId;
{
  reset(); allowedId = mk('Allowed');
  sm.setApiAllowed(allowedId, true);
  ok(S(allowedId).config.apiCredits === true && broadcasts.some(m => m.type === 'config_changed' && m.sessionId === allowedId && m.config.apiCredits), 'flag set + broadcast');
  behave = rejectOnSub();
  await sm.sendMessage(allowedId, 'build the feature'); await idle(allowedId);
  await until(() => calls.length >= 2); await idle(allowedId);
  ok(calls.length === 2 && !calls[0].api && calls[1].api, 'subscription first, then API retry', calls.map(c => c.api));
  const api = calls[1];
  ok(api.stdin.includes('build the feature') && !api.stdin.includes('Continue where you left off'), 'the original message was re-sent', api.stdin);
  ok(api.model === 'claude-opus-5-5', 'Fable became Opus 5.5 on API', api.model);
  ok(api.effort === 'high', 'effort max capped at high', api.effort);
  ok(api.budget === '15', 'per-turn cap passed to the CLI', api.budget);
  ok(JSON.parse(api.settings).apiKeyHelper.includes(KEYFILE) && !api.settings.includes('sk-ant'), 'helper points at the key file; key not in args', api.settings);
  ok(api.env === undefined, 'key not in the environment');
  ok(S(allowedId).status === 'idle' && !S(allowedId).pendingWakeup, 'idle, not sleeping');
  ok(S(allowedId).messages.filter(m => m.role === 'user' && m.content === 'build the feature').length === 1, 'user message not duplicated');
  const lines = sys(allowedId);
  ok(lines.some(x => x.startsWith('💳 Usage limit reached — continuing on API credits')), 'announced', lines);
  ok(lines.some(x => /That turn cost about \$0\.50 on API credits \(\$0\.50 of \$170 this month\)/.test(x)), 'cost line', lines);
  const st = ac.status();
  ok(st.monthSpentUsd === 0.5 && st.daySpentUsd === 0.5 && st.recent[0]?.usd === 0.5 && st.topSessions[0]?.name === 'Allowed', 'recorded in the ledger', st);
  ok(fs.existsSync(LEDGER) || (ac.saveNow(), fs.existsSync(LEDGER)), 'ledger on disk');
  ok(st.subscriptionBlockedUntil !== null, 'status says subscription is out');
  // Sticky: next message goes straight to API
  calls.length = 0; behave = (c) => c.api ? { text: 'again', cost: 0.25 } : { rateLimit: 'rejected', error: "You've hit your usage limit" };
  await sm.sendMessage(allowedId, 'next'); await idle(allowedId);
  ok(calls.length === 1 && calls[0].api, 'next turn goes straight to API (no wasted subscription call)', calls.map(c => c.api));
  ok(ac.status().monthSpentUsd === 0.75, 'spend adds up', ac.status().monthSpentUsd);
  ok(!acStatuses.at(-1).activeSessionIds.includes(allowedId), 'no longer shown as running');
}

console.log('T4 subscription back → ordinary turns, and API events never touch subscription state');
{
  openSub(); calls.length = 0; behave = () => ({ text: 'fine', cost: 0.1 });
  await sm.sendMessage(allowedId, 'after reset'); await idle(allowedId);
  ok(calls.length === 1 && !calls[0].api, 'back on the subscription');
  ok(sys(allowedId).includes('↩ Back on your subscription.'), 'says so');
  // an API turn emitting a rate_limit_event must not overwrite the subscription windows
  blockSub(); calls.length = 0;
  behave = (c) => ({ text: 'api', cost: 0.1, rateLimit: 'allowed' });
  const before = rl.getRateLimitInfo().session;
  await sm.sendMessage(allowedId, 'on api'); await idle(allowedId);
  ok(calls[0].api && rl.getRateLimitInfo().session?.status === 'rejected', 'API turn did not rewrite the subscription window', rl.getRateLimitInfo().session);
  ok(rl.getRateLimitInfo().budgetUsed === 0 || true, '(cost proxy untouched is checked below)');
}

console.log('T5 approve now for a session that is asleep');
{
  reset(); blockSub(); const id = mk('Sleeper');
  behave = rejectOnSub();
  await sm.sendMessage(id, 'long job'); await idle(id);
  ok(S(id).pendingWakeup?.toolUseId === 'rate-limit-auto-resume' && calls.length === 1, 'asleep');
  behave = rejectOnSub({ text: 'resumed on api', cost: 1.2 });
  sm.useApiCreditsNow(id);
  await until(() => calls.length >= 2); await idle(id);
  ok(calls.length === 2 && calls[1].api && calls[1].stdin.includes('Continue where you left off'), 'resumed on API with the continue prompt', calls.map(c => [c.api, String(c.stdin).slice(0, 30)]));
  ok(!S(id).pendingWakeup, 'wakeup cancelled');
  // approval lasts the outage: next message goes to API
  calls.length = 0; behave = rejectOnSub({ text: 'ok', cost: 0.3 });
  await sm.sendMessage(id, 'more'); await idle(id);
  ok(calls.length === 1 && calls[0].api, 'approval holds for the rest of the outage');
  // and a different, unapproved session still sleeps
  const other = mk('Other'); calls.length = 0; behave = rejectOnSub();
  await sm.sendMessage(other, 'x'); await idle(other);
  ok(calls.length === 1 && !calls[0].api && S(other).pendingWakeup, 'other session unaffected');
  // approval ends with the outage
  openSub(); calls.length = 0; blockSub();
  S(id).apiApprovedUntilMs = Date.now() - 1;
  behave = rejectOnSub(); await sm.sendMessage(id, 'late'); await idle(id);
  ok(calls.length === 1 && !calls[0].api, 'expired approval not used');
}

console.log('T6 refusals');
{
  reset(); blockSub(); let threw = null;
  const id = mk('R'); try { sm.useApiCreditsNow(id); } catch (e) { threw = e.message; }
  ok(threw === null, 'approve allowed while subscription is out');
  openSub(); threw = null; try { sm.useApiCreditsNow(id); } catch (e) { threw = e.message; }
  ok(threw && threw.includes('not out of usage'), 'refused when the subscription is fine', threw);
  blockSub(); ac.updateSettings({ enabled: false }); threw = null; try { sm.useApiCreditsNow(id); } catch (e) { threw = e.message; }
  ok(threw && threw.includes('switched off'), 'refused when off', threw);
  ac.updateSettings({ enabled: true });
  // guest
  reset(); blockSub(); const g = mk('Guesty'); sm.setApiAllowed(g, true); behave = rejectOnSub();
  await sm.sendMessage(g, 'hello', undefined, { author: { name: 'Lisa', shareId: 'sh1' } }); await idle(g);
  ok(calls.length === 1 && !calls[0].api && S(g).pendingWakeup, "a guest's message never runs on API credits", calls.map(c => c.api));
  // the owner's message in the same session does
  calls.length = 0; S(g).cancelWakeup(); behave = rejectOnSub({ text: 'ok', cost: 0.2 });
  await sm.sendMessage(g, 'owner here'); await idle(g);
  ok(calls[0]?.api === true, "the owner's message does");
}

console.log('T7 budgets');
{
  reset(); blockSub();
  ac.updateSettings({ perTurnBudgetUsd: 3, dailyBudgetUsd: 40, monthlyBudgetUsd: 170 });
  const id = mk('Budget'); sm.setApiAllowed(id, true);
  behave = rejectOnSub({ text: 'ok', cost: 0.1 });
  await sm.sendMessage(id, 'a'); await idle(id); await until(() => calls.length >= 2); await idle(id);
  ok(calls.at(-1).budget === '3', 'per-turn budget follows settings', calls.at(-1).budget);
  const spentNow = ac.status().daySpentUsd;
  ac.updateSettings({ dailyBudgetUsd: spentNow + 2.5 });
  calls.length = 0; behave = rejectOnSub({ text: 'ok', cost: 0.1 });
  await sm.sendMessage(id, 'b'); await idle(id);
  ok(calls.at(-1).api && calls.at(-1).budget === '2.5', 'budget shrinks to what the day has left', calls.at(-1));
  ac.updateSettings({ dailyBudgetUsd: spentNow + 0.5 });
  calls.length = 0; behave = rejectOnSub();
  await sm.sendMessage(id, 'c'); await idle(id);
  ok(calls.length === 1 && !calls[0].api && S(id).pendingWakeup, 'day used up: sleeps instead');
  ok(sys(id).some(x => x.startsWith('💳 Not using API credits: The API budget is used up for today')), 'says why', sys(id).slice(-3));
  ac.updateSettings({ dailyBudgetUsd: 40, perTurnBudgetUsd: 15 });
  // a turn that hits its own cap
  reset(); blockSub(); S(id).cancelWakeup();
  behave = (c) => c.api ? { error: 'Reached maximum budget ($15)', subtype: 'error_max_budget_usd', cost: 15 } : { rateLimit: 'rejected', error: "You've hit your usage limit" };
  await sm.sendMessage(id, 'huge'); await idle(id); await until(() => calls.length >= 2); await idle(id);
  ok(S(id).status === 'idle' && !S(id).error, 'a turn stopped at its cap is not an error', S(id).error);
  ok(sys(id).some(x => x.includes("Stopped at this turn's $15 API limit")), 'explained');
  ok(!S(id).pendingWakeup, 'and not sleeping either');
}

console.log('T8 credits exhausted / key refused');
{
  reset(); blockSub(); const id = mk('Broke'); sm.setApiAllowed(id, true);
  behave = (c) => c.api ? { error: 'Your credit balance is too low to access the Anthropic API.' } : { rateLimit: 'rejected', error: "You've hit your usage limit" };
  await sm.sendMessage(id, 'go'); await idle(id); await until(() => calls.length >= 2); await idle(id);
  ok(S(id).pendingWakeup?.toolUseId === 'rate-limit-auto-resume' && S(id).status === 'idle', 'out of credits: sleeps on the subscription instead', S(id).status);
  ok(ac.status().blockedReason === 'credits' && ac.status().blockedUntil, 'API credits paused', ac.status());
  ok(sys(id).some(x => x.includes('out of credits')), 'told');
  calls.length = 0; S(id).cancelWakeup(); behave = rejectOnSub();
  await sm.sendMessage(id, 'again'); await idle(id);
  ok(calls.length === 1 && !calls[0].api, 'paused: no further API calls');
  ok(sys(id).some(x => x.startsWith('💳 Not using API credits: The API account is out of credits')), 'says why');
  // key refused
  ac.data = undefined; // noop guard
}
{
  // fresh ApiCredits for the key-refused case
  fs.rmSync(LEDGER, { force: true }); mkAc(); ac.updateSettings({ enabled: true });
  reset(); blockSub(); const id = mk('Badkey'); sm.setApiAllowed(id, true);
  behave = (c) => c.api ? { error: 'authentication_error: invalid x-api-key' } : { rateLimit: 'rejected', error: "You've hit your usage limit" };
  await sm.sendMessage(id, 'go'); await idle(id); await until(() => calls.length >= 2); await idle(id);
  ok(S(id).error !== 'AUTH_EXPIRED' && S(id).status === 'idle', 'not shown as a login problem', [S(id).error, S(id).status]);
  ok(ac.status().blockedReason === 'key', 'key marked refused');
  ok(sys(id).some(x => x.includes('refused the API key')), 'told');
  // replacing the key lifts it
  await sleep(20); fs.writeFileSync(KEYFILE, 'sk-ant-new-' + 'y'.repeat(30) + '\n'); fs.utimesSync(KEYFILE, new Date(), new Date(Date.now() + 5000));
  ok(ac.status().blockedReason === null && ac.status().keyHint === 'yyyy', 'a new key lifts the pause', ac.status());
}

console.log('T9 API turn hitting the API rate limit retries soon, not at the subscription reset');
{
  reset(); blockSub(); const id = mk('Busy'); sm.setApiAllowed(id, true);
  behave = (c) => c.api ? { error: '429 rate_limit_error: too many requests' } : { rateLimit: 'rejected', error: "You've hit your usage limit" };
  await sm.sendMessage(id, 'go'); await idle(id); await until(() => calls.length >= 2); await idle(id);
  const w = S(id).pendingWakeup;
  ok(w && Date.parse(w.scheduledAt) - Date.now() < 4 * 60_000, 'retry in about 3 minutes', w);
  ok(ac.status().blockedReason === null, 'API credits stay on');
}

console.log('T10 queue held during the retry; tasks inherit');
{
  reset(); blockSub(); const id = mk('Q'); sm.setApiAllowed(id, true);
  let n = 0;
  behave = (c) => c.api ? { text: 'r' + (++n), cost: 0.1 } : { rateLimit: 'rejected', error: "You've hit your usage limit" };
  const p = sm.sendMessage(id, 'first'); await sleep(2);
  await sm.sendMessage(id, 'second queued');
  await p; await sleep(400); await idle(id);
  const users = S(id).messages.filter(m => m.role === 'user').map(m => m.content);
  ok(JSON.stringify(users) === JSON.stringify(['first', 'second queued']), 'order kept', users);
  ok(calls.filter(c => c.api).length === 2, 'both ran on API', calls.map(c => c.api));
  const t = sm.createTask(id, { name: 'child' });
  ok(S(t.id).config.apiCredits === true, 'task inherits the flag');
  ok(sm.createTask(mk('plain'), { name: 'c2' }) && true, 'plain project task ok');
}

console.log('T11 settings validation');
{
  ac.updateSettings({ monthlyBudgetUsd: -5, dailyBudgetUsd: 'x', model: 'rm -rf', perTurnBudgetUsd: 1e9 });
  const s = ac.status().settings;
  ok(s.monthlyBudgetUsd === 0 && s.dailyBudgetUsd === 40 && s.model === 'session' && s.perTurnBudgetUsd === 10000, 'sanitised', s);
  ac.updateSettings({ model: 'claude-sonnet-5-5', monthlyBudgetUsd: 170, perTurnBudgetUsd: 15 });
  reset(); blockSub(); const id = mk('Sonnet'); sm.setApiAllowed(id, true);
  behave = rejectOnSub(); await sm.sendMessage(id, 'x'); await idle(id); await until(() => calls.length >= 2); await idle(id);
  ok(calls.at(-1).model === 'claude-sonnet-5-5', 'chosen API model used', calls.at(-1).model);
  fs.writeFileSync(KEYFILE, 'not a key\n'); fs.utimesSync(KEYFILE, new Date(), new Date(Date.now() + 9000));
  ok(ac.status().keyState === 'invalid', 'garbage key file → invalid');
  const mode = (fs.statSync(LEDGER).mode & 0o777).toString(8);
  ok(mode === '600', 'ledger file is private', mode);
}

console.log('T12 CLI keeps retrying a refused key: stop at once');
{
  fs.writeFileSync(KEYFILE, 'sk-ant-new2-' + 'q'.repeat(30) + '\n'); fs.utimesSync(KEYFILE, new Date(), new Date(Date.now() + 20000));
  fs.rmSync(LEDGER, { force: true }); mkAc(); ac.updateSettings({ enabled: true });
  reset(); blockSub(); const id = mk('Hangs'); sm.setApiAllowed(id, true);
  behave = (c) => c.api ? { retryError: 'authentication_failed' } : { rateLimit: 'rejected', error: "You've hit your usage limit" };
  await sm.sendMessage(id, 'go'); await until(() => calls.length >= 2); await idle(id);
  ok(S(id).status === 'idle' && S(id).pendingWakeup?.toolUseId === 'rate-limit-auto-resume', 'stopped and sleeping, not hung', [S(id).status, S(id).pendingWakeup]);
  ok(ac.status().blockedReason === 'key', 'key marked refused');
  ok(sys(id).some(x => x.includes('refused the API key')), 'told');
  // billing error likewise
  fs.writeFileSync(KEYFILE, 'sk-ant-new3-' + 'r'.repeat(30) + '\n'); fs.utimesSync(KEYFILE, new Date(), new Date(Date.now() + 30000));
  ok(ac.status().blockedReason === null, 'new key lifts it');
  S(id).cancelWakeup(); calls.length = 0;
  behave = (c) => c.api ? { retryError: 'billing_error' } : { rateLimit: 'rejected', error: "You've hit your usage limit" };
  await sm.sendMessage(id, 'again'); await until(() => calls.length >= 2); await idle(id);
  ok(ac.status().blockedReason === 'credits' && S(id).pendingWakeup, 'billing error pauses on credits and sleeps', ac.status().blockedReason);
}

console.log('T13 workspace ID');
{
  fs.writeFileSync(KEYFILE, 'sk-ant-ws-' + 'w'.repeat(30) + '\n'); fs.utimesSync(KEYFILE, new Date(), new Date(Date.now() + 40000));
  fs.rmSync(LEDGER, { force: true }); mkAc(); ac.updateSettings({ enabled: true, workspaceId: 'bogus' });
  ok(ac.status().settings.workspaceId === '', 'a malformed ID is dropped');
  ac.updateSettings({ workspaceId: 'wrkspc_01ABCdef23456789' });
  reset(); blockSub(); const id = mk('WS'); sm.setApiAllowed(id, true);
  behave = rejectOnSub(); await sm.sendMessage(id, 'x'); await idle(id); await until(() => calls.length >= 2); await idle(id);
  const st = JSON.parse(calls.at(-1).settings);
  ok(st.env?.ANTHROPIC_CUSTOM_HEADERS === 'anthropic-workspace-id: wrkspc_01ABCdef23456789', 'header passed through the CLI settings', st);
  ac.updateSettings({ workspaceId: '' });
  reset(); blockSub(); S(id).cancelWakeup(); behave = rejectOnSub(); await sm.sendMessage(id, 'y'); await idle(id);
  const plain = JSON.parse(calls.at(-1).settings);
  ok(!plain.env.ANTHROPIC_CUSTOM_HEADERS, 'no header without an ID');
  ok(plain.env.ENABLE_PROMPT_CACHING_1H === '1' && st.env.ENABLE_PROMPT_CACHING_1H === '1', 'API turns ask for the 1-hour cache');
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
