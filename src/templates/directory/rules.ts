// Rules for the Directory builder template. Ported from the extension's cleaner-engine.js (v2.5.5).

export interface DirectoryRules {
  profileName?: string;
  /** Plain-English description of what the directory lists, used in Jev questions and reasons. */
  niche: string;
  /** Regex: a business name that clearly belongs (e.g. "tornado shelter"). */
  strongName: string;
  /** Phrases that count as evidence on a website. */
  positive: string[];
  /** Google categories that might offer the service: Review when the website can't be read. */
  plausibleCategories: string[];
  /** Google categories that prove a match on their own. */
  coreCategories: string[];
  /** Regexes: names of other kinds of business, removed for free. */
  excludeName: string[];
  /** Categories removed even when the name looks right. */
  hardExcludeCategory: string[];
  /** Categories removed for free unless the name looks right. */
  excludeCategory: string[];
  /** "Keyword = regex" lines: services shown in the output. */
  services: string[];
  jevHigh: number;
  jevLow: number;
  publicReject: number;
  keywordClean: number;
  /**
   * New in list-cleaner: a category on the plausible list is never removed by the soft exclude list.
   * Fixes the extension removing "Metal fabricator" because "fabric" (fabric shops) is excluded.
   * Set false to reproduce the extension exactly.
   */
  protectPlausible: boolean;
  /**
   * Where a business based outside the target area goes when it reaches only part of it
   * (an install radius, a region, delivery or drop-shipping). Default 'review'.
   */
  partialArea: 'keep' | 'review' | 'remove';
  /**
   * A supplier based outside the area but within this many miles of it (US ZIP distance) goes to Review
   * instead of Rejected, even with no sign of serving the area. 0 turns it off. Default 50.
   */
  nearbyMiles: number;
}

export const RULE_DEFAULTS: DirectoryRules = {
  niche: 'this kind of business', strongName: '(?!)', positive: [], plausibleCategories: [], coreCategories: [], excludeName: [],
  hardExcludeCategory: [], excludeCategory: [], services: [], jevHigh: 0.75, jevLow: 0.25, publicReject: 0.7, keywordClean: 55, protectPlausible: true, partialArea: 'review', nearbyMiles: 50
};

