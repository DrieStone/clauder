# What started each turn in the last N days, and what those turns cost (API-equivalent).
import glob, os, json, time, collections, re, sys
DAYS = int(sys.argv[1]) if len(sys.argv) > 1 else 7
cut = time.time() - DAYS * 86400
P = {'opus': (4, 20, 0.2, 8), 'sonnet': (2, 10, 0.1, 4), 'haiku': (1, 5, 0.1, 2), 'fable': (10, 50, 0.25, 20)}
def price(model, u):
    f = next((k for k in P if k in (model or '')), None)
    if not f: return 0.0
    i, o, cr, cw = P[f]
    return (u.get('input_tokens', 0) * i + u.get('output_tokens', 0) * o + u.get('cache_read_input_tokens', 0) * cr + u.get('cache_creation_input_tokens', 0) * cw) / 1e6
def kind(text):
    t = text.lstrip()
    if 'Check-in from "' in t[:4000]: return 'task check-in (to main)'
    if t.startswith('[Clauder: this message is from') and 'another project' in t[:400]: return 'cross-project message'
    if t.startswith('[Clauder: this message is from'): return 'same-project relay'
    if t.startswith("[Clauder: the owner wants to spin off"): return '/task spin-off request'
    if t.startswith('[Clauder] Your last turn ended'): return 'background recovery'
    if t.startswith('[Clauder auto-nudge]'): return 'auto-nudge (stale wait)'
    if t.startswith('[Monitor:'): return 'monitor event'
    if t.startswith('[Goal-mode'): return 'goal check-in'
    if t.startswith('[Model plan step]'): return 'model-plan step'
    if t.startswith('<task-notification'): return 'background-task notice'
    if t.startswith('[No answer received'): return 'question timeout'
    if t.startswith('Continue where you left off') or t.startswith('[Clauder] Your'): return 'wakeup / resume'
    if t.startswith('[Clauder: this project has') or t.startswith('[Clauder: since this session') or t.startswith('[Clauder: when the owner'):
        # a note prefixed to an ordinary message: classify by what follows the notes
        rest = re.sub(r'^(\[Clauder:.*?\]\s*\n\n)+', '', t, flags=re.S)
        return kind(rest) if rest != t else 'owner / scheduled'
    return 'owner / scheduled'
cost = collections.Counter(); turns = collections.Counter(); by_sess = collections.defaultdict(collections.Counter)
for f in glob.glob(os.path.expanduser('~/.claude/projects/*/*.jsonl')):
    if os.path.getmtime(f) < cut: continue
    cur = None; seen = set(); proj = f.split('/')[-2].replace('-Users-jsweet-', '')[-24:]
    for line in open(f, errors='ignore'):
        try: d = json.loads(line)
        except ValueError: continue
        if d.get('isSidechain') or d.get('timestamp', '')[:19] < time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(cut)): continue
        m = d.get('message') or {}
        if d.get('type') == 'user' and m.get('role') == 'user' and not d.get('isMeta'):
            c = m.get('content')
            if isinstance(c, list) and any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in c): continue
            text = c if isinstance(c, str) else ''.join(b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text') if isinstance(c, list) else ''
            if not text.strip(): continue
            cur = kind(text); turns[cur] += 1; by_sess[cur][proj] += 1
        elif d.get('type') == 'assistant' and cur and m.get('usage') and m.get('id') not in seen:
            seen.add(m.get('id')); cost[cur] += price(m.get('model'), m['usage'])
tot = sum(cost.values())
print(f'Last {DAYS} days: {sum(turns.values())} turns, ${tot:,.0f} API-equivalent\n')
print(f'{"started by":28s} {"turns":>6s} {"cost":>9s} {"share":>6s}  top sessions')
for k, v in sorted(cost.items(), key=lambda x: -x[1]):
    print(f'{k:28s} {turns[k]:6d} ${v:8,.0f} {100*v/tot:5.1f}%  ' + ', '.join(f'{p}({n})' for p, n in by_sess[k].most_common(3)))
