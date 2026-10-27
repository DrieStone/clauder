// Recurring triggers keep their time of day after a late run (triggers.ts nextSlot).
const { nextSlot } = await import(new URL('../dist/triggers.js', import.meta.url).pathname);
let pass = 0, fail = 0; const ok = (c, l, x) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l, x ?? ''); } };
const H = 3600e3, D = 24 * H, iso = (ms) => new Date(ms).toISOString();
const due = Date.parse('2026-10-26T10:10:00Z');
ok(iso(nextSlot(iso(due), 86400, due + 9.5 * H)) === '2026-10-27T10:10:00.000Z', 'daily run 9.5h late: next is tomorrow at the usual time');
ok(iso(nextSlot(iso(due), 86400, due + 50)) === '2026-10-27T10:10:00.000Z', 'on time: 24h later');
ok(iso(nextSlot(iso(due), 86400, due + 3 * D + H)) === '2026-10-30T10:10:00.000Z', 'down 3 days: next future slot, not a backlog');
ok(iso(nextSlot(iso(due), 604800, due + 9 * H)) === '2026-11-02T10:10:00.000Z', 'weekly keeps its weekday');
ok(nextSlot('garbage', 60, 1000) === 61000, 'no usable due time: from now');
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
