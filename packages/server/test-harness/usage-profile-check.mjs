// Builds the usage profile from this Mac's real conversation files (usage-profile-worker.ts, in a
// worker thread like the server does) and prints where the 7-day pace line sits through a week,
// next to the old straight line. Reads only; writes nothing.
import { Worker } from 'worker_threads';
const DIST = new URL('../dist/', import.meta.url).pathname;
const { weightsFrom } = await import(DIST + 'usage-profile.js');
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const t0 = Date.now();
const r = await new Promise((res, rej) => { const w = new Worker(DIST + 'usage-profile-worker.js', { workerData: { days: 42, tz } }); w.once('message', res); w.once('error', rej); });
console.log(`${r.calls} calls in ${r.files} files, ${((Date.now() - t0) / 1000).toFixed(1)}s, ${tz}`);
const weights = weightsFrom(r.byDay, r.byHour);
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
const D = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const how = (t) => { const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map(x => [x.type, x.value])); return D.indexOf(p.weekday) * 24 + (Number(p.hour) % 24); };
const end = Date.parse(process.argv[2] ?? '2026-11-03T21:00:00Z'), start = end - 7 * 86400e3, H = 3600e3;
const pace = (now) => { let d = 0, tot = 0; for (let t = start; t < end; t += H) { const w = weights[how(t)]; tot += w; if (t + H <= now) d += w; else if (t < now) d += w * (now - t) / H; } return 100 * d / tot; };
const show = (t) => new Date(t).toLocaleString('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric' });
console.log('\nwhen                usual pace   straight line');
for (let t = start + 6.5 * 24 * H - 17 * H; t <= start + 6.5 * 24 * H + 7 * H; t += H) console.log(`  ${show(t).padEnd(16)} ${pace(t).toFixed(0).padStart(5)}%   ${(100 * (t - start) / (end - start)).toFixed(0).padStart(5)}%`);
console.log(`\n  now (${show(Date.now())})  ${pace(Date.now()).toFixed(0)}%   ${(100 * (Date.now() - start) / (end - start)).toFixed(0)}%`);
