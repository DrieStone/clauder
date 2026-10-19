// Check the file-in-a-new-tab links on the LIVE server (read-only: opens pages, clicks nothing that changes state).
import WebSocket from '/Users/jsweet/clauder/node_modules/ws/wrapper.mjs';
const t = await (await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 }); await new Promise(r => ws.once('open', r));
let id = 0; const pend = new Map();
ws.on('message', d => { const m = JSON.parse(d); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: 'http://localhost:3001/view?cwd=' + encodeURIComponent('/Users/jsweet/clauder') + '&path=CLAUDE.md' });
await sleep(4000);
console.log('view page title:', await ev('document.title'));
console.log('shows file text:', await ev(`document.body.innerText.includes('Web interface to the Claude CLI')`));
console.log('no Back button:', await ev(`![...document.querySelectorAll('button')].some(b => b.innerText.includes('Back'))`));
const shot = await send('Page.captureScreenshot', { format: 'png' });
(await import('fs')).writeFileSync('/private/tmp/clauder-view.png', Buffer.from(shot.data, 'base64'));
ws.close(); process.exit(0);