export const STORM_PRESET: DirectoryRules = {
  ...RULE_DEFAULTS,
  profileName: 'Storm shelters',
  niche: 'storm shelters, tornado shelters or safe rooms',
  strongName: '(storm|tornado|twister)\\s*-?\\s*(shelter|cellar|safe|bunker|pod|vault)|safe\\s*-?\\s*rooms?|saferoom|bunker|underground\\s+shelter',
  positive: ['storm shelter', 'tornado shelter', 'safe room', 'saferoom', 'safe-room', 'storm cellar', 'underground shelter',
    'above ground shelter', 'above-ground shelter', 'in-ground shelter', 'inground shelter', 'garage shelter', 'garage floor shelter',
    'icc 500', 'icc-500', 'fema p-361', 'fema p-320', 'fema 361', 'fema 320', 'bunker', 'shelter door'],
  plausibleCategories: ['contractor', 'construction', 'builder', 'concrete', 'manufacturer', 'fabricat', 'welder', 'welding', 'steel',
    'metal', 'safety equipment', 'portable building', 'shed', 'garage', 'excavat', 'precast', 'corporate office'],
  excludeName: ['shelter insurance', 'animal', 'humane society', 'homeless', 'rescue mission', "women'?s shelter", 'emergency shelter',
    'shelter house', 'pavilion', 'kiwanis', 'picnic', '\\bpark\\s*[-–]', 'park shelter', 'shelter\\s*\\d', '\\brv park', 'church',
    '\\bschool\\b', 'library', 'food ?bank', 'salvation army', 'red cross', 'housing authority'],
  hardExcludeCategory: ['homeless', 'animal shelter', "women's shelter", 'abuse', 'social services', 'church', 'worship', 'religious', 'school', 'government', 'insurance', 'park'],
  excludeCategory: ['insurance', 'government', 'non-profit', 'non-governmental', 'social services', 'homeless', 'animal', "women's shelter",
    'abuse', 'church', 'worship', 'religious', 'school', 'college', 'university', 'library', 'museum', 'park', 'garden', 'zoo', 'landmark',
    'tourist', 'visitor', 'attraction', 'restaurant', 'cafe', 'coffee', 'bar', 'brewery', 'winery', 'pub', 'hotel', 'motel', 'guest house',
    'campsite', 'caravan', 'hospital', 'clinic', 'chiropractor', 'therapy', 'medical', 'dentist', 'veterinar', 'salon', 'barber', 'beauty',
    'massage', 'spa', 'gym', 'trainer', 'bank', 'finance', 'title company', 'estate agent', 'letting', 'rental agency', 'property investment',
    'apartment', 'flat complex', 'housing', 'student', 'retirement', 'assisted living', 'car ', 'car dealer', 'auto parts', 'vehicle', 'tyre',
    'tire', 'motor', 'oil change', 'towing', 'windshield', 'chevrolet', 'honda', 'subaru', 'truck dealer', 'fire station', 'ambulance',
    'public safety', 'military', 'army', 'airport', 'public toilet', 'bathroom', 'sports', 'stadium', 'swimming', 'community centre',
    'foodbank', 'charity', 'association', 'organisation', 'organization', 'foundation', 'events venue', 'wedding', 'cinema', 'theatre',
    'concert', 'department store', 'supermarket', 'general store', 'discount', 'pound shop', 'clothing', 'jewellery', 'lingerie', 'fabric',
    'craft', 'piano', 'dvd', 'bicycle', 'running shop', 'stationery', 'art supply', 'picture framing', 'kitchenware', 'gun shop', 'ammunition',
    'hunting', 'electronics', 'computer', 'cleaning', 'janitorial', 'pest control', 'lawn', 'tree service', 'removals', 'junk', 'launderette',
    'childcare', 'learning', 'music teacher', 'counsellor', 'nail', 'waxing', 'escape room', 'amusement', 'playground', 'golf', 'union'],
  services: [
    'storm shelter installers = install', 'storm shelter builders = \\bbuil[dt]|construct', 'storm shelter manufacturers = manufactur|fabricat',
    'storm shelter dealers = dealer|retailer|authori[sz]ed|for sale', 'storm shelter repairs = repair',
    'tornado shelter installers = tornado.{0,40}install|install.{0,40}tornado', 'tornado shelter manufacturers = tornado.{0,40}manufactur|manufactur.{0,40}tornado',
    'safe room installers = safe ?rooms?.{0,60}install|install.{0,60}safe ?rooms?', 'safe room builders = safe ?rooms?.{0,60}(buil|construct)|(buil|construct).{0,60}safe ?rooms?',
    'residential storm shelters = residential|homeowner|your home|for homes', 'commercial storm shelters = commercial|business(es)?\\b|community shelter|schools?\\b',
    'above ground storm shelters = above[- ]?ground', 'underground storm shelters = underground|in-?ground|below[- ]ground',
    'garage floor storm shelters = garage', 'concrete storm shelters = concrete|precast', 'steel storm shelters = steel',
    'storm shelter maintenance = maintenance', 'storm shelter inspections = inspect', 'storm shelter door replacement = door (replacement|upgrade)|replacement doors?|shelter doors?',
    'storm shelter waterproofing = waterproof|sealing|leak', 'storm shelter relocation = relocat|moving (your )?shelter',
    'FEMA safe room builders = fema', 'ICC 500 storm shelters = icc[- ]?500', 'community storm shelter builders = community (storm |tornado )?shelter'
  ],
  coreCategories: [] // Google has no storm-shelter category, so none prove a match on their own
};

// ---------- compiled form ----------

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface CompiledRules {
  strong: RegExp;
  badName: RegExp | null;
  badCats: string[];
  hardCats: string[];
  plausible: string[];
  core: string[];
  positive: { phrase: string; re: RegExp }[];
  services: { keyword: string; re: RegExp }[];
}

