import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { parentPort, workerData } from 'worker_threads';

// Runs in a worker thread (usage-profile.ts): reads the CLI's conversation files for the last few
// weeks and totals each API call's API-price value by local weekday and hour. About 30 seconds of
// file reading, kept off the server's main thread.

/** $ per million tokens: input, output, cache read, cache write (the 1-hour write is 2x input). */
const PRICES: [string, [number, number, number, number]][] = [
  ['fable', [8, 40, 0.4, 16]], ['opus', [4, 20, 0.2, 8]], ['sonnet', [2, 10, 0.2, 4]], ['haiku', [0.5, 2.5, 0.05, 1]],
];
const priceOf = (model: string) => (PRICES.find(([k]) => model.includes(k)) ?? PRICES[1])[1];

async function main(days: number, tz: string) {
  const since = Date.now() - days * 86_400_000;
  const root = path.join(os.homedir(), '.claude', 'projects');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) { try { if (fs.statSync(p).mtimeMs >= since) files.push(p); } catch { /* gone */ } }
    }
  };
  try { walk(root); } catch { /* no projects folder */ }
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const byDay = new Array(7).fill(0), byHour = new Array(24).fill(0);
  const seen = new Set<string>();
  let calls = 0;
  for (const f of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
      let d: any;
      try { d = JSON.parse(line); } catch { continue; }
      if (d.type !== 'assistant' || !d.timestamp) continue;
      const m = d.message ?? {}, u = m.usage;
      if (!u) continue;
      const t = Date.parse(d.timestamp);
      if (!(t >= since)) continue;
      const key = `${m.id}|${d.requestId}`; // a reply split over several lines repeats its usage
      if (m.id && seen.has(key)) continue;
      seen.add(key);
      const [pi, po, pr, pw] = priceOf(String(m.model ?? ''));
      const usd = ((u.input_tokens ?? 0) * pi + (u.output_tokens ?? 0) * po + (u.cache_read_input_tokens ?? 0) * pr + (u.cache_creation_input_tokens ?? 0) * pw) / 1e6;
      const parts = Object.fromEntries(fmt.formatToParts(new Date(t)).map(p => [p.type, p.value]));
      const w = DAYS.indexOf(parts.weekday), h = Number(parts.hour);
      if (w < 0 || !(h >= 0 && h < 24)) continue;
      byDay[w] += usd; byHour[h] += usd; calls++;
    }
  }
  parentPort?.postMessage({ byDay, byHour, calls, files: files.length });
}

main(workerData.days, workerData.tz).catch(err => parentPort?.postMessage({ error: String(err) }));
