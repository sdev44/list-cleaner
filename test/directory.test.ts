import { describe, expect, it } from 'vitest';
import { MockClassifier } from '../src/core/jev.js';
import { runJob } from '../src/core/pipeline.js';
import { ClassifierAuthError, type ClassifierRequest, type Row } from '../src/core/types.js';
import { bestLink, decideWithJev, directoryTemplate, keywordScore, keywordStage, prefilter } from '../src/templates/directory/index.js';
import { buildProfile, parseDirectoryRules, STORM_PRESET, termsFromRows } from '../src/templates/directory/rules.js';

const S = STORM_PRESET;

describe('free filter', () => {
  it('removes duplicates, closed businesses and unrelated categories', () => {
    const rows: Row[] = [
      { name: 'Acme Storm Shelters', place_key: 'a', category: 'Contractor' },
      { name: 'Acme Storm Shelters', place_key: 'a', category: 'Contractor' },
      { name: 'Old Co', place_key: 'b', business_status: 'Permanently closed' },
      { name: 'Joe Insurance', place_key: 'c', category: 'Insurance agency' },
      { name: 'Tornado Shelter Pros', place_key: 'd', category: 'Car repair' },
      { name: 'Humane Society', place_key: 'e', category: 'Contractor' },
      { name: '', place_key: 'f' }
    ];
    expect(prefilter(rows, S)).toEqual(['', 'Duplicate', 'Permanently closed', 'Unrelated category: Insurance agency', '',
      'Name shows a non-commercial or different kind of business', 'No business name']);
  });
  it('keeps plausible categories that clash with the soft exclude list (unless legacy mode)', () => {
    const rows = [{ name: 'DEFCON Underground Mfg.', category: 'Steel Fabricator' }];
    expect(prefilter(rows, S)).toEqual(['']);
    expect(prefilter(rows, { ...S, protectPlausible: false })).toEqual(['Unrelated category: Steel Fabricator']);
  });
  it('still applies hard excludes to plausible categories', () => {
    expect(prefilter([{ name: 'X', category: 'Government contractor' }], S)[0]).toMatch(/^Unrelated category/);
  });
});

describe('keyword stage', () => {
  const site = (ok: boolean, kind: 'site' | 'none' | 'social' = 'site', status = 'Read homepage') => ({ ok, kind, status, text: '' });
  it('rejects a readable site that never mentions the niche', () => {
    const kw = keywordScore({ name: 'Bob Builders' }, 'We build decks', S);
    expect(keywordStage({ name: 'Bob Builders' }, site(true), kw, S, 'KS')).toMatchObject({ result: 'Rejected' });
  });
  it('sends evidence to Jev', () => {
    const kw = keywordScore({ name: 'Bob Builders' }, 'We install FEMA 361 safe rooms', S);
    expect(kw.found).toEqual(['safe-room', 'fema 361']); // safe room / saferoom / safe-room count once
    expect(keywordStage({ name: 'Bob Builders' }, site(true), kw, S, 'KS')).toEqual({ needsJev: true });
  });
  it('reviews a plausible business whose site failed', () => {
    const row = { name: 'Bob Builders', category: 'General Contractor' };
    expect(keywordStage(row, site(false, 'site', 'Website unreachable'), keywordScore(row, '', S), S, 'KS')).toMatchObject({ result: 'Review' });
  });
  it('rejects a no-website business with nothing pointing to the niche', () => {
    const row = { name: 'Bob Builders', category: 'General Contractor' };
    expect(keywordStage(row, site(false, 'none', 'No website'), keywordScore(row, '', S), S, 'KS')).toMatchObject({ result: 'Rejected' });
  });
});

describe('Jev decisions', () => {
  const kw = { score: 50, strong: false, found: [] };
  const inKs = { name: 'A', address: '1 Main St, Wichita, KS 67202, United States' };
  const outKs = { name: 'B', address: '1 Main St, Joplin, MO 64801, United States' };
  const ans = (supplies: number, serves = 'yes', no = 0, pub = 0) => ({ supplies: { noul: supplies }, public_place: { noul: pub }, serves_state: { choice: serves, probabilities: { no } } });
  it('cleans confident in-area suppliers', () => expect(decideWithJev(inKs, ans(0.9), 'KS', kw, S).result).toBe('Clean'));
  it('rejects non-suppliers', () => expect(decideWithJev(inKs, ans(0.1), 'KS', kw, S).result).toBe('Rejected'));
  it('rejects public places', () => expect(decideWithJev(inKs, ans(0.9, 'yes', 0, 0.8), 'KS', kw, S).result).toBe('Rejected'));
  it('rejects confident out-of-area suppliers', () => expect(decideWithJev(outKs, ans(0.9, 'no', 0.8), 'KS', kw, S).reason).toMatch(/outside the area/));
  it('reviews unclear areas and unsure answers', () => {
    expect(decideWithJev(outKs, ans(0.9, 'unclear'), 'KS', kw, S).result).toBe('Review');
    expect(decideWithJev(inKs, ans(0.5), 'KS', kw, S).result).toBe('Review');
  });
});

