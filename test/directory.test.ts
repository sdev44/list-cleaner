import { describe, expect, it } from 'vitest';
import { MockClassifier } from '../src/core/jev.js';
import { runJob } from '../src/core/pipeline.js';
import { ClassifierAuthError, type ClassifierRequest, type Row } from '../src/core/types.js';
import { reachOf, reviewPriority, areaLink, bestLink, decideWithJev, directoryTemplate, isBorderline, keywordScore, keywordStage, mergeAnswers, prefilter, reachHint } from '../src/templates/directory/index.js';
import { buildProfile, nameConflicts, parseDirectoryRules, STORM_PRESET, termsFromRows } from '../src/templates/directory/rules.js';

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
    expect(prefilter(rows, S)).toEqual(['', 'Duplicate of Acme Storm Shelters', 'Permanently closed', 'Unrelated category: Insurance agency', '',
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

describe('partial service areas (from real Kansas cases)', () => {
  const kw = { score: 50, strong: false, found: [] };
  const superior = 'We primarily serve the great state of Oklahoma, but service areas up to 300 miles away from our yard. Feel free to send us an email.';
  const valley = 'The install area is a 200-mile radius from our factory in Huntsville. For locations beyond the 200-mile radius, contact the Huntsville showroom about our drop-shipping program, assisted install';
  const redZone = 'We Are In The RED ZONE. Tornado RISK Maps. Tornado Risk Map. Frequency Map. FEMA Region VII';
  const mo = { name: 'X', address: '5121 S Campbell Ave, Springfield, MO 65810, United States' };
  const ans = (serves: string, no = 0) => ({ supplies: { noul: 0.99 }, public_place: { noul: 0 }, serves_state: { choice: serves, probabilities: { no } } });

  it('finds radius, delivery and drop-shipping wording', () => {
    expect(reachHint(superior)).toMatch(/300 miles/);
    expect(reachHint(valley)).toMatch(/200-mile radius/);
    expect(reachHint(redZone)).toBe('');
    // Quotes the matching sentence, not text before it.
    const long = 'Our shelters have been engineered to sustain 250 mph winds and are reinforced with Grade-60 rebar. We deliver and install shelters across the OKC metro and surrounding states. Call today.';
    expect(reachHint(long)).toBe('We deliver and install shelters across the OKC metro and surrounding states');
    expect(reachHint('Steel rebar every 9 to 12 inches. Rated for 250 mph winds.')).toBe('');
  });
  it('sends "partly" to Review by default, with the evidence in the reason', () => {
    const d = decideWithJev(mo, ans('partly'), 'KS', kw, S, superior);
    expect(d.result).toBe('Review');
    expect(d.reason).toMatch(/based outside Kansas but may reach it: ".*300 miles/);
  });
  it('never rejects on area when the site mentions reach and the distance is unknown', () => {
    expect(decideWithJev(mo, ans('no', 0.9), 'KS', kw, S, valley).result).toBe('Review');
    expect(decideWithJev(mo, ans('no', 0.9), 'KS', kw, S, redZone).result).toBe('Rejected');
  });
  it('compares a stated radius with the real distance (Superior 300 vs 128; Valley 200 vs 475)', () => {
    const ok = { name: 'Superior', address: '1 Main St, Norman, OK 73072, United States' };
    expect(decideWithJev(ok, ans('partly'), 'KS', kw, S, superior, 128).result).toBe('Review');
    const al = { name: 'Valley', address: '7262 Governors W, Huntsville, AL 35806, United States' };
    const v = decideWithJev(al, ans('partly'), 'KS', kw, S, valley, 475);
    expect(v.result).toBe('Rejected');
    expect(v.reason).toMatch(/200-mile reach but it is about 475 miles from Kansas/);
  });
  it('does not take Jev\u2019s "yes" for a far-away business without backing from its site', () => {
    const al = { name: 'Valley', address: '7262 Governors W, Huntsville, AL 35806, United States' };
    expect(decideWithJev(al, ans('yes'), 'KS', kw, S, valley, 475).result).toBe('Rejected');
    expect(decideWithJev(al, ans('yes'), 'KS', kw, S, 'Quality shelters for your family.', 475)).toMatchObject({ result: 'Review' });
    expect(decideWithJev(al, ans('yes'), 'KS', kw, S, 'We install in Kansas, Missouri and Oklahoma.', 475).result).toBe('Clean');
    // Nationwide shipping alone is not a local installer (Storm Shelters of Iowa: "Limited, nationwide shipping").
    expect(decideWithJev(al, ans('yes'), 'KS', kw, S, 'We ship nationwide.', 475).result).toBe('Review');
    expect(decideWithJev(mo, ans('yes'), 'KS', kw, S, 'Quality shelters.', 75).result).toBe('Clean');
  });
  it('applies the verdicts from the Kansas directory check', () => {
    const k = (kind: string, extra: Record<string, unknown> = {}) => ({ ...ans('yes'), kind: { choice: kind, probabilities: { [kind]: 0.9 } }, ...extra });
    const lanterns = { name: 'The Lanterns of Andover', address: '1 Lantern Ln, Andover, KS 67002, United States' };
    expect(decideWithJev(lanterns, k('facility_with_them'), 'KS', kw, S).result).toBe('Rejected');
    const city = { name: 'City Storm Shelter', search_location: 'Kansas, USA' };
    expect(decideWithJev(city, k('public_shelter'), 'KS', { ...kw, strong: true }, S).result).toBe('Review');
    // No address: the phone's area code says where it is.
    const safeZone = { name: 'Safe Zone Storm Shelters', phone: '+1 870-588-7696', search_location: 'Kansas, USA' };
    expect(decideWithJev(safeZone, k('supplier', { serves_state: { choice: 'unclear' } }), 'KS', kw, S).result).toBe('Review');
    const stretch = { name: "Stretch's Tornado Shelter", phone: '(620) 825-6022', search_location: 'Kansas, USA' };
    const d = decideWithJev(stretch, k('supplier', { serves_state: { choice: 'unclear' } }), 'KS', kw, S);
    expect(d.result).toBe('Clean');
    expect(d.reason).toMatch(/Kansas phone number/);
    // No address and no phone clue: being found in Kansas searches is not enough on its own.
    expect(decideWithJev({ name: 'X', search_location: 'Kansas, USA' }, k('supplier', { serves_state: { choice: 'unclear' } }), 'KS', kw, S).result).toBe('Review');
  });

  it('does not count the area inside a list of states (v8: Storm Shelters of Iowa, City Storm Shelter)', () => {
    const al = { name: 'X', address: '7262 Governors W, Huntsville, AL 35806, United States' };
    const list = 'Service Areas: the following states: Iowa Illinois Nebraska Missouri Minnesota North Dakota South Dakota Kansas Oklahoma Texas Arkansas Tennessee';
    expect(decideWithJev(al, ans('yes'), 'KS', kw, S, list, 475).result).toBe('Review');
    expect(decideWithJev(al, ans('yes'), 'KS', kw, S, 'We install safe rooms across Kansas and Missouri.', 475).result).toBe('Clean');
  });
  it('treats a business just over the line as local (Kansas City, Missouri)', () => {
    const kc = { name: 'SI Precast Concrete Products', address: '1 Main St, Kansas City, MO 64120, United States' };
    expect(decideWithJev(kc, ans('partly'), 'KS', kw, S, 'Stock Number Weight Inside Outside 48 mi', 6)).toMatchObject({ result: 'Clean' });
    expect(reachOf('Stock Number Weight 60 mi from base')).toBeNull();
  });

  it('handles v6 radius wording: travel charges, speed promises, "outside the metro"', () => {
    expect(reachOf('$2.00 A MILE ROUND TRIP PER TRUCK FOR ANY JOB OVER 20 MILES bottom of page')?.miles).toBeUndefined();
    const ok = { name: 'Storm Safe', address: '1 Main St, Oklahoma City, OK 73102, United States' };
    const speed = 'Most installs within 100 miles of Oklahoma City are completed in one day.';
    expect(reachOf(speed)?.miles).toBe(100);
    const d = decideWithJev(ok, ans('partly'), 'KS', kw, S, speed, 114);
    expect(d.result).toBe('Review');
    expect(d.reason).toMatch(/100-mile reach and it is about 114 miles/);
    expect(reachHint('For installations outside the Oklahoma City metro, a travel fee applies.')).toMatch(/outside the Oklahoma City metro/);
  });

  it('ignores wording that is not about reach (from the v5 run)', () => {
    for (const t of [
      'We are an Oklahoma City Storm Shelters company at heart, however we serve the entire state of Oklahoma',
      'require every shelter and safe room we install to prove itself twice over',
      'parts of Arkansas are protected from tornados and devastating storms, Benton County, Central Arkansas, and neighboring states can\u2019t say the same',
      'Proudly serving the Southwest region home based in Lubbock Texas',
      'Rated for 250 mph winds. Founded 1999. Rebar every 12 inches.'
    ]) expect(reachHint(t)).toBe('');
    expect(reachHint('We install across the surrounding states.')).toMatch(/surrounding states/);
    expect(reachHint('We deliver to Kansas, Missouri and Arkansas.')).toMatch(/deliver to Kansas/);
  });
  it('follows the partialArea setting', () => {
    expect(decideWithJev(mo, ans('partly'), 'KS', kw, { ...S, partialArea: 'keep' }, superior).result).toBe('Clean');
    expect(decideWithJev(mo, ans('partly'), 'KS', kw, { ...S, partialArea: 'remove' }, superior).result).toBe('Rejected');
  });
  it('asks twice when borderline and treats disagreement as unclear', () => {
    expect(isBorderline({ supplies: { noul: 0.7 }, serves_state: { choice: 'yes' } }, S)).toBe(true);
    expect(isBorderline({ supplies: { noul: 0.99 }, serves_state: { choice: 'no', probabilities: { no: 0.7 } } }, S)).toBe(true);
    expect(isBorderline({ supplies: { noul: 0.99 }, serves_state: { choice: 'yes' } }, S)).toBe(false);
    const m = mergeAnswers({ supplies: { noul: 0.9 }, serves_state: { choice: 'no', probabilities: { no: 0.7 } } }, { supplies: { noul: 0.7 }, serves_state: { choice: 'yes', probabilities: { no: 0.2 } } });
    expect(m.supplies.noul).toBeCloseTo(0.8);
    expect(m.serves_state.choice).toBe('unclear');
    expect(decideWithJev(mo, m, 'KS', kw, S).result).toBe('Review');
  });
  it('sends a supplier near the area to Review even when Jev says it does not serve it', () => {
    const joplin = { name: 'Atlas Safe Rooms Joplin Showroom', address: '3929 E 7th St, Joplin, MO 64801, United States' };
    const d = decideWithJev(joplin, ans('no', 0.9), 'KS', kw, S, redZone, 9);
    expect(d).toMatchObject({ result: 'Review' });
    expect(d.reason).toMatch(/about 9 miles from Kansas/);
    expect(decideWithJev(mo, ans('no', 0.9), 'KS', kw, S, redZone, 75).result).toBe('Rejected');
    expect(decideWithJev(joplin, ans('no', 0.9), 'KS', kw, { ...S, nearbyMiles: 0 }, redZone, 9).result).toBe('Rejected');
  });
  it('ranks area decisions first, nearest first, then unsure, then unreadable sites', () => {
    const p = (r: string, sup: number | null, miles: number | null, strong = false) => reviewPriority(r, sup, miles, strong);
    const near = p('Offers x (99%); based about 9 miles from Kansas, no sign', 0.99, 9);
    const far = p('Offers x (99%); based outside Kansas but may reach it: "up to 300 miles"', 0.99, 128);
    const unsure = p('Jev unsure (70% likely to offer x)', 0.7, 0);
    const unreadable = p('Website unreachable; business type (Contractor) could offer x', null, 0);
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(unsure);
    expect(unsure).toBeGreaterThan(unreadable);
  });
  it('picks a service-area page', () => {
    const page = { text: '', base: 'https://x.com/', links: [{ href: '/about', text: 'About' }, { href: '/service-areas', text: 'Areas we serve' }] };
    expect(areaLink(page)).toBe('https://x.com/service-areas');
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
  it('flags trade words in other trades\u2019 names, but not place names (NI: "male" yes, "armagh" no)', () => {
    const G = { ...S, niche: 'dog grooming', strongName: '\\b(groom)', coreCategories: ['pet groomer'] };
    const rows = [
      { name: 'AC Male Grooming Armagh', category: 'Barber shop', address: '1 Main St, Armagh BT61 7AA' },
      { name: 'Luxe Male Grooming Armagh', category: 'Barber shop', address: '2 Main St, Armagh BT61 7AB' },
      { name: 'Happy Paws Grooming', category: 'Pet groomer', address: '3 High St, Lisburn BT28 1AA' }
    ];
    expect(nameConflicts(rows, G, ['barber shop'])).toEqual(['\\bmale\\b']);
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
    expect(results[2]?.reason).toBe('Free filter: Duplicate of Good Storm Shelters');
    expect(counts).toEqual({ keep: 1, review: 1, remove: 2, unchecked: 0 });
    expect(jev.requests).toHaveLength(1);
    expect(results[0]?.fields?.clean_jev_asks).toBe(1);
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

  it('records evidence and re-decides from it with no website reads or Jev calls', async () => {
    let fetches = 0;
    const counting = async (u: string) => { fetches++; return fetcher(u); };
    const outOfState: Row[] = [...rows, { name: 'Okie Storm Shelters', website: 'okie.example', address: '1 Main St, Tulsa, OK 74103, United States', category: 'Contractor', place_key: '9' }];
    html['http://okie.example/'] = '<title>Okie Storm Shelters</title><body>Tornado shelters installed within 300 miles of Tulsa. Garage floor shelters, FEMA 361 safe rooms, free quotes.</body>';
    const jev = new MockClassifier(req => {
      const okie = JSON.stringify(req.state).includes('Okie');
      return { supplies: { noul: 0.97 }, public_place: { noul: 0 }, serves_state: { choice: okie ? 'partly' : 'yes', probabilities: { no: 0 } }, role: { choice: 'provider' } };
    });
    const first = await runJob({ rows: outOfState, template: directoryTemplate, rules: S, area: 'KS', classifier: jev, fetcher: counting });
    expect(first.results[4]?.outcome).toBe('review');
    const readsBefore = fetches, asksBefore = jev.requests.length;

    // New rule: partial reach counts as Clean. Re-decide from evidence only.
    const again = await runJob({ rows: outOfState, template: directoryTemplate, rules: { ...S, partialArea: 'keep' }, area: 'KS', fetcher: counting, replay: first.evidence });
    expect(fetches).toBe(readsBefore);
    expect(jev.requests.length).toBe(asksBefore);
    expect(again.results[4]?.outcome).toBe('keep');
    expect(again.results[0]?.outcome).toBe('keep');
    expect(again.replayed).toBe(first.results.filter(r => r?.stage === 'checked').length);
    expect(again.needsFresh).toBe(0);
  });

  it('flags businesses whose new rules need a Jev answer the evidence lacks', async () => {
    const first = await runJob({ rows, template: directoryTemplate, rules: S, area: 'KS', fetcher });   // no Jev at all
    const jev = new MockClassifier(() => ({ supplies: { noul: 0.9 }, serves_state: { choice: 'yes' } }));
    const offline = await runJob({ rows, template: directoryTemplate, rules: S, area: 'KS', fetcher, replay: first.evidence });
    expect(offline.results[0]?.reason).toMatch(/^Keyword score/);   // decided as before, without Jev
    const live = await runJob({ rows, template: directoryTemplate, rules: S, area: 'KS', fetcher, replay: first.evidence, classifier: jev });
    expect(live.results[0]?.reason).toMatch(/^Jev: offers/);
    expect(jev.requests.length).toBe(1);
  });

  it('sends a listing that uses another company\u2019s website to Review (City Storm Shelter / Ground Zero)', async () => {
    const list: Row[] = [
      { name: 'Ground Zero Shelters, Co.', website: 'https://www.groundzeroshelters.com/', place_key: 'g1' },
      { name: 'City Storm Shelter', website: 'http://www.groundzeroshelters.com/oklahoma-city-storm-shelters.html', place_key: 'g2' },
      { name: 'Tornado Place- Storm Shelters', website: 'http://www.tornadoplace.com/', place_key: 't1' },
      { name: 'Tornado Place of Arkansas', website: 'http://www.tornadoplace.com/', place_key: 't2' }
    ];
    prefilter(list, S);
    expect(list[1]._site_owner).toBe('Ground Zero Shelters, Co.');
    expect(list[3]._site_owner).toBeUndefined(); // same company, another branch
    const html2: Record<string, string> = { 'http://www.groundzeroshelters.com/oklahoma-city-storm-shelters.html': '<body>' + 'We install tornado shelters and safe rooms across Kansas and Oklahoma. '.repeat(3) + '</body>' };
    const jev = new MockClassifier(() => ({ supplies: { noul: 0.95 }, serves_state: { choice: 'yes' }, kind: { choice: 'supplier', probabilities: { supplier: 1 } } }));
    const { results: all } = await runJob({ rows: list, template: directoryTemplate, rules: S, area: 'KS', classifier: jev, fetcher: async u => html2[u] ? { html: html2[u], url: u } : null });
    expect(all[1]?.outcome).toBe('review');
    expect(all[1]?.reason).toMatch(/also used by Ground Zero Shelters/);
  });

  it('keeps the better listing of a duplicate pair, and ignores shared booking platforms (NI dog grooming)', () => {
    const G = { ...S, niche: 'dog grooming', strongName: '\\b(groom)', coreCategories: ['pet groomer'] };
    const list: Row[] = [
      { name: 'Pets at Home Lisburn', category: 'Pet store', phone: '+44 345 850 9618', website: 'https://www.petsathome.com/find-us/lisburn' },
      { name: 'The Groom Room Lisburn', category: 'Pet groomer', phone: '+44 345 850 9618', website: 'https://www.petsathome.com/find-us/lisburn-groom' },
      { name: 'Country Tails Dog Grooming', category: 'Pet groomer', website: 'https://book.heygoldie.com/Country-Tails' },
      { name: "Elena's Dog Grooming", category: 'Pet groomer', website: 'https://book.heygoldie.com/Elenas' }
    ];
    const r = prefilter(list, G);
    expect(r[0]).toBe('Duplicate of The Groom Room Lisburn');
    expect(r[1]).toBe('');
    expect(list[3]._site_owner).toBeUndefined();
    expect(list[2]._site_owner).toBeUndefined();
  });

  it('honours --limit', async () => {
    const { counts } = await runJob({ rows, template: directoryTemplate, rules: S, area: 'KS', fetcher, limit: 1 });
    expect(counts.unchecked).toBe(2);
  });
});
