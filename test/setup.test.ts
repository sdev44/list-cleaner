// Setup questions built from the real Northern Ireland dog grooming list and its suggested rules.
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readTable } from '../src/core/io.js';
import { tableToRows } from '../src/core/columns.js';
import { applyAnswers, buildQuestions } from '../src/templates/directory/setup.js';
import { parseDirectoryRules } from '../src/templates/directory/rules.js';

// The rules suggest-rules produced for this list (trimmed to what the questions use).
const suggested = parseDirectoryRules({
  niche: 'dog grooming', strongName: '\\b(groom)', coreCategories: ['groom', 'pet groomer'],
  plausibleCategories: ['pet supply store', 'kennel', 'pet care service', 'dog trainer', 'dog walker', 'beauty salon', 'pet boarding service', 'pet store', 'veterinarian', 'dog day care center'],
  hardExcludeCategory: ['homeless', 'government', 'church', 'worship', 'religious', 'insurance', 'barber shop'],
  excludeName: ['\\bpark\\s*[-–]', 'church', '\\bschool\\b', 'library', 'food ?bank', '\\boutsiders\\b', '\\bmale\\b', '\\bmen\\b'],
  excludeCategory: [], positive: ['groom'], services: []
});

describe('setup questions (Northern Ireland dog grooming)', async () => {
  const { rows } = tableToRows(await readTable(fileURLToPath(new URL('./fixtures/ni-names-categories.csv', import.meta.url))));
  const qs = buildQuestions(rows, suggested, 'NIR');
  const q = (id: string) => qs.find(x => x.id === id)!;

  it('asks about side services with counts and real examples', () => {
    const side = q('side');
    expect(side.title).toMatch(/also offer dog grooming/);
    const kennel = side.options.find(o => o.value === 'kennel')!;
    expect(kennel.count).toBeGreaterThan(50);
    expect(kennel.detail).toMatch(/^e\.g\. /);
    expect(side.options.map(o => o.value)).not.toContain('pet groomer');   // proves a match: never a side service
  });
  it('asks about barbers with grooming-like names, and the suggested name words', () => {
    const hard = q('hardRemove');
    expect(hard.options.map(o => o.value)).toEqual(['barber shop']);
    expect(hard.options[0].detail).toMatch(/Male Grooming/);
    expect(q('names').options.map(o => o.label)).toEqual(expect.arrayContaining(['"male"']));
    expect(q('names').options.map(o => o.value)).not.toContain('church');
  });
  it('skips the US-only distance question for a UK area', () => {
    expect(qs.find(x => x.id === 'nearby')).toBeUndefined();
    expect(q('partial').value).toBe('review');
  });
  it('applies answers: kennels listed, vets to Review, barbers checked, "men" kept as a name', () => {
    const next = applyAnswers(suggested, { side: ['kennel', 'pet boarding service', 'dog day care center'], hardRemove: [], names: ['\\boutsiders\\b', '\\bmale\\b'], partial: 'remove', duplicates: 'no' }, rows, 'NIR');
    expect(next.sideServices).toBe('review');
    expect(next.sideServiceCategories).toEqual(['kennel', 'pet boarding service', 'dog day care center']);
    expect(next.hardExcludeCategory).not.toContain('barber shop');
    expect(next.plausibleCategories).toContain('barber shop');
    expect(next.hardExcludeCategory).toContain('church');                  // never asked, never changed
    expect(next.excludeName).toEqual(expect.arrayContaining(['church', '\\bmale\\b']));
    expect(next.excludeName).not.toContain('\\bmen\\b');
    expect(next).toMatchObject({ partialArea: 'remove', strictDuplicates: false });
  });
  it('ticking every side-service kind means "list them all"', () => {
    const all = applyAnswers(suggested, { side: q('side').options.map(o => o.value) }, rows, 'NIR');
    expect(all.sideServices).toBe('keep');
  });
  it('is applied to the suggested rules each time, never accumulated', () => {
    const a = applyAnswers(suggested, { hardRemove: [] }, rows, 'NIR');
    const b = applyAnswers(suggested, { hardRemove: ['barber shop'] }, rows, 'NIR');
    expect(b.hardExcludeCategory).toContain('barber shop');
    expect(a.plausibleCategories.filter(c => c === 'barber shop')).toHaveLength(1);
  });
});
