// Keep-warm: silent pings, who gets pinged when, and the rules around it.
import os from 'os'; import fs from 'fs'; import path from 'path'; import crypto from 'crypto';
import { EventEmitter } from 'events'; import { PassThrough } from 'stream';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'clwarm-')); process.env.HOME = ROOT;
fs.mkdirSync(path.join(ROOT, '.clauder'), { recursive: true }); const W = path.join(ROOT, 'p'); fs.mkdirSync(W);
const DIST = new URL('../dist/', import.meta.url).pathname;
const { ManagedSession } = await import(DIST + 'session.js');
const { SessionManager } = await import(DIST + 'session-manager.js');
const { KeepWarm } = await import(DIST + 'keep-warm.js');
const calls = []; let delay = 5;
ManagedSession.prototype.spawnClaudeProcess = function (extraArgs, stdinPayload) {
  const proc = new EventEmitter(); proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.exitCode = null;
  let done = false; const finish = () => { if (done) return; done = true; proc.stdout.end(); proc.exitCode = 0; setImmediate(() => proc.emit('close', 0)); }; proc.kill = () => { finish(); return true; };
  const c = JSON.parse(stdinPayload).message.content; const arg = (n) => { const i = extraArgs.indexOf(n); return i >= 0 ? extraArgs[i + 1] : null; };
  calls.push({ id: this.id, stdin: typeof c === 'string' ? c : JSON.stringify(c), effort: arg('--effort'), model: arg('--model'), resume: arg('--resume') });
  const isPing = (typeof c === 'string' ? c : '').includes('keep-warm');
  setTimeout(() => { const sid = 'sdk-' + this.id, line = (o) => proc.stdout.write(JSON.stringify(o) + '\n');
    line({ type: 'system', subtype: 'init', model: 'm', session_id: sid });
    line({ type: 'assistant', message: { id: 'm' + crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text: isPing ? 'ok' : 'did work' }] }, session_id: sid });
    line({ type: 'result', subtype: 'success', is_error: false, result: 'x', session_id: sid, total_cost_usd: (this.__c = (this.__c ?? 0) + (isPing ? 0.18 : 1)), usage: { input_tokens: 1, output_tokens: 1 } }); finish(); }, isPing ? delay : 5);
  return proc;
};
const seen = []; const sm = new SessionManager(() => {}); sm.broadcast = (m) => { seen.push(m); sm.onEvent(m); };
let pass = 0, fail = 0; const ok = (c, l, x) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l, x !== undefined ? JSON.stringify(x).slice(0, 300) : ''); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const settle = async () => { await sleep(100); for (let i = 0; i < 200 && sm.getAllSessions().some(s => s.status === 'working'); i++) await sleep(20); await sleep(100); };
const S = (id) => sm.getSession(id);
const MIN = 60_000; let now = Date.now(); const statuses = [];
let quotaBlocked = false;
const kw = new KeepWarm({ sessions: () => sm.warmSessions(), ping: (id) => sm.keepWarmPing(id), quotaBlocked: () => quotaBlocked, onChange: (s) => statuses.push(s), now: () => now, file: path.join(ROOT, '.clauder', 'keep-warm.json') });
sm.onOwnerWrote((p) => kw.ownerWrote(p));

const a = sm.createSession({ name: 'Lunar', cwd: W, model: 'claude-opus-5-5', effort: 'high' }).id;
const b = sm.createSession({ name: 'Other', cwd: W, model: 'claude-sonnet-5-5' }).id;
await sm.sendMessage(a, 'work on the lander'); await settle();
await sm.sendMessage(b, 'something', [], { internal: true }); await settle();   // not the owner: no auto
const setAge = (id, mins) => { S(id).lastActiveAt = new Date(now - mins * MIN).toISOString(); };

console.log('automatic, while around');
setAge(a, 30); calls.length = 0; await kw.tick();
ok(calls.length === 0, 'not due yet at 30 min');
setAge(a, 55); setAge(b, 55); const seenBefore = seen.length; await kw.tick(); await settle();
ok(calls.length === 1 && calls[0].id === a, 'pinged the project you wrote in, only', calls.map(c => c.id));
ok(calls[0].effort === 'low' && calls[0].model === 'claude-opus-5-5' && calls[0].resume, 'same model and conversation, low effort', calls[0]);
const before = S(a).messages.length;
ok(S(a).messages.length === before && !S(a).messages.some(m => (m.content || '').includes('keep-warm')), 'no trace in the chat');
ok(Date.now() - Date.parse(S(a).lastActiveAt) > 50 * MIN || Math.abs(Date.parse(S(a).lastActiveAt) - (now - 55 * MIN)) < 2000, 'last-active time unchanged (no unread bump)');
ok(!seen.slice(seenBefore).some(m => m.sessionId === a && (m.type === 'state_change' || m.type === 'assistant_message')), 'nothing broadcast');
calls.length = 0; await kw.tick(); await settle();
ok(calls.length === 0, 'not pinged again right away');
setAge(a, 65); await kw.tick(); await settle();
ok(calls.length === 0, 'already cold: not pinged (that would cost a full re-send)');

console.log('away, quota, manual');
setAge(a, 55); now += 3 * 60 * MIN; setAge(a, 55); kw.ownerActive(); now += 2.5 * 60 * MIN; setAge(a, 55); calls.length = 0;
await kw.tick(); await settle();
ok(calls.length === 0, 'owner away 2.5h: auto warming stops');
kw.setManual(b, 3); setAge(b, 56); await kw.tick(); await settle();
ok(calls.some(c => c.id === b), 'by-hand 🔥 works while away');
ok(statuses.at(-1).projects[b]?.mode === 'manual', 'status shows it', statuses.at(-1));
ok(kw.status().sessions.includes(b) && !kw.status().sessions.includes(a), 'status names the sessions actually warm (for the 🔥 on task chips)', kw.status().sessions);
quotaBlocked = true; calls.length = 0; setAge(b, 57); await kw.tick(); await settle();
ok(calls.length === 0, 'no pings near the usage limit'); quotaBlocked = false;
now += 4 * 60 * MIN; setAge(b, 55); calls.length = 0; await kw.tick(); await settle();
ok(calls.length === 0 && !statuses.at(-1).projects[b], 'by-hand warming ends on time');

console.log('a message during a ping');
kw.setManual(a, 3); setAge(a, 55); delay = 300; calls.length = 0;
const p = kw.tick(); await sleep(60);
await sm.sendMessage(a, 'are you there?');
await p; await settle(); delay = 5;
const users = S(a).messages.filter(m => m.role === 'user').map(m => m.content);
ok(users.at(-1) === 'are you there?' && calls.at(-1).stdin.includes('are you there?'), 'your message is delivered right after', users.slice(-2));
ok(kw.status().pings >= 3 && kw.status().costUsd > 0, 'pings and cost are counted', kw.status());
console.log(`\n${pass} passed, ${fail} failed`); fs.rmSync(ROOT, { recursive: true, force: true }); process.exit(fail ? 1 : 0);
