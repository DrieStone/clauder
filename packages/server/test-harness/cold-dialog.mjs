// The cold-resume warning in the browser, on the LIVE server, without sending anything: the session
// whose id you pass (use your own) is made to look idle, 3 hours cold and 600k tokens in this
// browser only (rewritten WebSocket frames), and outgoing send_message frames are caught and dropped.
// Needs Chrome on port 9333.
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
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  const OWN = ${JSON.stringify(OWN)}; window.__sent = [];
  const W = window.WebSocket;
  window.WebSocket = function (...a) {
    const s = new W(...a);
    const realSend = s.send.bind(s);
    s.send = (data) => { try { const m = JSON.parse(data); if (m.type === 'send_message') { window.__sent.push(m); return; } } catch {} realSend(data); };
    const add = s.addEventListener.bind(s);
    const fix = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.sessionId === OWN && m.type !== 'history') return null; // freeze this session's live updates
        const touch = (x) => { if (x && x.id === OWN) { x.status = 'idle'; x.lastActiveAt = new Date(Date.now() - 3 * 3600e3).toISOString(); x.promptTokens = 600000; x.currentToolActivity = null; } };
        if (Array.isArray(m.sessions)) m.sessions.forEach(touch);
        if (m.session) touch(m.session);
        if (m.type === 'keep_warm' && m.status) m.status.sessions = (m.status.sessions || []).filter(x => x !== OWN);
        return new MessageEvent('message', { data: JSON.stringify(m) });
      } catch { return e; }
    };
    s.addEventListener = (type, fn, ...r) => type === 'message' ? add(type, (e) => { const f = fix(e); if (f) fn(f); }, ...r) : add(type, fn, ...r);
    Object.defineProperty(s, 'onmessage', { set(fn) { add('message', (e) => { const f = fix(e); if (f) fn(f); }); } });
    return s;
  };
  window.WebSocket.prototype = W.prototype; Object.assign(window.WebSocket, W);
})();` });
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://localhost:3001/' }); await sleep(2500);
await ev(`localStorage.setItem('clauder.lastActive', ${JSON.stringify(OWN)})`);
await send('Page.reload'); await sleep(6000);
const typeIt = async (text) => { await ev(`document.querySelector('textarea').focus()`); await send('Input.insertText', { text }); await sleep(200); };
const sendBtn = `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Send')`;
ok(await ev(`!!(${sendBtn})`), 'session shows as idle (Send button)');
await typeIt('test message, please ignore');
await ev(`(${sendBtn}).click()`); await sleep(500);
const dlg = `document.querySelector('[role=dialog][aria-label="This conversation has gone cold"]')`;
ok(await ev(`!!${dlg}`), 'sending to a cold 600k conversation shows the warning');
ok(await ev(`${dlg}.innerText.includes('600k tokens') && ${dlg}.innerText.includes('$4.80')`), 'with the size and cost (600k on Opus: $4.80)', await ev(`${dlg}?.innerText`));
await send('Page.captureScreenshot', { format: 'png' }).then(s => fs.writeFileSync('/private/tmp/cold-dialog.png', Buffer.from(s.data, 'base64')));
await ev(`[...${dlg}.querySelectorAll('button')].find(b => b.textContent === 'Cancel').click()`); await sleep(300);
ok(!(await ev(`!!${dlg}`)) && (await ev(`document.querySelector('textarea').value`)) === 'test message, please ignore' && (await ev(`window.__sent.length`)) === 0, 'Cancel: nothing sent, the message stays in the box');
await ev(`(${sendBtn}).click()`); await sleep(400);
await ev(`[...${dlg}.querySelectorAll('button')].find(b => b.textContent.startsWith('Start fresh')).click()`); await sleep(400);
const sent = await ev(`window.__sent`);
ok(sent.length === 1 && sent[0].fresh === true && sent[0].message === 'test message, please ignore', 'Start fresh: sends with fresh set (caught, not delivered)', sent);
ok((await ev(`document.querySelector('textarea').value`)) === '', 'and clears the box');
await typeIt('another'); await ev(`(${sendBtn}).click()`); await sleep(400);
await ev(`[...${dlg}.querySelectorAll('button')].find(b => b.textContent === 'Send anyway').click()`); await sleep(300);
const sent2 = await ev(`window.__sent`);
ok(sent2.length === 2 && !sent2[1].fresh, 'Send anyway: a normal send');
await typeIt('/compact'); await ev(`(${sendBtn}).click()`); await sleep(400);
ok(!(await ev(`!!${dlg}`)) && (await ev(`window.__sent.length`)) === 3, 'slash commands go straight through');
await ev(`localStorage.removeItem('clauder.lastActive')`);
console.log(`\n${pass} passed, ${fail} failed`); ws.close(); process.exit(fail ? 1 : 0);
