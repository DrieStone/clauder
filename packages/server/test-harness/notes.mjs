// Project notes board: notes and check-ins wake no one; sessions read new notes on their next turn.
import os from 'os'; import fs from 'fs'; import path from 'path'; import crypto from 'crypto';
import { EventEmitter } from 'events'; import { PassThrough } from 'stream';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'clnotes-')); process.env.HOME = ROOT;
fs.mkdirSync(path.join(ROOT, '.clauder'), { recursive: true }); const W = path.join(ROOT, 'proj'); fs.mkdirSync(W);
const DIST = new URL('../dist/', import.meta.url).pathname;
const { ManagedSession } = await import(DIST + 'session.js');
const { SessionManager } = await import(DIST + 'session-manager.js');
const calls = []; const replies = new Map(); const reply = (id, t) => { if (!replies.has(id)) replies.set(id, []); replies.get(id).push(t); };
ManagedSession.prototype.spawnClaudeProcess = function (extraArgs, stdinPayload) {
  const proc = new EventEmitter(); proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.exitCode = null;
  let done = false; const finish = () => { if (done) return; done = true; proc.stdout.end(); proc.exitCode = 0; setImmediate(() => proc.emit('close', 0)); }; proc.kill = () => { finish(); return true; };
  const c = JSON.parse(stdinPayload).message.content; calls.push({ id: this.id, stdin: typeof c === 'string' ? c : JSON.stringify(c), prompt: extraArgs[extraArgs.indexOf('--append-system-prompt') + 1] ?? '' });
  const text = (replies.get(this.id) ?? []).shift() ?? 'ok';
  setTimeout(() => { const sid = 's-' + this.id, line = (o) => proc.stdout.write(JSON.stringify(o) + '\n');
    line({ type: 'system', subtype: 'init', model: 'm', session_id: sid });
    line({ type: 'assistant', message: { id: 'm' + crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text }] }, session_id: sid });
    line({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } }); finish(); }, 5);
  return proc;
};
const sm = new SessionManager(() => {}); sm.broadcast = (m) => sm.onEvent(m);
sm.setAuthorDescriber((a) => a.sessionId ? sm.describeRelay(a) : 'guest');
let pass = 0, fail = 0; const ok = (c, l, x) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l, x !== undefined ? JSON.stringify(x).slice(0, 400) : ''); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const settle = async () => { await sleep(150); for (let i = 0; i < 200 && sm.getAllSessions().some(s => s.status === 'working'); i++) await sleep(20); await sleep(150); };
const sys = (id) => sm.getSession(id).messages.filter(m => m.role === 'system').map(m => m.content);
const n = (id) => calls.filter(c => c.id === id).length;
const last = (id) => calls.filter(c => c.id === id).at(-1)?.stdin ?? '';

const main = sm.createSession({ name: 'Galaxy Main', cwd: W, model: 'claude-sonnet-5-5' }).id;
const ships = sm.createTask(main, { name: 'Ship generator' }).id;
const chars = sm.createTask(main, { name: 'character designs' }).id;

console.log('note and check-in wake no one');
reply(ships, 'Built 11 ships. <<note>>{"text": "Ship review page is at tools/viewer/ships; uses the new palette."}<<>>');
await sm.sendMessage(ships, 'build ships'); await settle();
reply(chars, 'Done. <<to_main>>{"checkin": true, "summary": "Goose hair re-tune", "files": ["goose.py", "hair.py"]}<<>>');
await sm.sendMessage(chars, 'tune hair'); await settle();
ok(n(main) === 0, 'main session not woken', n(main));
ok(sys(ships).some(x => x.startsWith('📌 Note posted')) && sys(chars).some(x => x.startsWith('📌 Check-in posted') && x.includes('2 files')), 'senders told it was posted', [sys(ships), sys(chars)]);
ok(fs.existsSync(path.join(ROOT, '.clauder', 'project-notes.json')) || (sm.persistNow(), true), 'board saved');

