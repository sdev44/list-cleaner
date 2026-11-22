// Directory builder: "does this business really belong in my directory, in my area?"
// Logic ported from the extension's cleaner (v2.5.5); behaviour kept identical except `protectPlausible`.
import { inArea, regionName, rowArea, sameArea, searchedInArea, US_STATES } from '../../core/area.js';
import { sameSiteUrl, siteHost } from '../../core/site.js';
import { milesFromArea, phoneArea } from '../../core/geo.js';
import type { CheckContext, Template } from '../../core/template.js';
import type { Answer, Classifier, ClassifierRequest, Decision, Page, Row, SiteRead } from '../../core/types.js';
import {
  applyCategoryVerdicts, buildProfile, categoryAlreadyRuled, categoryStats, compile, looksLikeStorm, nameConflicts, parseDirectoryRules,
  type CategoryVerdict, type DirectoryRules
} from './rules.js';

const simpleName = (n: unknown) => String(n || '').toLowerCase().replace(/\b(llc|inc|co|ltd|the|of)\b/g, '').replace(/[^a-z0-9]/g, '');
const pct = (n: number) => Math.round(n * 100) + '%';

// ---------- stage 1: free filter ----------

/** Words that say what a business does, not who it is ("storm", "shelters", "llc"): ignored when comparing names. */
function nameWords(name: unknown, S: DirectoryRules): Set<string> {
  const generic = new Set([...S.niche.toLowerCase().split(/[^a-z]+/), 'llc', 'inc', 'co', 'ltd', 'the', 'and', 'of', 'company', 'services', 'service', 'group']);
  return new Set(String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !generic.has(w) && !generic.has(w.replace(/s$/, ''))).map(w => w.replace(/s$/, '')));
}

/** Key under which the free filter notes "this website belongs to another business in the list". */
export const SITE_OWNER = '_site_owner';

/** Booking and site-builder platforms: many unrelated businesses share these hosts. */
const PLATFORM_HOST = /(^|\.)(heygoldie\.com|fresha\.com|booksy\.com|setmore\.com|square\.site|squareup\.com|linktr\.ee|wixsite\.com|godaddysites\.com|business\.site|sites\.google\.com|calendly\.com|acuityscheduling\.com|vagaro\.com|simplybook\.\w+|gingrapp\.com|petsapp\.com|weebly\.com|wordpress\.com|blogspot\.com|carrd\.co|yell\.com|checkatrade\.com|bark\.com)$/i;

/** How good a listing is for the directory, to decide which of two duplicates to keep. */
function listingScore(row: Row, S: DirectoryRules): number {
  const C = compile(S), cat = String(row.category || '').toLowerCase();
  const reviews = Number(String(row.review_count || '').replace(/,/g, '')) || 0;
  return (C.core.some(c => cat.includes(c)) ? 8 : 0) + (C.strong.test(row.name || '') ? 4 : 0) + (siteHost(row.website) ? 2 : 0) + Math.min(1.9, Math.log10(1 + reviews));
}

