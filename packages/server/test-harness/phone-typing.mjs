// Phone typing mode on the LIVE server: focusing the message box on a touch screen hides the tabs,
// header and task bar, the box gets the full width with its buttons on one row, and it all comes
// back on blur. Opens only the session whose id you pass (use your own, so no unread marks change),
// types into its box and clears it again; nothing is sent. Needs Chrome with --remote-debugging-port=9333.
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
await send('Emulation.setFocusEmulationEnabled', { enabled: true }); // headless pages get no focus events otherwise
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await send('Emulation.setDeviceMetricsOverride', { width: 370, height: 450, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: 'http://localhost:3001/' }); await sleep(2500);
await ev(`localStorage.setItem('clauder.lastActive', ${JSON.stringify(OWN)}); localStorage.removeItem('clauder.compactChrome')`);
await send('Page.reload'); await sleep(5000);
const visible = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.offsetParent !== null })()`;
ok(await ev(visible('.composer-row')) && !(await ev(`document.documentElement.classList.contains('kb-open')`)), 'not in typing mode before focus');
await ev(`document.querySelector('textarea').focus()`); await sleep(400);
ok(await ev(`document.documentElement.classList.contains('kb-open')`), 'focusing the box turns typing mode on');
ok(!(await ev(`[...document.querySelectorAll('.kb-hide')].some(e => e.offsetParent !== null)`)), 'tabs, header and task bar hidden');
await send('Input.insertText', { text: "I like the idea that we're playing machines it makes the work easier if we're building the game in 3d\n\nI like experimenting with enemy intent, planning, then execution.\n\nFights are maybe 1/2 the night." });
await sleep(800);
const box = await ev(`(() => { const r = document.querySelector('textarea').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } })()`);
ok(box.w > 330, 'box gets the full width', box);
ok(box.h <= 450 * 0.4 + 1, 'box capped at 40% of the screen', box);
const rows = await ev(`(() => { const ys = [...document.querySelectorAll('.composer-row button')].filter(b => b.offsetParent).map(b => Math.round(b.getBoundingClientRect().top)); return [...new Set(ys)].length })()`);
ok(rows === 1, 'buttons on one row', rows);
await shot('/private/tmp/phone-typing.png');
await ev(`document.querySelector('textarea').blur()`); await sleep(400);
ok(!(await ev(`document.documentElement.classList.contains('kb-open')`)), 'blur turns it off');
await ev(`const t=document.querySelector('textarea'); const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(t,''); t.dispatchEvent(new Event('input',{bubbles:true})); localStorage.removeItem('clauder.lastActive')`);
console.log(`\n${pass} passed, ${fail} failed`); ws.close(); process.exit(fail ? 1 : 0);
