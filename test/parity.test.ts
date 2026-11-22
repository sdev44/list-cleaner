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
    // 11 more removed in total; within a pair the better listing may now be the one kept (Survive-A-Storm).
    expect(strict.filter(Boolean).length).toBe(base.filter(Boolean).length + 11);
    expect(rows.filter((_, i) => base[i] && !strict[i]).map(r => r.name)).toEqual(['Survive-A-Storm Shelters']);
    const redguard = rows.map((r, i) => r.name?.startsWith('RedGuard') ? strict[i] : null).filter(x => x !== null);
    expect(redguard.filter(Boolean)).toHaveLength(1);
    // SI Precast branches have their own phones: no branch is newly removed.
    expect(rows.filter((r, i) => r.name?.startsWith('SI Precast') && strict[i] && !base[i]).length).toBe(0);
  });
});