export function prefilter(rows: Row[], S: DirectoryRules): string[] {
  const C = compile(S), seen = new Map<string, Row>(), hostOwner = new Map<string, Row>();
  // With strictDuplicates, the best listing of a duplicate pair is kept (e.g. "The Groom Room" salon
  // rather than the "Pets at Home" store it sits in). Legacy mode keeps list order, like the extension.
  const order = rows.map((_, i) => i);
  if (S.strictDuplicates) {
    const score = rows.map(r => listingScore(r, S));
    order.sort((a, b) => score[b] - score[a] || a - b);
  }
  // Website ownership: the listing that uses the homepage, then the one with more reviews.
  const isHome = (u: unknown) => { try { return new URL(/^https?:/i.test(String(u)) ? String(u) : 'http://' + u).pathname.replace(/\/(index\.\w+)?$/, '') === ''; } catch { return false; } };
  const reviews = (r: Row) => Number(String(r.review_count || '').replace(/,/g, '')) || 0;
  const ownerOrder = rows.map((_, i) => i).sort((a, b) => (isHome(rows[b].website) ? 1 : 0) - (isHome(rows[a].website) ? 1 : 0) || reviews(rows[b]) - reviews(rows[a]) || a - b);
  for (const i of ownerOrder) {
    const row = rows[i];
    delete row[SITE_OWNER];
    const host = siteHost(row.website);
    if (!host || PLATFORM_HOST.test(host)) continue;
    const owner = hostOwner.get(host);
    if (!owner) { hostOwner.set(host, row); continue; }
    const a = nameWords(owner.name, S), b = nameWords(row.name, S);
    // Different names (no shared distinctive word) on one website: probably another company's page.
    if (a.size && b.size && ![...b].some(w => a.has(w))) row[SITE_OWNER] = String(owner.name);
  }
  const reasons: string[] = rows.map(() => '');
  for (const i of order) {
    const row = rows[i];
    const name = String(row.name || '').trim();
    const cat = String(row.category || '').toLowerCase() + ' ';
    const phone = String(row.phone || '').replace(/\D/g, '');
    const host = siteHost(row.website);
    const platform = !!host && PLATFORM_HOST.test(host);
    const ids = [row.place_id, row.place_key, phone && name.toLowerCase() + '|' + phone, host && 'site:' + host + '|' + simpleName(name),
      S.strictDuplicates && !platform && phone.length >= 10 && host && 'phone+site:' + phone.slice(-10) + '|' + host].filter(Boolean).map(String);
    const protectedCat = S.protectPlausible && C.plausible.some(c => cat.includes(c));
    const twin = ids.map(id => seen.get(id)).find(Boolean);
    let reason = '';
    if (!name) reason = 'No business name';
    else if (twin) reason = S.strictDuplicates ? `Duplicate of ${twin.name}` : 'Duplicate';
    else if (/permanently closed/i.test(row.business_status || '')) reason = 'Permanently closed';
    else if (C.hardCats.some(c => cat.includes(c))) reason = 'Unrelated category: ' + row.category;
    else if (!C.strong.test(name) && !protectedCat && C.badCats.find(c => cat.includes(c))) reason = 'Unrelated category: ' + row.category;
    else if (C.badName && C.badName.test(name) && !C.core.some(c => cat.includes(c))) reason = 'Name shows a non-commercial or different kind of business';
    ids.forEach(id => { if (!seen.has(id)) seen.set(id, row); });
    reasons[i] = reason;
  }
  return reasons;
}

// ---------- website reading ----------

/** Best inner page: one about the niche, else services/products. */
export function bestLink(page: Page, S: DirectoryRules): string {
  const C = compile(S);
  // Storm shelters keep the extension's exact URL pattern; other niches use words from their description.
  const nicheWords = S.niche.toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 5).map(w => w.replace(/s$/, ''));
  const hrefRe = looksLikeStorm(S.niche, []) ? /storm|tornado|shelter|safe-?room|bunker|cellar/i
    : nicheWords.length ? new RegExp(nicheWords.join('|'), 'i') : null;
  const hot = (l: { href: string; text: string }) => C.positive.some(p => p.re.test(l.text)) || (!!hrefRe && hrefRe.test(l.href));
  const warm = (l: { href: string; text: string }) => /services|products|what-we-do|our-work|shelters?/i.test(l.href + ' ' + l.text);
  // Only same-site links count. (The extension picked the first matching link anywhere, so one off-site
  // "storm" link, e.g. to a manufacturer, stopped it reading the business's own shelter page.)
  const local = page.links.map(l => ({ ...l, url: sameSiteUrl(l, page) })).filter(l => l.url);
  return (local.find(hot) || local.find(warm))?.url || '';
}

const AREA_LINK = /service[- ]?areas?|areas?[- ]we[- ]serve|areas?[- ]served|where[- ]we[- ](serve|work|install)|locations?|coverage|delivery|shipping/i;

/** A page about where the business works, if the site has one. */
export function areaLink(page: Page): string {
  const local = page.links.map(l => ({ ...l, url: sameSiteUrl(l, page) })).filter(l => l.url);
  return local.find(l => AREA_LINK.test(l.href + ' ' + l.text))?.url || '';
}

