// Check the dashboard's folder bar and reopen-where-you-were on the LIVE server. Only opens pages and
// changes this browser's own localStorage; the one session it opens is this Clauder session (pass its
// id), so no one else's unread marks change. Needs Chrome with --remote-debugging-port=9333.
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
const shot = async (f) => fs.writeFileSync(f, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
let pass = 0, fail = 0; const ok = (c, l, x) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l, x ?? ''); } };
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://localhost:3001/' }); await sleep(3000);
await ev(`localStorage.removeItem('clauder.lastActive'); localStorage.removeItem('clauder.dashboard.view')`);
await send('Page.reload'); await sleep(4000);
const tabs = await ev(`[...document.querySelectorAll('[role=tab]')].map(e => e.innerText.replace(/\\s+/g, ' '))`);
ok(tabs.length >= 3 && tabs[0].startsWith('🏠'), 'folder bar: No folder first, then folders, then All', tabs);
ok(await ev(`document.querySelector('[role=tab][aria-selected=true]')?.innerText.includes('No folder')`), '"No folder" selected by default');
await shot('/private/tmp/dash-loose.png');
await ev(`[...document.querySelectorAll('[role=tab]')][1].click()`); await sleep(500);
ok(await ev(`!!document.querySelector('[role=tab][aria-selected=true] button[aria-label^="Edit folder"]')`), 'a folder opens with its pencil');
await shot('/private/tmp/dash-folder.png');
await ev(`[...document.querySelectorAll('[role=tab]')][0].click()`); await sleep(300);
if (OWN) {
  await ev(`localStorage.setItem('clauder.lastActive', ${JSON.stringify(OWN)})`);
  await send('Page.reload'); await sleep(5000);
  ok(await ev(`![...document.querySelectorAll('[role=tab]')].length && !document.body.innerText.includes('sessions active')`), 'reopening lands in the last session, not the dashboard');
  await shot('/private/tmp/dash-restored.png');
  await ev(`localStorage.removeItem('clauder.lastActive')`);
}
await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 860, deviceScaleFactor: 2, mobile: true });
await send('Page.reload'); await sleep(4000); await shot('/private/tmp/dash-phone.png');
console.log(`\n${pass} passed, ${fail} failed`); ws.close(); process.exit(fail ? 1 : 0);
