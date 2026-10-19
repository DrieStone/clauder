import fs from 'fs';
import os from 'os';
import path from 'path';
import { DEFAULT_API_CREDITS_SETTINGS, type ApiCreditsSettings, type ApiCreditsStatus } from '@clauder/shared';
import { subscriptionBlockedUntilMs } from './rate-limits.js';

// API credits: when the subscription is out of usage, a session the owner has allowed (or approves
// on the spot) keeps working on the owner's Anthropic API credits instead of sleeping until the
// window resets. Credits are real money, so every gate here errs toward not spending:
//   - off unless switched on, and only while the subscription is actually rejecting requests;
//   - only for sessions flagged (config.apiCredits) or approved for the current outage;
//   - never for a guest's message;
//   - a monthly, a daily and a per-turn budget (the per-turn one enforced by the CLI itself).
// The key sits in ~/.clauder/api-key (not in the repo, not in settings), handed to the CLI through
// its apiKeyHelper setting so it never lands in the environment of the commands a session runs.

const CLAUDER_DIR = path.join(os.homedir(), '.clauder');
export const API_KEY_FILE = path.join(CLAUDER_DIR, 'api-key');
const LEDGER_FILE = path.join(CLAUDER_DIR, 'api-credits.json');
const KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,}$/;
/** Below this much left, a turn isn't started (a first turn re-reads the whole conversation). */
const MIN_TURN_USD = 1;
const MAX_RECENT = 30;
const KEEP_MONTHS = 12;
/** After the account reports no credits, API credits stay off this long before trying again. */
const CREDITS_PAUSE_MS = 6 * 60 * 60 * 1000;

interface MonthLedger {
  totalUsd: number;
  days: Record<string, number>;
  sessions: Record<string, { name: string; usd: number }>;
}

interface Persisted {
  settings: ApiCreditsSettings;
  months: Record<string, MonthLedger>;
  recent: ApiCreditsStatus['recent'];
  blocked: { until: string; reason: 'credits' | 'key'; keyMtimeMs?: number } | null;
}

/** What one turn on API credits needs. */
export interface ApiTurnPlan {
  /** The CLI stops the turn at this much (--max-budget-usd). */
  maxBudgetUsd: number;
  /** A model the owner chose for API turns; null = the session's own (see capApiModel). */
  modelOverride: string | null;
  /** Passed to the CLI as --settings: points apiKeyHelper at the key file. */
  settingsJson: string;
  monthLeftUsd: number;
  /** When the subscription is back. */
  subscriptionBackAt: number;
}

export interface ApiTurnRequest {
  sessionId: string;
  name: string;
  /** The session's own model. */
  model: string | undefined;
  /** config.apiCredits */
  allowed: boolean;
  /** The owner approved API credits for this session until then (epoch ms; 0 = no). */
  approvedUntilMs: number;
  /** A guest's message: never run on the owner's credits. */
  byGuest: boolean;
}

const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Fable is far dearer than the credit is meant for: a turn on API credits runs on Opus 5.5 instead. */
export function capApiModel(model: string | undefined): string | undefined {
  return model && /fable/i.test(model) ? 'claude-opus-5-5' : model;
}

export class ApiCredits {
  private data: Persisted = { settings: { ...DEFAULT_API_CREDITS_SETTINGS }, months: {}, recent: [], blocked: null };
  private active = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private keyCache: { mtimeMs: number; size: number; state: 'missing' | 'invalid' | 'ok'; hint: string | null } | null = null;
  private lastSentBlockedUntil: string | null | undefined;

  constructor(private deps: { onChange: (status: ApiCreditsStatus) => void; file?: string; keyFile?: string; now?: () => number }) {}

  private get file() { return this.deps.file ?? LEDGER_FILE; }
  private get keyFile() { return this.deps.keyFile ?? API_KEY_FILE; }
  private now() { return this.deps.now ? this.deps.now() : Date.now(); }

