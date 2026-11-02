// "Start fresh" (SessionManager.sendFresh) with a fake CLI: the message goes to a NEW conversation
// (no --resume) carrying the summary note and the old conversation's path, once; the chat keeps
// its history; later messages resume the new conversation with no note. The summary one-shot runs
// the real CLI under a throwaway HOME, which isn't logged in, so this also covers the fallback.
import os from 'os'; import fs from 'fs'; import path from 'path'; import crypto from 'crypto';
import { EventEmitter } from 'events'; import { PassThrough } from 'stream';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'clfresh-')); process.env.HOME = ROOT;
fs.mkdirSync(path.join(ROOT, '.clauder'), { recursive: true }); const W = path.join(ROOT, 'p'); fs.mkdirSync(W);
const DIST = new URL('../dist/', import.meta.url).pathname;
const { ManagedSession } = await import(DIST + 'session.js');
const { SessionManager } = await import(DIST + 'session-manager.js');
const { transcriptPath, promptTokensFromTranscript } = await import(DIST + 'cold-resume.js');
const calls = [];
ManagedSession.prototype.spawnClaudeProcess = function (extraArgs, stdinPayload) {
  const proc = new EventEmitter(); proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.exitCode = null;
  let done = false; const finish = () => { if (done) return; done = true; proc.stdout.end(); proc.exitCode = 0; setImmediate(() => proc.emit('close', 0)); }; proc.kill = () => { finish(); return true; };
  const c = JSON.parse(stdinPayload).message.content; const arg = (n) => { const i = extraArgs.indexOf(n); return i >= 0 ? extraArgs[i + 1] : null; };
  calls.push({ stdin: typeof c === 'string' ? c : JSON.stringify(c), resume: arg('--resume') });
  const sid = 'sdk-' + crypto.randomUUID();
  setTimeout(() => { const line = (o) => proc.stdout.write(JSON.stringify(o) + '\n');
    line({ type: 'system', subtype: 'init', model: 'm', session_id: sid });
    line({ type: 'assistant', message: { id: 'm' + crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 3, cache_read_input_tokens: 400000, cache_creation_input_tokens: 2000 } }, session_id: sid });
    line({ type: 'result', subtype: 'success', is_error: false, result: 'x', session_id: sid, total_cost_usd: 0.1, usage: { input_tokens: 1, output_tokens: 1 } }); finish(); }, 5);
  return proc;
};
const sm = new SessionManager(() => {}); sm.broadcast = (m) => sm.onEvent(m);
let pass = 0, fail = 0; const ok = (c, l, x) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l, x !== undefined ? JSON.stringify(x).slice(0, 300) : ''); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const settle = async () => { await sleep(100); for (let i = 0; i < 300 && sm.getAllSessions().some(s => s.status === 'working'); i++) await sleep(20); await sleep(100); };
const id = sm.createSession({ name: 'Big', cwd: W, model: 'claude-opus-5-5' }).id; const S = () => sm.getSession(id);
await sm.sendMessage(id, 'build the lander physics'); await settle();
const oldSdk = S().sdkSessionId;
ok(S().promptTokens === 402003, 'last request size recorded from the reply usage', S().promptTokens);
ok(sm.getAllSessions().find(s => s.id === id).promptTokens === 402003, 'and sent to the browser');
const before = S().messages.filter(m => m.role !== 'system').length;
calls.length = 0;
await sm.sendFresh(id, 'now add fuel'); await settle();
ok(calls.length === 1 && !calls[0].resume, 'the message starts a new conversation (no --resume)', calls.map(c => c.resume));
ok(calls[0].stdin.includes('started this conversation fresh') && calls[0].stdin.includes(transcriptPath(W, oldSdk)) && calls[0].stdin.endsWith('now add fuel'), 'it carries the summary note and the old conversation path, then the message', calls[0].stdin.slice(0, 400));
ok(calls[0].stdin.includes('build the lander physics'), 'fallback summary from the chat when the one-shot fails');
ok(S().messages.filter(m => m.role !== 'system').length === before + 2, 'chat history kept, new exchange added');
ok(S().messages.some(m => m.role === 'system' && m.content.includes('Started fresh')), 'a line in the chat says so');
calls.length = 0;
await sm.sendMessage(id, 'and landing legs'); await settle();
ok(calls[0].resume && calls[0].resume !== oldSdk && !calls[0].stdin.includes('started this conversation fresh'), 'next message resumes the new conversation, no note', calls[0]);
// Size from a transcript file, for sessions saved before this was tracked.
const f = transcriptPath('/x y/*z', 'abc'); fs.mkdirSync(path.dirname(f), { recursive: true });
fs.writeFileSync(f, [JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 5, cache_read_input_tokens: 900000, cache_creation_input_tokens: 13000 } } }), JSON.stringify({ type: 'assistant', isSidechain: true, message: { usage: { input_tokens: 1, cache_read_input_tokens: 10 } } }), JSON.stringify({ type: 'user', message: {} })].join('\n'));
ok(f.includes('/-x-y--z/abc.jsonl'), 'transcript path encodes the folder like the CLI', f);
ok(promptTokensFromTranscript(f) === 913005, 'size from the transcript skips sub-agent lines', promptTokensFromTranscript(f));
console.log(`\n${pass} passed, ${fail} failed`); fs.rmSync(ROOT, { recursive: true, force: true }); process.exit(fail ? 1 : 0);
