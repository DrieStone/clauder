// The chat holds still while you're scrolled up, and "Hide tools" hides tool calls. Runs on the
// LIVE server against the session whose id you pass (use your own); incoming messages are faked
// in this browser only (a wrapped WebSocket), nothing is sent. Needs Chrome on port 9333.
import WebSocket from '/Users/jsweet/clauder/node_modules/ws/wrapper.mjs';
import fs from 'fs';
const OWN = process.argv[2];
const t = await (await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 }); await new Promise(r => ws.once('open', r));
let id = 0; const pend = new Map();
ws.on('message', d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (c, l, x) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l, x ?? ''); } };
await send('Page.enable'); await send('Runtime.enable');
// Keep the app's socket so fake server messages can be dispatched on it.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const W = window.WebSocket; window.WebSocket = function (...a) { const s = new W(...a); window.__appWs = s; return s; }; window.WebSocket.prototype = W.prototype; Object.assign(window.WebSocket, W); })();` });
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://localhost:3001/' }); await sleep(2500);
await ev(`localStorage.setItem('clauder.lastActive', ${JSON.stringify(OWN)}); localStorage.removeItem('clauder.chatTextOnly')`);
await send('Page.reload'); await sleep(6000);
const list = `document.querySelector('.flex-col-reverse.overflow-y-auto')`;
const fake = (n) => ev(`window.__appWs.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'assistant_message', sessionId: ${JSON.stringify(OWN)}, messageId: 'fake-${n}-' + Date.now(), text: 'Fake message ${n}\\n\\n' + 'line\\n'.repeat(12) }) }))`);
// Where the view is, measured from the top of the conversation (unchanged = nothing moved), and the
// message nearest the top of the view with its position on screen.
const topMsg = `(() => { const l = ${list}; const top = l.getBoundingClientRect().top; const vis = [...l.querySelectorAll('[id^=msg-]')].map(e => [e, e.getBoundingClientRect()]).filter(([, r]) => r.bottom > top + 5).sort((a, b) => a[1].top - b[1].top)[0]; return [Math.round(l.scrollHeight - l.clientHeight + l.scrollTop), vis ? vis[0].id + '@' + Math.round(vis[1].top) : null].join(' ') })()`;
await ev(`${list}.scrollTop = -600; ${list}.dispatchEvent(new Event('scroll'))`); await sleep(400);
const before = await ev(topMsg);
await fake(1); await sleep(400); await fake(2); await sleep(600);
const after = await ev(topMsg);
ok(before && before === after, 'scrolled up: new messages do not move the view', { before, after });
const btn = `[...document.querySelectorAll('button')].find(b => b.title === 'Jump to latest')`;
ok(await ev(`(${btn})?.textContent.includes('New messages')`), 'jump button says New messages');
await send('Page.captureScreenshot', { format: 'png' }).then(s => fs.writeFileSync('/private/tmp/chat-scrolled.png', Buffer.from(s.data, 'base64')));
await ev(`(${btn}).click()`); await sleep(900);
ok(Math.abs(await ev(`${list}.scrollTop`)) < 5, 'jump goes to the bottom');
await fake(3); await sleep(500);
ok(Math.abs(await ev(`${list}.scrollTop`)) < 5, 'at the bottom: follows new messages');
const toolsShown = () => ev(`[...document.querySelectorAll('.msg-tools, .msg-toolonly')].filter(e => e.offsetParent !== null).length`);
const n0 = await toolsShown();
await ev(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Hide tools').click()`); await sleep(400);
ok(n0 > 0 && (await toolsShown()) === 0, 'Hide tools hides tool calls', n0);
await send('Page.captureScreenshot', { format: 'png' }).then(s => fs.writeFileSync('/private/tmp/chat-textonly.png', Buffer.from(s.data, 'base64')));
await ev(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Tools hidden').click()`); await sleep(300);
ok((await toolsShown()) === n0, 'and shows them again');
await ev(`localStorage.removeItem('clauder.lastActive'); localStorage.removeItem('clauder.chatTextOnly')`);
console.log(`\n${pass} passed, ${fail} failed`); ws.close(); process.exit(fail ? 1 : 0);