  load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const d = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      if (!d || typeof d !== 'object') return;
      this.data = {
        settings: this.cleanSettings({ ...DEFAULT_API_CREDITS_SETTINGS, ...(d.settings ?? {}) }),
        months: d.months && typeof d.months === 'object' ? d.months : {},
        recent: Array.isArray(d.recent) ? d.recent.slice(0, MAX_RECENT) : [],
        blocked: d.blocked && typeof d.blocked.until === 'string' ? d.blocked : null,
      };
      console.log(`[ApiCredits] Loaded (${this.data.settings.enabled ? 'on' : 'off'}, ${this.keyInfo().state} key)`);
    } catch (err) {
      console.error('[ApiCredits] Failed to load:', err);
    }
  }

  private save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 1000);
    this.saveTimer.unref();
  }

  saveNow(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[ApiCredits] Failed to save:', err);
    }
  }

  private cleanSettings(s: ApiCreditsSettings): ApiCreditsSettings {
    const num = (v: unknown, fallback: number) => (typeof v === 'number' && isFinite(v) ? Math.min(10_000, Math.max(0, round2(v))) : fallback);
    const d = DEFAULT_API_CREDITS_SETTINGS;
    return {
      enabled: s.enabled === true,
      monthlyBudgetUsd: num(s.monthlyBudgetUsd, d.monthlyBudgetUsd),
      dailyBudgetUsd: num(s.dailyBudgetUsd, d.dailyBudgetUsd),
      perTurnBudgetUsd: num(s.perTurnBudgetUsd, d.perTurnBudgetUsd),
      model: s.model === 'session' || (typeof s.model === 'string' && /^claude-[a-z0-9-]+$/.test(s.model)) ? s.model : d.model,
      workspaceId: typeof s.workspaceId === 'string' && /^wrkspc_[A-Za-z0-9]{10,}$/.test(s.workspaceId.trim()) ? s.workspaceId.trim() : '',
    };
  }

  updateSettings(patch: Partial<ApiCreditsSettings>): void {
    this.data.settings = this.cleanSettings({ ...this.data.settings, ...patch });
    this.changed();
  }

  // ── The key ──────────────────────────────────────────────────────────────

  /** Whether ~/.clauder/api-key holds a usable key. Re-read only when the file changes. */
  private keyInfo(): { state: 'missing' | 'invalid' | 'ok'; hint: string | null; mtimeMs: number } {
    try {
      const st = fs.statSync(this.keyFile);
      if (this.keyCache && this.keyCache.mtimeMs === st.mtimeMs && this.keyCache.size === st.size) return { ...this.keyCache };
      const key = fs.readFileSync(this.keyFile, 'utf-8').trim();
      const ok = KEY_RE.test(key);
      this.keyCache = { mtimeMs: st.mtimeMs, size: st.size, state: ok ? 'ok' : 'invalid', hint: ok ? key.slice(-4) : null };
      return { ...this.keyCache };
    } catch {
      this.keyCache = null;
      return { state: 'missing', hint: null, mtimeMs: 0 };
    }
  }

  // ── Budget ───────────────────────────────────────────────────────────────

  private month(): MonthLedger {
    const key = localDay(new Date(this.now())).slice(0, 7);
    return this.data.months[key] ??= { totalUsd: 0, days: {}, sessions: {} };
  }

  private spent(): { month: number; day: number } {
    const today = localDay(new Date(this.now()));
    const m = this.data.months[today.slice(0, 7)];
    return { month: m?.totalUsd ?? 0, day: m?.days[today] ?? 0 };
  }

  /** What this month and today still allow. */
  private remaining(): number {
    const s = this.data.settings;
    const spent = this.spent();
    return round2(Math.max(0, Math.min(s.monthlyBudgetUsd - spent.month, s.dailyBudgetUsd - spent.day)));
  }

  private blocked(): { until: number; reason: 'credits' | 'key' } | null {
    const b = this.data.blocked;
    if (!b) return null;
    // A refused key is replaced by editing the file: that lifts it.
    if (b.reason === 'key' && b.keyMtimeMs !== undefined && this.keyInfo().mtimeMs !== b.keyMtimeMs) {
      this.data.blocked = null;
      this.save();
      return null;
    }
    const until = Date.parse(b.until);
    if (until <= this.now()) { this.data.blocked = null; this.save(); return null; }
    return { until, reason: b.reason };
  }

  // ── Deciding ─────────────────────────────────────────────────────────────

  /** The plan for a turn that should run on API credits, or null for an ordinary subscription turn.
   *  Every condition has to hold; any one failing means the turn stays on the subscription. */
  plan(req: ApiTurnRequest): ApiTurnPlan | null {
    const s = this.data.settings;
    if (!s.enabled || req.byGuest) return null;
    const subscriptionBackAt = subscriptionBlockedUntilMs(this.now());
    if (subscriptionBackAt === null) return null;
    if (!req.allowed && !(req.approvedUntilMs > this.now())) return null;
    if (this.keyInfo().state !== 'ok' || this.blocked()) return null;
    const left = this.remaining();
    if (left < MIN_TURN_USD) return null;
    return {
      maxBudgetUsd: round2(Math.min(s.perTurnBudgetUsd, left)),
      modelOverride: s.model === 'session' ? null : s.model,
      settingsJson: JSON.stringify({
        apiKeyHelper: `tr -d '[:space:]' < '${this.keyFile.replace(/'/g, `'\\''`)}'`,
        env: {
          // API billing caches the conversation for 5 minutes unless told otherwise, so a turn more
          // than 5 minutes after the last re-sends the whole conversation at full price (Oct 14: four
          // of six turns paid ~$2.60 that way). An hour's cache costs more to write once, then
          // keeps every turn in the hour cheap, as on the subscription.
          ENABLE_PROMPT_CACHING_1H: '1',
          // A key not tied to one workspace needs to say which to bill (the ID isn't a secret).
          ...(s.workspaceId ? { ANTHROPIC_CUSTOM_HEADERS: `anthropic-workspace-id: ${s.workspaceId}` } : {}),
        },
      }),
      monthLeftUsd: round2(Math.max(0, s.monthlyBudgetUsd - this.spent().month)),
      subscriptionBackAt,
    };
  }

  /** Why API credits can't be used for a session right now, or null if they can (for the "use now" button). */
  whyNot(approving = true): string | null {
    const s = this.data.settings;
    if (!s.enabled) return 'API credits are switched off. Turn them on in the usage panel first.';
    const key = this.keyInfo().state;
    if (key === 'missing') return 'No API key yet: save it in ~/.clauder/api-key.';
    if (key === 'invalid') return "~/.clauder/api-key doesn't hold an Anthropic API key.";
    const b = this.blocked();
    if (b) return b.reason === 'key' ? 'Anthropic refused the API key. Replace it in ~/.clauder/api-key.' : 'The API account is out of credits (or billing failed). Paused for a few hours.';
    if (this.remaining() < MIN_TURN_USD) {
      const spent = this.spent();
      const binding = s.dailyBudgetUsd - spent.day <= s.monthlyBudgetUsd - spent.month ? 'today' : 'this month';
      return `The API budget is used up for ${binding}. Raise it in the usage panel if you want more.`;
    }
    if (approving && subscriptionBlockedUntilMs(this.now()) === null) return 'The subscription is not out of usage right now.';
    return null;
  }

  // ── Recording ────────────────────────────────────────────────────────────

  turnStarted(sessionId: string): void {
    this.active.add(sessionId);
    this.changed();
  }

  turnEnded(sessionId: string): void {
    if (this.active.delete(sessionId)) this.changed();
  }

  /** A turn ran on API credits: add its estimated cost to the books. */
  record(sessionId: string, name: string, usd: number, model: string): void {
    if (!(usd > 0)) return;
    const m = this.month();
    const today = localDay(new Date(this.now()));
    m.totalUsd = round2(m.totalUsd + usd);
    m.days[today] = round2((m.days[today] ?? 0) + usd);
    const prev = m.sessions[sessionId];
    m.sessions[sessionId] = { name, usd: round2((prev?.usd ?? 0) + usd) };
    this.data.recent.unshift({ at: new Date(this.now()).toISOString(), sessionId, name, usd: round2(usd), model });
    this.data.recent.length = Math.min(this.data.recent.length, MAX_RECENT);
    const keep = Object.keys(this.data.months).sort().slice(-KEEP_MONTHS);
    for (const k of Object.keys(this.data.months)) if (!keep.includes(k)) delete this.data.months[k];
    this.changed();
  }

  /** The account or key was refused: pause API credits (out of credits: a few hours; bad key: until
   *  the key file changes). */
  problem(reason: 'credits' | 'key'): void {
    this.data.blocked = reason === 'credits'
      ? { until: new Date(this.now() + CREDITS_PAUSE_MS).toISOString(), reason }
      : { until: new Date(this.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), reason, keyMtimeMs: this.keyInfo().mtimeMs };
    console.warn(`[ApiCredits] Paused: ${reason}`);
    this.changed();
  }

  /** The month-to-date spend, for a session's own line in its chat. */
  spentSoFar(): { month: number; day: number; monthlyBudgetUsd: number } {
    const s = this.spent();
    return { month: s.month, day: s.day, monthlyBudgetUsd: this.data.settings.monthlyBudgetUsd };
  }

  // ── Telling the browser ──────────────────────────────────────────────────

  status(): ApiCreditsStatus {
    const key = this.keyInfo();
    const spent = this.spent();
    const today = localDay(new Date(this.now()));
    const m = this.data.months[today.slice(0, 7)];
    const b = this.blocked();
    const until = subscriptionBlockedUntilMs(this.now());
    return {
      settings: { ...this.data.settings },
      keyState: key.state,
      keyHint: key.hint,
      month: today.slice(0, 7),
      day: today,
      monthSpentUsd: round2(spent.month),
      daySpentUsd: round2(spent.day),
      blockedUntil: b ? new Date(b.until).toISOString() : null,
      blockedReason: b ? b.reason : null,
      subscriptionBlockedUntil: until === null ? null : new Date(until).toISOString(),
      activeSessionIds: [...this.active],
      topSessions: Object.entries(m?.sessions ?? {}).map(([sessionId, v]) => ({ sessionId, name: v.name, usd: v.usd })).sort((a, b) => b.usd - a.usd).slice(0, 5),
      recent: this.data.recent.slice(0, 10),
    };
  }

  private changed(): void {
    this.save();
    const status = this.status();
    this.lastSentBlockedUntil = status.subscriptionBlockedUntil;
    try { this.deps.onChange(status); } catch (err) { console.error('[ApiCredits] listener failed:', err); }
  }

  /** Re-send the status when the subscription went out of usage or came back (that part changes
   *  without any call here). */
  refresh(): void {
    const until = this.status().subscriptionBlockedUntil;
    if (until === this.lastSentBlockedUntil) return;
    this.lastSentBlockedUntil = until;
    try { this.deps.onChange(this.status()); } catch { /* ignore */ }
  }
}