const cache = new WeakMap<DirectoryRules, CompiledRules>();
export function compile(S: DirectoryRules): CompiledRules {
  let c = cache.get(S);
  if (!c) {
    c = {
      strong: new RegExp(S.strongName, 'i'),
      badName: S.excludeName.length ? new RegExp(S.excludeName.join('|'), 'i') : null,
      badCats: S.excludeCategory.map(x => x.toLowerCase()),
      hardCats: S.hardExcludeCategory.map(x => x.toLowerCase()),
      plausible: S.plausibleCategories.map(x => x.toLowerCase()),
      core: S.coreCategories.map(x => x.toLowerCase()).filter(Boolean),
      positive: S.positive.map(p => ({ phrase: p, re: new RegExp(esc(p.toLowerCase()).replace(/[\s-]+/g, '[\\s-]?'), 'i') })),
      services: S.services.map(line => {
        const i = line.indexOf('=');
        if (i < 0) return null;
        const keyword = line.slice(0, i).trim(), pattern = line.slice(i + 1).trim();
        try { return keyword && pattern ? { keyword, re: new RegExp(pattern, 'i') } : null; } catch { return null; }
      }).filter((x): x is { keyword: string; re: RegExp } => !!x)
    };
    cache.set(S, c);
  }
  return c;
}

/** Fills defaults and checks every pattern compiles. */
export function parseDirectoryRules(input: unknown): DirectoryRules {
  if (!input || typeof input !== 'object') throw new Error('Rules must be a JSON object.');
  const o = input as Partial<DirectoryRules>;
  const list = (v: unknown) => Array.isArray(v) ? v.map(String).map(s => s.trim()).filter(Boolean) : [];
  const num = (v: unknown, d: number, lo: number, hi: number) => typeof v === 'number' && v >= lo && v <= hi ? v : d;
  const rules: DirectoryRules = {
    profileName: o.profileName ? String(o.profileName) : undefined,
    niche: String(o.niche || RULE_DEFAULTS.niche).trim(),
    strongName: String(o.strongName || RULE_DEFAULTS.strongName),
    positive: list(o.positive), plausibleCategories: list(o.plausibleCategories), coreCategories: list(o.coreCategories),
    excludeName: list(o.excludeName), hardExcludeCategory: list(o.hardExcludeCategory), excludeCategory: list(o.excludeCategory), services: list(o.services),
    jevHigh: num(o.jevHigh, 0.75, 0.5, 0.99), jevLow: num(o.jevLow, 0.25, 0.01, 0.5),
    publicReject: num(o.publicReject, 0.7, 0.5, 0.99), keywordClean: num(o.keywordClean, 55, 1, 100),
    protectPlausible: o.protectPlausible !== false,
    partialArea: o.partialArea === 'keep' || o.partialArea === 'remove' ? o.partialArea : 'review',
    nearbyMiles: num(o.nearbyMiles, 50, 0, 500)
  };
  try { new RegExp(rules.strongName, 'i'); } catch (e) { throw new Error('strongName is not a valid pattern: ' + (e as Error).message); }
  for (const p of rules.excludeName) { try { new RegExp(p, 'i'); } catch { throw new Error(`excludeName pattern is not valid: ${p}`); } }
  for (const s of rules.services) {
    const i = s.indexOf('=');
    if (i < 0) throw new Error(`services line needs "keyword = pattern": ${s}`);
    try { new RegExp(s.slice(i + 1).trim(), 'i'); } catch { throw new Error(`services pattern is not valid: ${s}`); }
  }
  return rules;
}

// ---------- starter rules for a new directory ----------

const STOP = new Set('near me nearby local best cheap top in the a an and or for of to my your services service company companies business businesses uk usa'.split(' '));
const GENERIC_EXCLUDE = ['insurance', 'government', 'non-profit', 'social services', 'homeless', 'church', 'worship', 'religious', 'school', 'college',
  'university', 'library', 'museum', 'park', 'zoo', 'landmark', 'tourist', 'restaurant', 'cafe', 'coffee', 'bar ', 'pub ', 'hotel', 'motel', 'guest house',
  'hospital', 'clinic', 'dentist', 'bank', 'finance', 'estate agent', 'letting', 'apartment', 'housing', 'student', 'car dealer', 'auto parts', 'tyre',
  'tire', 'oil change', 'fire station', 'police', 'military', 'airport', 'public toilet', 'stadium', 'community centre', 'foodbank', 'charity',
  'association', 'organisation', 'organization', 'foundation', 'cinema', 'theatre', 'supermarket', 'department store', 'clothing', 'jewellery'];
