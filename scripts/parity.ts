// Parity check against the extension's own results for one batch.
// Usage: tsx scripts/parity.ts <All.xlsx> <Clean.xlsx> <Review.xlsx> <Rejected.xlsx>
//
// 1. Free filter: re-runs the free stage on the raw list and compares with every "Free filter:" decision.
// 2. Jev decisions: replays the decision rules on the Jev answers the extension recorded
//    (supplies %, serves area) and compares with the extension's result.
import { readTable } from '../src/core/io.js';
import { tableToRows } from '../src/core/columns.js';
import { prefilter, decideWithJev, keywordScore } from '../src/templates/directory/index.js';
import { STORM_PRESET } from '../src/templates/directory/rules.js';
import type { Row } from '../src/core/types.js';

const [allPath, ...resultPaths] = process.argv.slice(2);
const idOf = (r: Row) => r.place_key || r.place_id || `${(r.name || '').toLowerCase()}|${(r.phone || '').replace(/\D/g, '')}`;

const all = tableToRows(await readTable(allPath)).rows;
const old = new Map<string, { result: string; reason: string; supplies: string; serves: string; row: Row }>();
for (const p of resultPaths) {
  const table = await readTable(p);
  const h = (table[0] as string[]).map(String);
  const col = (name: string) => h.indexOf(name);
  const { rows } = tableToRows(table);
  rows.forEach((row, i) => {
    const raw = table[i + 1] as unknown[];
    old.set(idOf(row), { result: String(raw[col('Result')]), reason: String(raw[col('Reason')] ?? ''), supplies: String(raw[col('Jev: Supplies')] ?? ''), serves: String(raw[col('Serves Area')] ?? ''), row });
  });
}
console.log(`Raw list: ${all.length} · old results found: ${old.size}`);

for (const protectPlausible of [false, true]) {
  const S = { ...STORM_PRESET, protectPlausible };
  const reasons = prefilter(all, S);
  let agree = 0, oldOnly = 0, newOnly = 0, reasonDiff = 0, missing = 0;
  const newOnlyEx: string[] = [], oldOnlyEx: string[] = [];
  all.forEach((row, i) => {
    const o = old.get(idOf(row));
    if (!o) { missing++; return; }
    const oldFree = o.reason.startsWith('Free filter: ') ? o.reason.slice(13) : '';
    const mine = reasons[i];
    if (!!oldFree === !!mine) { agree++; if (oldFree && oldFree !== mine) reasonDiff++; }
    else if (oldFree) { oldOnly++; if (oldOnlyEx.length < 40) oldOnlyEx.push(`${row.name} [${row.category}] — old: ${oldFree} → now: ${o.result === 'Rejected' ? '' : ''}checked`); }
    else { newOnly++; if (newOnlyEx.length < 15) newOnlyEx.push(`${row.name} [${row.category}] — new: ${mine}; old: ${o.result} (${o.reason.slice(0, 60)})`); }
  });
  console.log(`\nFree filter, protectPlausible=${protectPlausible}`);
  console.log(`  same decision: ${agree} · removed only by old: ${oldOnly} · removed only by new: ${newOnly} · same decision, different reason: ${reasonDiff} · not matched: ${missing}`);
  if (newOnlyEx.length) console.log('  removed only by new:\n   ' + newOnlyEx.join('\n   '));
  if (protectPlausible && oldOnlyEx.length) console.log('  now passed on to website check (old removed them):\n   ' + oldOnlyEx.join('\n   '));
}

// ---- Jev decision replay ----
let replayed = 0, same = 0;
const diffs: string[] = [];
for (const [, o] of old) {
  const m = o.supplies.match(/^(\d+)%$/);
  if (!m || !o.serves) continue;
  const supplies = Number(m[1]) / 100;
  // The extension stored the chosen answer, not the probabilities: assume a "no" was confident (>= 0.6).
  const answers = { supplies: { noul: supplies }, public_place: { noul: 0 }, serves_state: { choice: o.serves, probabilities: { no: o.serves === 'no' ? 0.9 : 0 } } };
  const kw = keywordScore(o.row, '', STORM_PRESET);
  const d = decideWithJev(o.row, answers, 'KS', kw, STORM_PRESET);
  replayed++;
  if (d.result === o.result) same++;
  else diffs.push(`${o.row.name}: old ${o.result} (${o.reason.slice(0, 70)}) → replay ${d.result} (${d.reason.slice(0, 70)})`);
}
console.log(`\nJev decision replay: ${same}/${replayed} same result`);
if (diffs.length) console.log('  differences:\n   ' + diffs.slice(0, 25).join('\n   '));
