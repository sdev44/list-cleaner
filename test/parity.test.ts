// The free filter must match the Chrome extension (v2.5.5) exactly on a real batch:
// 3,293 Kansas storm-shelter businesses, with the extension's own "Free filter:" reasons.
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readTable } from '../src/core/io.js';
import { tableToRows } from '../src/core/columns.js';
import { prefilter } from '../src/templates/directory/index.js';
import { STORM_PRESET } from '../src/templates/directory/rules.js';

const fixture = fileURLToPath(new URL('./fixtures/kansas-free-filter.csv', import.meta.url));

describe('Kansas parity (free filter)', async () => {
  const { rows } = tableToRows(await readTable(fixture));
  const expected = rows.map(r => r['extra:Old Free Filter'] || '');

  it('reproduces every extension decision and reason in legacy mode', () => {
    expect(rows).toHaveLength(3293);
    const got = prefilter(rows, { ...STORM_PRESET, protectPlausible: false, strictDuplicates: false });
    const diffs = got.map((g, i) => g === expected[i] ? null : `${rows[i].name}: ${expected[i]} → ${g}`).filter(Boolean);
    expect(diffs).toEqual([]);
  });

  it('with protectPlausible, only passes extra businesses on (never removes new ones)', () => {
    const got = prefilter(rows, { ...STORM_PRESET, strictDuplicates: false });
    const newlyRemoved = got.filter((g, i) => g && !expected[i]);
    const rescued = rows.filter((_, i) => expected[i] && !got[i]).map(r => r.name);
    expect(newlyRemoved).toEqual([]);
    expect(rescued).toHaveLength(35);
    expect(rescued).toContain('DEFCON Underground Mfg.');
  });
});

describe('Kansas duplicates by phone + website', async () => {
  const { rows } = tableToRows(await readTable(fixture));
  it('finds the RedGuard pair (SI Precast are branches with their own phones), and only adds duplicates', () => {
    const base = prefilter(rows, { ...STORM_PRESET, strictDuplicates: false });
    const strict = prefilter(rows, STORM_PRESET);
    const added = rows.map((r, i) => !base[i] && strict[i] ? `${r.name} | ${r.website}` : '').filter(Boolean);
    expect(strict.every((g, i) => !base[i] || !!g)).toBe(true); // everything removed before is still removed (reason may now say Duplicate)
    expect(added.every(Boolean)).toBe(true);
    expect(added.some(a => a.startsWith('SI Precast'))).toBe(false);
    expect(added).toHaveLength(11);
    expect(added.some(a => a.startsWith('RedGuard'))).toBe(true);
  });
});
