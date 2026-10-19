import os from 'os'; import fs from 'fs'; import path from 'path'; import crypto from 'crypto';
import { EventEmitter } from 'events'; import { PassThrough } from 'stream';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'clxs-')); process.env.HOME = ROOT;
fs.mkdirSync(path.join(ROOT, '.clauder'), { recursive: true });
const D = (n) => { const p = path.join(ROOT, n); fs.mkdirSync(p, { recursive: true }); return p; };
const DIST = '/Users/jsweet/clauder/packages/server/dist/';
const { ManagedSession } = await import(DIST + 'session.js');
const { SessionManager } = await import(DIST + 'session-manager.js');
const calls = []; const replies = new Map(); const reply = (id, t) => { if (!replies.has(id)) replies.set(id, []); replies.get(id).push(t); };
ManagedSession.prototype.spawnClaudeProcess = function (extraArgs, stdinPayload) {
  const proc = new EventEmitter(); proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.exitCode = null;
  let done = false; const finish = () => { if (done) return; done = true; proc.stdout.end(); proc.exitCode = 0; setImmediate(() => proc.emit('close', 0)); }; proc.kill = () => { finish(); return true; };
  const c = JSON.parse(stdinPayload).message.content; calls.push({ id: this.id, stdin: typeof c === 'string' ? c : JSON.stringify(c) });
  const text = (replies.get(this.id) ?? []).shift() ?? 'ok';
  setTimeout(() => { const sid = 's-' + this.id, line = (o) => proc.stdout.write(JSON.stringify(o) + '\n');
    line({ type: 'system', subtype: 'init', model: 'm', session_id: sid });
    line({ type: 'assistant', message: { id: 'm' + crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text }] }, session_id: sid });
    line({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } }); finish(); }, 5);
  return proc;
};
const sm = new SessionManager(() => {}); sm.broadcast = (m) => sm.onEvent(m);
let shared = new Set(); sm.setIsShared((p) => shared.has(p));
sm.setAuthorDescriber((a) => a.sessionId ? sm.describeRelay(a) : 'guest');
let pass = 0, fail = 0; const ok = (c, l, x) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l, x !== undefined ? JSON.stringify(x).slice(0, 400) : ''); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const S = (id) => sm.getSession(id);
const settle = async () => { await sleep(150); for (let i = 0; i < 200 && [...sm.getAllSessions()].some(s => s.status === 'working'); i++) await sleep(20); await sleep(150); };
const sys = (id) => S(id).messages.filter(m => m.role === 'system').map(m => m.content);
const last = (id) => calls.filter(c => c.id === id).at(-1)?.stdin ?? '';
const mk = (name) => sm.createSession({ name, cwd: D(name.replace(/\W/g, '')), model: 'claude-sonnet-5-5' }).id;
const core = mk('Wedding Games Core'), hh = mk('Honeymoon Hustle'), gr = mk('Galaxy Rangers RPG');

console.log('not whitelisted');
reply(core, 'Sending. <<to_session>>{"session": "Honeymoon Hustle", "message": "Bump the version to 1.2"}<<>>');
await sm.sendMessage(core, 'tell HH to bump the version'); await settle();
ok(!calls.some(c => c.id === hh), 'not delivered');
ok(sys(core).some(x => x.includes("isn't allowed to message \"Honeymoon Hustle\"")), 'explained', sys(core));
ok(!last(core).includes('Sessions you may message'), 'no reach note without a whitelist');

