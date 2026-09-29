import fs from 'fs';
import path from 'path';
import os from 'os';
import type { CostSummary, CostSummaryWindow } from '@clauder/shared';

/** One recorded turn's cost + token breakdown. Fed from session.ts at the "Turn done" point;
 *  rolled up by getCostSummary() for the quota popover. Deliberately does NOT import
 *  rate-limits.ts (rate-limits.ts imports nothing from here either) to avoid a cycle. */
export interface TurnCostEntry {
  ts: string;              // ISO
  sessionId: string;
  model: string;
  effort: string;
  costUsd: number;
  tokens: { input: number; cacheRead: number; cacheWrite: number; output: number; thinking: number };
}

export const COST_LEDGER_FILE = path.join(os.homedir(), '.clauder', 'cost-ledger.json');
const MAX_ENTRIES = 5000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

let ledger: TurnCostEntry[] = [];

export function saveLedger(file = COST_LEDGER_FILE): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
    fs.renameSync(tmp, file); // atomic on the same filesystem
  } catch (err) {
    console.error('[CostLedger] Failed to persist:', err);
  }
}

/** Load the ledger from disk, pruning anything older than 7 days (the longest window we
 *  summarize) so the file can't grow without bound across months. */
export function loadLedger(file = COST_LEDGER_FILE): void {
  try {
    if (!fs.existsSync(file)) { ledger = []; return; }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const cutoff = Date.now() - SEVEN_DAYS_MS;
    ledger = (Array.isArray(data) ? data : [])
      .filter((e: any) => e && typeof e.ts === 'string' && new Date(e.ts).getTime() >= cutoff)
      .slice(-MAX_ENTRIES);
  } catch (err) {
    console.error('[CostLedger] Failed to load:', err);
    ledger = [];
  }
}

loadLedger();

export function recordTurnCost(entry: TurnCostEntry): void {
  ledger.push(entry);
  // Prune by age and cap size, then persist. Cheap: this fires once per completed turn.
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  if (ledger.length > MAX_ENTRIES || ledger[0] && new Date(ledger[0].ts).getTime() < cutoff) {
    ledger = ledger.filter(e => new Date(e.ts).getTime() >= cutoff).slice(-MAX_ENTRIES);
  }
  saveLedger();
}

function rollup(sinceMs: number): CostSummaryWindow {
  const byModel: Record<string, { cost: number; turns: number }> = {};
  let total = 0;
  for (const e of ledger) {
    if (new Date(e.ts).getTime() < sinceMs) continue;
    const m = byModel[e.model] ?? (byModel[e.model] = { cost: 0, turns: 0 });
    m.cost += e.costUsd;
    m.turns += 1;
    total += e.costUsd;
  }
  return { byModel, total };
}

export function getCostSummary(): CostSummary {
  const now = Date.now();
  return {
    last24h: rollup(now - 24 * 60 * 60 * 1000),
    last7d: rollup(now - SEVEN_DAYS_MS),
  };
}
