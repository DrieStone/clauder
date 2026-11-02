import fs from 'fs';
import os from 'os';
import path from 'path';
import { Worker } from 'worker_threads';

// When the owner actually uses Claude, for the weekly usage bar's pace line. A straight line
// through the week expects as much usage at 3am as at 10am; the owner's usage is mostly 8am-6pm
// on weekdays and nearly nothing overnight. So the line follows a profile of the last few weeks:
// each hour of the week weighted by (that weekday's share) x (that hour's share), from the API-price
// value of every call in the CLI's conversation files (usage-profile-worker.ts), plus a small even
// floor so no hour counts as zero. Rebuilt daily in a worker thread; saved so a restart reuses it.

const FILE = path.join(os.homedir(), '.clauder', 'usage-profile.json');
const DAYS_BACK = 42;
const REBUILD_MS = 24 * 3600_000;
/** Share of the week spread evenly, so a quiet hour still moves the line a little. */
const FLOOR = 0.1;

export interface PaceProfile {
  /** IANA time zone the weekday/hour buckets are in. */
  tz: string;
  /** 168 weights summing to 1: index = weekday (Mon=0) * 24 + hour, in `tz`. */
  weights: number[];
  builtAt: string;
  calls: number;
}

let profile: PaceProfile | null = null;
let building = false;

/** The 168 weights from per-weekday and per-hour totals. */
export function weightsFrom(byDay: number[], byHour: number[]): number[] {
  const dSum = byDay.reduce((a, b) => a + b, 0), hSum = byHour.reduce((a, b) => a + b, 0);
  const out: number[] = [];
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
    const shaped = dSum > 0 && hSum > 0 ? (byDay[d] / dSum) * (byHour[h] / hSum) : 1 / 168;
    out.push((1 - FLOOR) * shaped + FLOOR / 168);
  }
  const total = out.reduce((a, b) => a + b, 0);
  return out.map(w => w / total);
}

export function getPaceProfile(): PaceProfile | null { return profile; }

function build(onDone: () => void): void {
  if (building) return;
  building = true;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const worker = new Worker(new URL('./usage-profile-worker.js', import.meta.url), { workerData: { days: DAYS_BACK, tz } });
  worker.once('message', (r: any) => {
    building = false;
    if (r?.error || !(r?.calls > 0)) { console.error('[UsageProfile] Build failed or found nothing:', r?.error ?? 'no calls'); return; }
    profile = { tz, weights: weightsFrom(r.byDay, r.byHour), builtAt: new Date().toISOString(), calls: r.calls };
    try { fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(profile)); fs.renameSync(`${FILE}.tmp`, FILE); } catch (err) { console.error('[UsageProfile] Save failed:', err); }
    console.log(`[UsageProfile] Built from ${r.calls} calls in ${r.files} conversation files (last ${DAYS_BACK} days, ${tz})`);
    onDone();
  });
  worker.once('error', (err) => { building = false; console.error('[UsageProfile] Worker failed:', err); });
}

/** Load the saved profile, rebuild it if missing or a day old, then daily. `onChange` re-sends usage info. */
export function startUsageProfile(onChange: () => void): void {
  try {
    const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(p?.weights) && p.weights.length === 168) profile = p;
  } catch { /* none yet */ }
  const due = !profile || Date.now() - Date.parse(profile.builtAt) > REBUILD_MS;
  if (due) setTimeout(() => build(onChange), 30_000).unref(); // after startup settles
  setInterval(() => build(onChange), REBUILD_MS).unref();
}