console.log('whitelisted');
sm.setCanMessage(core, [hh]);
ok(JSON.stringify(S(core).config.canMessage) === JSON.stringify([hh]), 'whitelist saved on the session');
reply(core, '<<to_session>>{"session": "honeymoon hustle", "message": "Bump the version to 1.2"}<<>>');
reply(hh, 'Done. <<to_session>>{"session": "Wedding Games Core", "message": "Bumped to 1.2 and committed."}<<>>');
await sm.sendMessage(core, 'tell HH to bump the version'); await settle();
ok(last(core).includes('Sessions you may message: "Honeymoon Hustle"') || calls.filter(c => c.id === core).some(c => c.stdin.includes('Sessions you may message: "Honeymoon Hustle"')), 'sender told who it can message');
const hhIn = calls.find(c => c.id === hh)?.stdin ?? '';
ok(hhIn.includes('Bump the version to 1.2') && hhIn.includes('a Claude session of another project') && hhIn.includes('"session": "Wedding Games Core"'), 'delivered with a cross-project note and how to answer', hhIn.slice(0, 400));
ok(S(hh).messages.some(m => m.author?.crossProject && m.author.name === 'Wedding Games Core'), 'shown as from Wedding Games Core');
ok(calls.filter(c => c.id === core).some(c => c.stdin.includes('Bumped to 1.2 and committed.')), 'the reply came back though HH has no whitelist');
ok(sys(core).some(x => x === '📤 Sent to "Honeymoon Hustle".') && sys(hh).some(x => x === '📤 Sent to "Wedding Games Core".'), 'both sides show a sent line');

console.log('reply window only covers who messaged it');
reply(hh, '<<to_session>>{"session": "Galaxy Rangers RPG", "message": "hi"}<<>>');
await sm.sendMessage(hh, 'ping GR'); await settle();
ok(!calls.some(c => c.id === gr), 'HH still cannot wake Galaxy Rangers');

console.log('loop guard');
const a = mk('Ping'), b = mk('Pong'); sm.setCanMessage(a, [b]); sm.setCanMessage(b, [a]);
for (let i = 0; i < 30; i++) { reply(a, '<<to_session>>{"session": "Pong", "message": "ping"}<<>>'); reply(b, '<<to_session>>{"session": "Ping", "message": "pong"}<<>>'); }
await sm.sendMessage(a, 'start'); await sleep(3000); await settle();
const delivered = calls.filter(c => (c.id === a || c.id === b) && /^\[Clauder: this message is from/.test(c.stdin)).length;
ok(delivered === 10, 'stops at 10 between the two projects', delivered);
ok([...sys(a), ...sys(b)].some(x => x.startsWith('⏸ Not sent to')), 'says why it stopped');
await sm.sendMessage(a, 'carry on'); await sleep(1500); await settle();
const more = calls.filter(c => (c.id === a || c.id === b) && /^\[Clauder: this message is from/.test(c.stdin)).length;
ok(more > delivered, 'a person writing lets them continue', more);

console.log('guests');
shared.add(hh); reply(core, '<<to_session>>{"session": "Honeymoon Hustle", "message": "x"}<<>>');
const before = calls.filter(c => c.id === hh).length;
await sm.sendMessage(core, 'msg hh'); await settle();
ok(calls.filter(c => c.id === hh).length === before && sys(core).some(x => x.includes('shared with a guest')), 'a shared project is never messaged');
shared.clear();

console.log('tasks and unknown names');
const t = sm.createTask(core, { name: 'Core task' }).id;
reply(t, '<<to_session>>{"session": "Honeymoon Hustle", "message": "from the task"}<<>>');
await sm.sendMessage(t, 'ask HH'); await settle();
ok(calls.filter(c => c.id === hh).some(c => c.stdin.includes('from the task')), "a task uses its project's whitelist");
reply(core, '<<to_session>>{"session": "Nope", "message": "x"}<<>>'); await sm.sendMessage(core, 'x'); await settle();
ok(sys(core).some(x => x.includes('No session named "Nope"')), 'unknown name explained');
sm.setCanMessage(core, []); ok(!('canMessage' in S(core).config), 'whitelist cleared');
console.log(`\n${pass} passed, ${fail} failed`); fs.rmSync(ROOT, { recursive: true, force: true }); process.exit(fail ? 1 : 0);