describe('starter rules', () => {
  it('builds a dog grooming profile that keeps pet categories', () => {
    const rows = [{ name: 'Happy Paws Dog Grooming', category: 'Pet groomer' }, { name: 'Posh Pooch Grooming', category: 'Pet groomer' }];
    const r = buildProfile('Dog Grooming', ['dog groomer', 'dog grooming near me'], rows);
    expect(new RegExp(r.strongName, 'i').test('Happy Paws Grooming')).toBe(true);
    expect(r.coreCategories).toContain('pet groomer');
    expect(r.excludeCategory).not.toContain('animal');
    expect(parseDirectoryRules(r).niche).toBe('dog grooming');
  });
  it('uses the storm preset for storm searches', () => {
    expect(buildProfile('', termsFromRows([{ search_term: 'storm shelter installers; safe room builders' }])).niche).toBe(S.niche);
  });
  it('rejects bad patterns', () => {
    expect(() => parseDirectoryRules({ ...S, strongName: '(' })).toThrow(/strongName/);
  });
  it('picks a niche page, else a services page, on the same site only', () => {
    const page = { text: '', base: 'https://acme.com/', links: [{ href: 'https://other.com/storm', text: 'x' }, { href: '/services', text: 'Services' }, { href: '/tornado-shelters', text: 'Shelters' }] };
    expect(bestLink(page, S)).toBe('https://acme.com/tornado-shelters');
  });
});

describe('pipeline (mocked web + Jev)', () => {
  const html: Record<string, string> = {
    'http://good.example/': '<title>Good Shelters</title><body>We install FEMA 361 tornado shelters and safe rooms for homes across Kansas. Call us for a free quote today.</body>',
    'http://decks.example/': '<title>Deck Co</title><body>We build beautiful decks and patios for homeowners across Kansas. Free quotes, fully insured, family run.</body>'
  };
  const fetcher = async (u: string) => html[u] ? { html: html[u], url: u } : null;
  const rows: Row[] = [
    { name: 'Good Storm Shelters', website: 'good.example', address: '1 Main St, Wichita, KS 67202, United States', category: 'Contractor', place_key: '1' },
    { name: 'Deck Co', website: 'decks.example', address: '2 Main St, Wichita, KS 67202, United States', category: 'Deck builder', place_key: '2' },
    { name: 'Good Storm Shelters', website: 'good.example', place_key: '1' },
    { name: 'Unreachable Builders', website: 'gone.example', category: 'General contractor', place_key: '3' }
  ];
  it('runs every stage and fills template columns', async () => {
    const jev = new MockClassifier(() => ({ supplies: { noul: 0.97 }, public_place: { noul: 0.01 }, serves_state: { choice: 'yes', probabilities: { yes: 0.9 } }, role: { choice: 'provider' } }));
    const { results, counts } = await runJob({ rows, template: directoryTemplate, rules: S, area: 'KS', classifier: jev, fetcher, concurrency: 2 });
    expect(results.map(r => r?.outcome)).toEqual(['keep', 'remove', 'remove', 'review']);
    expect(results[0]?.fields).toMatchObject({ clean_supplies: '97%', clean_role: 'provider', clean_serves: 'yes', clean_site_check: 'Read homepage' });
    expect(String(results[0]?.fields?.clean_services)).toContain('FEMA safe room builders');
    expect(results[2]?.reason).toBe('Free filter: Duplicate');
    expect(counts).toEqual({ keep: 1, review: 1, remove: 2, unchecked: 0 });
    expect(jev.requests).toHaveLength(1);
    expect((jev.requests[0] as ClassifierRequest & { state: { target_state: string } }).state.target_state).toBe('Kansas');
  });
  it('without a key, sends evidence-backed businesses to Clean or Review by keywords', async () => {
    const { results } = await runJob({ rows, template: directoryTemplate, rules: S, area: 'KS', fetcher });
    expect(results[0]?.outcome).toBe('keep');
    expect(results[0]?.reason).toMatch(/^Keyword score/);
  });
  it('stops on a rejected key and leaves the rest unchecked for resume', async () => {
    const jev = { ask: async () => { throw new ClassifierAuthError('bad key'); } };
    const first = await runJob({ rows, template: directoryTemplate, rules: S, area: 'KS', classifier: jev, fetcher, concurrency: 1 });
    expect(first.error?.message).toBe('bad key');
    expect(first.results[0]).toBeNull();
    const ok = new MockClassifier(() => ({ supplies: { noul: 0.9 }, serves_state: { choice: 'yes' } }));
    const second = await runJob({ rows, template: directoryTemplate, rules: S, area: 'KS', classifier: ok, fetcher, previous: first.results });
    expect(second.results.every(Boolean)).toBe(true);
  });
  it('sends a business that never finishes to Review and carries on', async () => {
    const slow = { ...directoryTemplate, check: async (row: Row) => row.place_key === '1' ? new Promise<never>(() => {}) : directoryTemplate.check(row, { rules: S, area: 'KS', readSite: async () => ({ ok: false, kind: 'none' as const, status: 'No website', text: '' }) }) };
    const { results } = await runJob({ rows, template: slow, rules: S, area: 'KS', fetcher, checkTimeoutMs: 200 });
    expect(results[0]?.outcome).toBe('review');
    expect(results[0]?.reason).toMatch(/took longer than/);
    expect(results[3]).not.toBeNull();
  });

  it('honours --limit', async () => {
    const { counts } = await runJob({ rows, template: directoryTemplate, rules: S, area: 'KS', fetcher, limit: 1 });
    expect(counts.unchecked).toBe(2);
  });
});