// What counts as a business saying it reaches beyond its base. Kinds, strongest first:
//  radius  "up to 300 miles", "200-mile radius" (compared with the real distance)
//  wide    nationwide, all 50 states, ships/delivers to a place
//  near    surrounding/neighbouring states, a named region it serves
const REACH: { kind: 'radius' | 'wide' | 'near'; re: RegExp }[] = [
  { kind: 'radius', re: /\b(\d{2,4})[- ]?miles?\b(?:[- ]radius)?(?=[^.!?|]{0,60}\b(?:from|of|around|radius|away|our)\b)|\b(?:within|up to|radius of)\s+(?:a\s+)?(\d{2,4})[- ]?miles?\b/i },
  { kind: 'wide', re: /\b(nationwide|all 50 states|across the (?:us|u\.s\.|usa|united states|country)|anywhere in the (?:us|u\.s\.|country)|(?:we|will) (?:deliver|ship)\b[^.!?|]{0,40}\b(?:to|across|throughout|anywhere|nationwide)\b|(?:free |nationwide )?(?:delivery|shipping) (?:to|across|available|nationwide)|drop[- ]?ship\w*)/i },
  { kind: 'near', re: /\b((?:serv(?:e|es|ing)|install(?:s|ing)?|work(?:s|ing)?) (?:in |across |throughout )?(?:the )?(?:surrounding|neighbou?ring|nearby|multiple|several|adjacent) (?:states|areas|counties)|surrounding states|neighbou?ring states (?:including|such as|like)|tri[- ]state area|(?:installations?|installs|deliver(?:y|ies)|jobs?|projects?) (?:located )?outside (?:the |our )?[\w .'-]{0,30}?(?:metro|area|city|county|region))/i }
];

export interface Reach { kind: 'radius' | 'wide' | 'near'; quote: string; miles?: number }

function quoteAround(t: string, index: number, length: number): string {
  const stops = /[.!?|•»«]/;
  let start = index, end = index + length;
  for (let i = 0; i < 110 && start > 0 && !stops.test(t[start - 1]); i++) start--;
  for (let i = 0; i < 110 && end < t.length && !stops.test(t[end]); i++) end++;
  let out = t.slice(start, end).trim();
  if (start > 0 && !stops.test(t[start - 1])) out = '…' + out.replace(/^\S*\s/, '');
  if (end < t.length && !stops.test(t[end])) out = out.replace(/\s\S*$/, '') + '…';
  return out;
}

/** The business's own words about reaching beyond its base, with the stated radius when it gives one. */
export function reachOf(text: string): Reach | null {
  const t = String(text || '').replace(/\s+/g, ' ');
  for (const { kind, re } of REACH) {
    const m = re.exec(t);
    if (!m) continue;
    // "$2 a mile for any job over 20 miles" is a travel charge: they go further, not a limit.
    if (kind === 'radius' && /(?:per|a|each)\s+mile|\bover\s+\d{1,4}\s*miles|beyond\s+\d{1,4}\s*miles|mileage|trip charge|travel (?:fee|charge)/i.test(t.slice(Math.max(0, m.index - 80), m.index + m[0].length + 40))) continue;
    const n = Number(m[1] || m[2]);
    return { kind, quote: quoteAround(t, m.index, m[0].length), ...(kind === 'radius' && n ? { miles: n } : {}) };
  }
  return null;
}

/** The quoted sentence only (kept for callers that just need the evidence). */
export const reachHint = (text: string): string => reachOf(text)?.quote || '';

const STATE_NAMES = new RegExp('\\b(' + Object.values(US_STATES).join('|') + ')\\b', 'gi');

/**
 * Does the site name the area as a place it serves? A mention inside a list of other states
 * ("we've installed in Alabama, Arkansas, … Kansas, Kentucky …", a dealer menu) doesn't count.
 */
export const mentionsArea = (text: string, area: string): boolean => {
  if (!area) return false;
  const t = String(text || '').replace(/\s+/g, ' ');
  const re = new RegExp('\\b' + regionName(area).replace(/\s+/g, '\\s+') + '\\b', 'gi');
  for (const m of t.matchAll(re)) {
    const around = t.slice(Math.max(0, m.index! - 120), m.index! + m[0].length + 120);
    const others = new Set([...around.matchAll(STATE_NAMES)].map(x => x[0].toLowerCase()).filter(x => x !== regionName(area).toLowerCase()));
    if (others.size < 3) return true;
  }
  return false;
};

// ---------- stage 2: keywords ----------

export interface KeywordResult { score: number; strong: boolean; found: string[] }

export function keywordScore(row: Row, siteText: string, S: DirectoryRules): KeywordResult {
  const C = compile(S);
  const strong = C.strong.test(row.name || '');
  const found = C.positive.filter(p => p.re.test(siteText || '')).map(p => p.phrase);
  const unique = [...new Map(found.map(f => [f.replace(/[\s-]/g, ''), f])).values()];
  return { score: Math.min(100, (strong ? 40 : 0) + Math.min(60, unique.length * 15)), strong, found: unique };
}

export function servicesFor(row: Row, siteText: string, S: DirectoryRules): string[] {
  const text = (row.name || '') + ' ' + (siteText || '');
  return compile(S).services.filter(s => s.re.test(text)).map(s => s.keyword);
}

export function coreCategory(row: Row, S: DirectoryRules): string {
  const cat = String(row.category || '').toLowerCase();
  return cat ? compile(S).core.find(c => cat.includes(c)) || '' : '';
}

type Legacy = { result: 'Clean' | 'Review' | 'Rejected'; reason: string } | { needsJev: true };

export function keywordStage(row: Row, site: SiteRead, kw: KeywordResult, S: DirectoryRules, area: string): Legacy {
  const C = compile(S);
  const cat = String(row.category || '').toLowerCase();
  const core = coreCategory(row, S);
  if (site.ok) {
    if (kw.score === 0 && core) return { needsJev: true };
    if (kw.score === 0) return { result: 'Rejected', reason: 'Name and website never mention ' + S.niche };
    return { needsJev: true };
  }
  if (core) return area && !inArea(row, area)
    ? { result: 'Review', reason: `Google category "${row.category}" fits, but it may be outside ${regionName(area)}; ${site.status.toLowerCase()}` }
    : { result: 'Clean', reason: `Google category "${row.category}" fits ${S.niche}; ${site.status.toLowerCase()}` };
  if (kw.strong) return { needsJev: true };
  if (C.plausible.some(c => cat.includes(c)) && site.kind !== 'none')
    return { result: 'Review', reason: `${site.status}; business type (${row.category}) could offer ${S.niche}` };
  return { result: 'Rejected', reason: `${site.status} and nothing in the name or category points to ${S.niche}` };
}

// ---------- stage 3: Jev ----------

export function jevRequest(row: Row, site: SiteRead, area: string, S: DirectoryRules): ClassifierRequest {
  return {
    model: 'jev-latest',
    state: {
      target_state: regionName(area),
      business: {
        name: row.name || '', google_category: row.category || '', address: row.address || '',
        service_areas: row.service_area_text || '', found_via_searches: row.search_term || ''
      },
      website: { url: row.website || '', status: site.status },
      website_text: (site.text || '(website not available)').slice(0, 9000)
    },
    questions: {
      supplies: {
        type: 'noul',
        instructions: `Using \`business\` and \`website_text\`, does this business itself offer ${S.niche} to customers — as a service it carries out or products it makes, sells, installs or maintains?`,
        criteria: {
          true: `The business offers ${S.niche} as one of its own products or services.`,
          false: 'It does not offer them: they are only mentioned in passing, in news, blog or advice, the listing is a public or non-commercial place, or the business does something else.'
        }
      },
      kind: {
        type: 'choice',
        instructions: `What kind of listing is this, with regard to ${S.niche}?`,
        criteria: {
          supplier: `A business that sells, makes, installs, builds or services ${S.niche} for customers.`,
          facility_with_them: `A place that only has ${S.niche} for its own residents, guests, staff or members (a housing development, apartments, hotel, venue, school, campground, business premises) rather than supplying them.`,
          public_shelter: 'A public or community shelter, park shelter or emergency-management listing.',
          other: 'Something else.'
        }
      },
      public_place: {
        type: 'noul',
        instructions: `Is this listing a public or community place (such as a park, public shelter or community centre), church, charity, school or government office, rather than a business that offers ${S.niche}?`
      },
      serves_state: {
        type: 'choice',
        instructions: 'Does this business serve customers in `target_state`? Use the address, service areas and any service-area text on the website.',
        criteria: {
          yes: 'Located in target_state, or clearly states it serves all of target_state or works nationwide.',
          partly: 'Based elsewhere, but its stated install radius, service region, delivery or shipping reaches into target_state or covers only part of it.',
          no: 'Based in another state and gives no sign of serving target_state.',
          unclear: 'Not enough information to tell.'
        }
      },
      role: {
        type: 'choice',
        instructions: `What is this business's main role regarding ${S.niche}?`,
        criteria: {
          provider: `Carries out ${S.niche} for customers directly (builds, installs or provides the service).`,
          manufacturer: 'Makes the products.',
          dealer: 'Sells or distributes products made by others.',
          service: 'Repairs, maintains or inspects them.',
          not_a_supplier: `Does not offer ${S.niche}.`
        }
      }
    }
  };
}

export function decideWithJev(row: Row, answers: Record<string, Answer>, area: string, kw: KeywordResult, S: DirectoryRules, siteText = '', distance: number | null = null): { result: 'Clean' | 'Review' | 'Rejected'; reason: string } {
  const supplies = answers.supplies?.noul ?? 0.5;
  const pub = answers.public_place?.noul ?? 0;
  const serves = answers.serves_state?.choice || 'unclear';
  const servesNo = answers.serves_state?.probabilities?.no ?? 0;
  // No address: the phone's area code is the best location clue. Being found in an area search is not.
  const phoneState = rowArea(row) ? '' : phoneArea(row);
  const noAddressState = !rowArea(row) && (phoneState ? sameArea(phoneState, area) : searchedInArea(row, area));
  const inState = sameArea(rowArea(row), area) || (noAddressState && (phoneState ? serves !== 'no' && serves !== 'partly' : serves === 'yes'));
  const kind = answers.kind?.choice || '';
  const kindP = answers.kind?.probabilities || {};
  const where = regionName(area);
  const partial = (why: string) => {
    const result = S.partialArea === 'keep' ? 'Clean' : S.partialArea === 'remove' ? 'Rejected' : 'Review';
    return { result, reason: `Offers ${S.niche} (${pct(supplies)}); based outside ${where} but may reach it` + (why ? `: "${why}"` : '') } as const;
  };
  const far = distance !== null && distance > 0 ? ` about ${distance} miles away` : ' elsewhere';
  /** Weighs the site's own reach claim against the real distance. */
  const judgeReach = (reach: Reach | null, jevSaysPartly: boolean) => {
    if (reach?.miles && distance !== null && distance > 0) {
      if (reach.miles >= distance) return partial(reach.quote);
      // A stated radius is often about speed or pricing, not a hard limit: only clearly-too-far is rejected.
      if (distance > reach.miles * 2)
        return { result: 'Rejected', reason: `Site gives a ${reach.miles}-mile reach but it is about ${distance} miles from ${where}: "${reach.quote}"` } as const;
      return { result: 'Review', reason: `Offers ${S.niche} (${pct(supplies)}); site gives a ${reach.miles}-mile reach and it is about ${distance} miles from ${where}: "${reach.quote}"` } as const;
    }
    if (reach && (reach.kind === 'wide' || distance === null || distance <= 300)) return partial(reach.quote);
    if (jevSaysPartly) return partial('');
    return null;
  };
  if (pub >= S.publicReject && !kw.strong) return { result: 'Rejected', reason: `Public/community place, not a supplier (${pct(pub)})` };
  const notSupplier = (kind === 'facility_with_them' || kind === 'public_shelter') && Math.max(kindP.facility_with_them ?? 0, kindP.public_shelter ?? 0, 0.6) >= 0.6;
  if (notSupplier) {
    const what = kind === 'public_shelter' ? 'a public or community shelter' : `a place that has ${S.niche} for its own use (housing, venue, premises)`;
    // A matching name might still be a supplier: let a person check those.
    return kw.strong ? { result: 'Review', reason: `Looks like ${what}, not a supplier` } : { result: 'Rejected', reason: `Looks like ${what}, not a supplier` };
  }
  if (supplies <= S.jevLow) return { result: 'Rejected', reason: `Jev: does not offer ${S.niche} (${pct(supplies)})` };
  if (supplies >= S.jevHigh) {
    if (inState) return {
      result: 'Clean', reason: `Jev: offers ${S.niche} (${pct(supplies)})` + (sameArea(rowArea(row), area) ? '' : noAddressState && serves !== 'yes' ? '; no address, ' + (phoneState ? `${where} phone number` : `found in ${where} searches`) : '; serves ' + where)
    };
    const reach = reachOf(siteText);
    // Just over the line (e.g. Kansas City, Missouri): one metro area, so Jev's yes or partly is enough.
    if (distance !== null && distance > 0 && distance <= 25 && (serves === 'yes' || serves === 'partly'))
      return { result: 'Clean', reason: `Jev: offers ${S.niche} (${pct(supplies)}); based about ${distance} miles from ${where}` };
    if (serves === 'yes') {
      // Based elsewhere: Jev's "yes" needs backing from the site, or the business must be close.
      // Naming the area or a radius that reaches counts; nationwide shipping alone does not (not a local installer).
      const backed = mentionsArea(siteText, area) || (reach?.miles && distance !== null && reach.miles >= distance);
      if (backed || (distance !== null && distance <= 150)) return { result: 'Clean', reason: `Jev: offers ${S.niche} (${pct(supplies)}); serves ${where}` };
      const judged = judgeReach(reach, false);
      if (judged) return judged;
      return { result: 'Review', reason: `Offers ${S.niche} (${pct(supplies)}); Jev says it serves ${where}, but it is based${far} and its site doesn't say so` };
    }
    if (serves === 'partly') return judgeReach(reach, true)!;
    if (serves === 'no' && servesNo >= 0.6) {
      // A stated radius, delivery or shipping can reach the area even when Jev says no.
      const judged = judgeReach(reach, false);
      if (judged) return judged;
      // Close to the area: a person should decide, however confident Jev is.
      if (distance !== null && distance > 0 && S.nearbyMiles > 0 && distance <= S.nearbyMiles)
        return { result: 'Review', reason: `Offers ${S.niche} (${pct(supplies)}); based about ${distance} miles from ${where}, no sign on its site of serving it` };
      return { result: 'Rejected', reason: `Based outside the area with no sign of serving ${where}` };
    }
    return { result: 'Review', reason: `Offers ${S.niche} (${pct(supplies)}) but service area unclear` };
  }
  if (coreCategory(row, S) && inState) return { result: 'Clean', reason: `Google category "${row.category}" fits; Jev ${pct(supplies)}` };
  return { result: 'Review', reason: `Jev unsure (${pct(supplies)} likely to offer ${S.niche})` };
}

/** Borderline first answers get a second opinion: supplies near the Clean line, or a "no" on area that isn't firm. */
export function isBorderline(answers: Record<string, Answer>, S: DirectoryRules): boolean {
  const supplies = answers.supplies?.noul ?? 0.5;
  const serves = answers.serves_state?.choice || 'unclear';
  const servesNo = answers.serves_state?.probabilities?.no ?? 0;
  return (supplies > S.jevLow + 0.15 && supplies < S.jevHigh + 0.1) || (serves === 'no' && servesNo < 0.85) || serves === 'partly';
}

/** Combines two sets of answers: averages probabilities; disagreeing choices become 'unclear'. */
export function mergeAnswers(a: Record<string, Answer>, b: Record<string, Answer>): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[key] || {}, y = b[key] || {};
    const merged: Answer = {};
    if (x.noul !== undefined || y.noul !== undefined) merged.noul = ((x.noul ?? y.noul!) + (y.noul ?? x.noul!)) / 2;
    if (x.choice || y.choice) merged.choice = x.choice && y.choice && x.choice !== y.choice ? (key === 'role' ? x.choice : 'unclear') : (x.choice || y.choice);
    if (x.probabilities || y.probabilities) {
      merged.probabilities = {};
      for (const k of new Set([...Object.keys(x.probabilities || {}), ...Object.keys(y.probabilities || {})]))
        merged.probabilities[k] = ((x.probabilities?.[k] ?? 0) + (y.probabilities?.[k] ?? 0)) / 2;
    }
    out[key] = merged;
  }
  return out;
}

export function decideWithoutJev(row: Row, kw: KeywordResult, area: string, S: DirectoryRules): { result: 'Clean' | 'Review' | 'Rejected'; reason: string } {
  if (coreCategory(row, S) && inArea(row, area)) return { result: 'Clean', reason: `Google category "${row.category}" fits ${S.niche}` };
  if (kw.score >= S.keywordClean && inArea(row, area)) return { result: 'Clean', reason: `Keyword score ${kw.score}: ${kw.found.slice(0, 4).join(', ')}` };
  return { result: 'Review', reason: `Keyword score ${kw.score}` + (kw.found.length ? ': ' + kw.found.slice(0, 4).join(', ') : '') + ' (no Jev key set)' };
}

const TO_OUTCOME = { Clean: 'keep', Review: 'review', Rejected: 'remove' } as const;

/**
 * Review order (1–99, higher first): businesses that clearly offer the service and only need an area
 * decision come first, nearest the area first; then unsure judgments; then unreadable websites.
 */
export function reviewPriority(reason: string, supplies: number | null, distance: number | null, strongName: boolean): number {
  const near = distance === null ? 0 : distance === 0 ? 8 : distance <= 50 ? 6 : distance <= 150 ? 3 : 0;
  if (supplies !== null && /may reach it|service area unclear|miles from|Jev says it serves|mile reach and|website is also used by/.test(reason)) return Math.min(99, 85 + near + (/: "/.test(reason) ? 2 : 0));
  if (supplies !== null && /^Jev unsure/.test(reason)) return 50 + Math.round(supplies * 19) + Math.min(near, 5);
  if (/^Jev check failed|^Check failed|took longer/.test(reason)) return 45;
  return (strongName ? 40 : 20) + Math.min(near, 5);
}

async function check(row: Row, ctx: CheckContext<DirectoryRules>): Promise<Decision> {
  const S = ctx.rules;
  const site = await ctx.readSite(row, page => [bestLink(page, S), areaLink(page)]);
  const kw = keywordScore(row, site.text, S);
  const distance = milesFromArea(row, ctx.area);
  const fields: Record<string, string | number> = { clean_score: kw.score, clean_site_check: site.status, clean_miles: distance ?? '' };
  let d = keywordStage(row, site, kw, S, ctx.area);
  if ('needsJev' in d) {
    if (ctx.classifier) {
      try {
        const request = jevRequest(row, site, ctx.area, S);
        const r = await ctx.classifier.ask(request);
        if (isBorderline(r.answers, S)) {
          r.answers = mergeAnswers(r.answers, (await ctx.classifier.ask(request)).answers);
          fields.clean_jev_asks = 2;
        } else fields.clean_jev_asks = 1;
        d = decideWithJev(row, r.answers, ctx.area, kw, S, site.text, distance);
        fields.clean_supplies = pct(r.answers.supplies?.noul ?? 0);
        fields.clean_role = (r.answers.role?.choice || '').replace(/_/g, ' ');
        fields.clean_serves = r.answers.serves_state?.choice || '';
      } catch (e) {
        if ((e as { code?: string }).code === 'auth') throw e;
        d = { result: 'Review', reason: 'Jev check failed: ' + (e as Error).message };
      }
    } else d = decideWithoutJev(row, kw, ctx.area, S);
  }
  if (d.result === 'Clean' && row[SITE_OWNER])
    d = { result: 'Review', reason: `Its website is also used by ${row[SITE_OWNER]}: this listing may be that company's page. ` + d.reason };
  if (d.result !== 'Rejected') fields.clean_services = servicesFor(row, site.text, S).join(', ');
  const supplies = typeof fields.clean_supplies === 'string' ? Number(fields.clean_supplies.replace('%', '')) / 100 : null;
  const priority = d.result === 'Review' ? reviewPriority(d.reason, supplies, distance, kw.strong) : undefined;
  if (priority !== undefined) fields.clean_priority = priority;
  return { outcome: TO_OUTCOME[d.result], reason: d.reason, fields, priority };
}

// ---------- rule suggestions ----------

export function categoryJevRequest(stat: { category: string; examples: string[] }, S: DirectoryRules): ClassifierRequest {
  return {
    model: 'jev-latest',
    state: { directory_lists: S.niche, google_category: stat.category, example_business_names: stat.examples },
    questions: {
      relation: {
        type: 'choice',
        instructions: 'A directory lists businesses that offer `directory_lists`. How do businesses in the Google Maps category `google_category` relate to it? Example names are given for context.',
        criteria: {
          is_the_service: `Businesses in this category provide ${S.niche} as their main work.`,
          might_offer: `Some businesses in this category also offer ${S.niche}, so each needs checking.`,
          different_trade: `A different kind of business that would not offer ${S.niche}, even if its name sounds similar.`,
          non_commercial: 'A public, charitable, religious, residential or government place rather than a business.'
        }
      }
    }
  };
}

async function suggestRules(rows: Row[], S: DirectoryRules, classifier: Classifier, onProgress?: (done: number, total: number) => void) {
  const stats = categoryStats(rows, S).filter(st => !categoryAlreadyRuled(st, S));
  const verdicts: CategoryVerdict[] = [], queue = [...stats];
  let done = 0;
  const worker = async () => {
    while (queue.length) {
      const stat = queue.shift()!;
      try { const r = await classifier.ask(categoryJevRequest(stat, S)); verdicts.push({ stat, probabilities: r.answers.relation?.probabilities }); }
      catch (e) { if ((e as { code?: string }).code === 'auth') throw e; }
      onProgress?.(++done, stats.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const { S: next, added } = applyCategoryVerdicts(S, verdicts);
  const conflicts = nameConflicts(rows, next, [...added.remove, ...added.hard]).filter(n => !next.excludeName.includes(n));
  next.excludeName = [...next.excludeName, ...conflicts];
  const list = (label: string, items: string[]) => items.length ? `${label}: ${items.join(', ')}\n` : '';
  const summary = list('Proves a match', added.core) + list('Worth reviewing', added.review) + list('Remove for free', added.remove)
    + list('Remove even with a matching name', added.hard) + list('Names to remove', conflicts.map(n => n.replace(/\\b/g, '')))
    || `No changes: ${stats.length} categories checked and none were clear-cut.`;
  return { rules: next, summary: summary.trim() };
}

export const directoryTemplate: Template<DirectoryRules> = {
  id: 'directory',
  label: 'Directory builder',
  description: 'Keep only businesses that really offer your directory’s service in your target area.',
  outcomeLabels: { keep: 'Clean', review: 'Review', remove: 'Rejected' },
  columns: [
    { key: 'clean_priority', header: 'Review Priority', width: 10, number: true },
    { key: 'clean_miles', header: 'Miles From Area', width: 10, number: true },
    { key: 'clean_score', header: 'Keyword Score', width: 12, number: true },
    { key: 'clean_supplies', header: 'Jev: Supplies', width: 12 },
    { key: 'clean_role', header: 'Business Role', width: 16 },
    { key: 'clean_serves', header: 'Serves Area', width: 12 },
    { key: 'clean_services', header: 'Services', width: 44 },
    { key: 'clean_site_check', header: 'Website Check', width: 32 },
    { key: 'clean_jev_asks', header: 'Jev Asks', width: 9, number: true }
  ],
  defaultRules: ({ name, terms, rows }) => buildProfile(name, terms, rows),
  parseRules: parseDirectoryRules,
  prefilter: (rows, rules) => prefilter(rows, rules),
  check,
  suggestRules
};