/** Words in a niche whose related categories must not be filtered out (e.g. "dog" keeps "animal", "pet", "veterinary"). */
const KEEP_IF: Record<string, string[]> = {
  dog: ['animal', 'pet', 'veterinar'], cat: ['animal', 'pet', 'veterinar'], pet: ['animal', 'pet', 'veterinar'], horse: ['animal', 'veterinar'],
  car: ['car ', 'auto', 'tyre', 'tire', 'oil change'], vehicle: ['car ', 'auto', 'tyre', 'tire'], coffee: ['cafe', 'coffee'], food: ['restaurant', 'cafe'],
  wedding: ['hotel', 'church'], school: ['school', 'college'], driving: ['school'], tutor: ['school', 'college'], insurance: ['insurance', 'finance'],
  mortgage: ['bank', 'finance'], estate: ['estate agent', 'letting'], hotel: ['hotel', 'guest house'], dental: ['dentist', 'clinic']
};
const stem = (w: string) => w.replace(/(ings|ing|ers|er|es|s)$/, '') || w;

export function looksLikeStorm(name: string, terms: string[]): boolean {
  return /storm|tornado|shelter|safe ?room/i.test(name + ' ' + terms.join(' '));
}

/** Starter rules for a directory, built from its name, search terms and collected rows. */
export function buildProfile(directoryName: string, terms: string[], rows: { name?: string; category?: string }[] = []): DirectoryRules {
  if (looksLikeStorm(directoryName, terms)) return { ...structuredClone(STORM_PRESET), profileName: directoryName || 'Storm shelters' };
  const clean = (t: string) => t.toLowerCase().replace(/near me|near by|nearby/g, ' ').split(/[^a-z0-9&']+/).filter(w => w && !STOP.has(w)).join(' ').trim();
  const phrases = [...new Set([clean(directoryName || ''), ...terms.map(clean)].filter(Boolean))];
  const words = phrases.join(' ').split(' ').filter(w => w.length >= 5);
  const counts: Record<string, number> = {};
  for (const p of phrases) for (const st of new Set(p.split(' ').filter(w => w.length >= 5).map(stem))) counts[st] = (counts[st] || 0) + 1;
  let stems = Object.keys(counts).filter(st => counts[st] >= 2);
  if (!stems.length) stems = [...new Set(words.map(stem))];
  const niche = clean(directoryName || '') || phrases[0] || 'this kind of business';
  const strongName = stems.length ? '\\b(' + stems.map(esc).join('|') + ')' : esc(niche);
  const nicheWords = phrases.join(' ').split(' ');
  const keep = new Set(nicheWords.flatMap(w => KEEP_IF[w] || KEEP_IF[stem(w)] || []));
  const excludeCategory = GENERIC_EXCLUDE.filter(c => !keep.has(c) && !nicheWords.some(w => w.length > 2 && (c.includes(w) || w.includes(c.trim()))));
  const re = new RegExp(strongName, 'i'), cats: Record<string, number> = {};
  for (const row of rows) if (re.test(row.name || '') && row.category) cats[row.category.toLowerCase()] = (cats[row.category.toLowerCase()] || 0) + 1;
  const plausibleCategories = Object.entries(cats).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([c]) => c);
  return {
    ...RULE_DEFAULTS,
    profileName: directoryName || niche,
    niche,
    strongName,
    positive: [...new Set([...phrases, ...stems])],
    plausibleCategories,
    coreCategories: [...new Set([...stems, ...Object.keys(cats).filter(c => stems.some(st => c.includes(st)))])],
    excludeName: ['\\bpark\\s*[-–]', 'church', '\\bschool\\b', 'library', 'food ?bank'].filter(n => !nicheWords.some(w => n.includes(w))),
    hardExcludeCategory: ['homeless', 'government', 'church', 'worship', 'religious', 'insurance'].filter(c => !keep.has(c) && !nicheWords.includes(c)),
    excludeCategory,
    services: phrases.map(p => `${p} = ${p.split(' ').map(w => esc(stem(w))).join('.{0,20}')}`)
  };
}

/** Search terms used for a batch, from the rows' "Search Query" values. */
export function termsFromRows(rows: { search_term?: string }[]): string[] {
  const set = new Map<string, string>();
  for (const row of rows) for (const t of String(row.search_term || '').split(';')) { const v = t.trim(); if (v) set.set(v.toLowerCase(), v); }
  return [...set.values()];
}

// ---------- rule suggestions from the batch's categories ----------

export interface CategoryStat { category: string; key: string; count: number; strongCount: number; examples: string[] }

export function categoryStats(rows: { name?: string; category?: string }[], S: DirectoryRules): CategoryStat[] {
  const C = compile(S), map = new Map<string, CategoryStat>();
  for (const row of rows) {
    const cat = String(row.category || '').trim();
    if (!cat) continue;
    const k = cat.toLowerCase();
    if (!map.has(k)) map.set(k, { category: cat, key: k, count: 0, strongCount: 0, examples: [] });
    const st = map.get(k)!; st.count++;
    if (C.strong.test(row.name || '')) st.strongCount++;
    if (st.examples.length < 6 && row.name) st.examples.push(row.name);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/** Categories the current rules already decide need no question. */
export function categoryAlreadyRuled(stat: CategoryStat, S: DirectoryRules): boolean {
  const C = compile(S), k = stat.key, padded = k + ' ';
  return C.core.some(c => k.includes(c)) || C.hardCats.some(c => k.includes(c)) || (!stat.strongCount && C.badCats.some(c => padded.includes(c)));
}

export interface CategoryVerdict { stat: CategoryStat; probabilities?: Record<string, number> }

/** Turns confident category verdicts into rule additions. */
export function applyCategoryVerdicts(S: DirectoryRules, verdicts: CategoryVerdict[]) {
  const next: DirectoryRules = { ...S, coreCategories: [...S.coreCategories], plausibleCategories: [...S.plausibleCategories],
    excludeCategory: [...S.excludeCategory], hardExcludeCategory: [...S.hardExcludeCategory] };
  const added = { core: [] as string[], review: [] as string[], remove: [] as string[], hard: [] as string[] };
  const add = (list: string[], key: string, bucket: keyof typeof added) => { if (!list.includes(key)) { list.push(key); added[bucket].push(key); } };
  for (const { stat, probabilities: p } of verdicts) {
    if (!p) continue;
    if ((p.is_the_service || 0) >= 0.6) add(next.coreCategories, stat.key, 'core');
    else if ((p.non_commercial || 0) >= 0.7) add(next.hardExcludeCategory, stat.key, 'hard');
    else if ((p.different_trade || 0) >= 0.8) add(stat.strongCount ? next.hardExcludeCategory : next.excludeCategory, stat.key, stat.strongCount ? 'hard' : 'remove');
    else if ((p.might_offer || 0) >= 0.4 || (p.is_the_service || 0) >= 0.3) add(next.plausibleCategories, stat.key, 'review');
  }
  const moved = new Set([...added.core, ...added.remove, ...added.hard]);
  next.plausibleCategories = next.plausibleCategories.filter(c => !moved.has(c) && !next.coreCategories.some(k => c.includes(k)));
  return { S: next, added };
}

/** Words in matching-looking names that only appear in other trades (e.g. "gents" in "Gents Grooming", a barber). */
export function nameConflicts(rows: { name?: string; category?: string }[], S: DirectoryRules, otherCategoryKeys: string[]): string[] {
  const C = compile(S), other = new Set(otherCategoryKeys);
  const words = (n: unknown) => String(n || '').toLowerCase().split(/[^a-z0-9']+/).map(w => w.replace(/'s$/, '')).filter(w => w.length >= 3 && !STOP.has(w));
  const genuine = new Set<string>(), counts: Record<string, number> = {};
  for (const row of rows) {
    const cat = String(row.category || '').toLowerCase();
    if (C.core.some(c => cat.includes(c))) words(row.name).forEach(w => genuine.add(w));
  }
  for (const row of rows) {
    const cat = String(row.category || '').toLowerCase();
    if (!other.has(cat) || !C.strong.test(row.name || '')) continue;
    for (const w of new Set(words(row.name))) if (!C.strong.test(w)) counts[w] = (counts[w] || 0) + 1;
  }
  return Object.entries(counts).filter(([w, n]) => n >= 2 && !genuine.has(w) && !/^\d+$/.test(w)).map(([w]) => '\\b' + esc(w) + '\\b');
}