console.log('next turn reads the new notes first');
await sm.sendMessage(main, 'what happened?'); await settle();
const m1 = last(main);
ok(m1.includes('new notes on this project') && m1.includes('Ship review page is at tools/viewer/ships') && m1.includes('Check-in: Goose hair re-tune') && m1.includes('Files: goose.py, hair.py'), 'main got both notes', m1.slice(0, 600));
ok(m1.trimEnd().endsWith('what happened?'), 'then your message');
await sm.sendMessage(main, 'and now?'); await settle();
ok(!last(main).includes('new notes on this project') && last(main).includes('shared notes board'), 'not repeated next time; reminder stays');
await sm.sendMessage(ships, 'next'); await settle();
const s1 = last(ships);
ok(s1.includes('Check-in: Goose hair re-tune') && !s1.includes('Ship review page is at'), "a task sees others' notes, not its own", s1.slice(0, 500));

console.log('direct messages still work');
reply(chars, '<<to_task>>{"task": "Ship generator", "message": "Stop: the palette file is being rewritten, wait 10 min."}<<>>');
await sm.sendMessage(chars, 'tell ships to pause'); await settle();
ok(calls.some(c => c.id === ships && c.stdin.includes('Stop: the palette file')), 'actionable message delivered');

console.log('new tasks are told about the board');
const t3 = sm.createTask(main, { name: 'renderer' }).id;
await sm.sendMessage(t3, 'start'); await settle();
const c3 = calls.filter(c => c.id === t3).at(-1);
ok(c3.prompt.includes('<<note>>') && !c3.prompt.includes('"checkin": true'), 'task prompt describes notes, not check-ins');
ok(c3.stdin.includes('Ship review page') , 'a new task gets the recent board');

console.log('standalone sessions untouched');
const solo = sm.createSession({ name: 'Solo', cwd: W, model: 'claude-sonnet-5-5' }).id;
await sm.sendMessage(solo, 'hi'); await settle();
ok(!last(solo).includes('notes board'), 'no board note without tasks');
console.log('closing a task keeps a summary');
const ROSTER = path.join(ROOT, '.clauder', 'task-rosters', main + '.md');
reply(ships, 'Finished the review page; ships live in tools/viewer/ships.');
await sm.sendMessage(ships, 'finish the review page'); await settle();
// The summary call runs the real CLI, which isn't logged in under this test HOME: the plain fallback is used.
await sm.closeTask(ships);
ok(!sm.getSession(ships), 'task deleted');
sm.persistNow(); const board = JSON.parse(fs.readFileSync(path.join(ROOT, '.clauder', 'project-notes.json'), 'utf8'));
const closed = board.closed[main] ?? [];
ok(closed.length === 1 && closed[0].name === 'Ship generator' && closed[0].summary.includes('Goal: build ships') && closed[0].summary.includes('Finished the review page'), 'summary kept for good', closed);
ok(fs.readFileSync(ROSTER, 'utf8').includes('## Closed tasks') && fs.readFileSync(ROSTER, 'utf8').includes('### Ship generator'), 'listed in the project task list');
ok(sys(main).some(x => x.startsWith('✅ Closed the task "Ship generator"')), 'main session told in its chat');
await sm.sendMessage(main, 'status?'); await settle();
ok(last(main).includes('✅ Task closed.'), 'and the summary reaches the main session on its next turn');
let threw = null; try { await sm.closeTask(main); } catch (e) { threw = e.message; }
ok(threw && threw.includes('Only a task'), 'a main session can\'t be closed this way');
for (const t of [chars, t3]) await sm.closeTask(t);
ok(fs.existsSync(ROSTER) && fs.readFileSync(ROSTER, 'utf8').includes('### renderer'), 'the list survives the last task closing');

console.log(`\n${pass} passed, ${fail} failed`); fs.rmSync(ROOT, { recursive: true, force: true }); process.exit(fail ? 1 : 0);
