// Directory builder: "does this business really belong in my directory, in my area?"
// Logic ported from the extension's cleaner (v2.5.5); behaviour kept identical except `protectPlausible`.
import { inArea, regionName, rowArea, sameArea, searchedInArea } from '../../core/area.js';
import { sameSiteUrl, siteHost } from '../../core/site.js';
import type { CheckContext, Template } from '../../core/template.js';
import type { Answer, Classifier, ClassifierRequest, Decision, Page, Row, SiteRead } from '../../core/types.js';
import {
  applyCategoryVerdicts, buildProfile, categoryAlreadyRuled, categoryStats, compile, looksLikeStorm, nameConflicts, parseDirectoryRules,
  type CategoryVerdict, type DirectoryRules
} from './rules.js';

const simpleName = (n: unknown) => String(n || '').toLowerCase().replace(/\b(llc|inc|co|ltd|the|of)\b/g, '').replace(/[^a-z0-9]/g, '');
const pct = (n: number) => Math.round(n * 100) + '%';

// ---------- stage 1: free filter ----------

export function prefilter(rows: Row[], S: DirectoryRules): string[] {
  const C = compile(S), seen = new Set<string>();
  return rows.map(row => {
    const name = String(row.name || '').trim();
    const cat = String(row.category || '').toLowerCase() + ' ';
    const phone = String(row.phone || '').replace(/\D/g, '');
    const host = siteHost(row.website);
    const ids = [row.place_id, row.place_key, phone && name.toLowerCase() + '|' + phone, host && 'site:' + host + '|' + simpleName(name)].filter(Boolean).map(String);
    const protectedCat = S.protectPlausible && C.plausible.some(c => cat.includes(c));
    let reason = '';
    if (!name) reason = 'No business name';
    else if (ids.some(id => seen.has(id))) reason = 'Duplicate';
    else if (/permanently closed/i.test(row.business_status || '')) reason = 'Permanently closed';
    else if (C.hardCats.some(c => cat.includes(c))) reason = 'Unrelated category: ' + row.category;
    else if (!C.strong.test(name) && !protectedCat && C.badCats.find(c => cat.includes(c))) reason = 'Unrelated category: ' + row.category;
    else if (C.badName && C.badName.test(name) && !C.core.some(c => cat.includes(c))) reason = 'Name shows a non-commercial or different kind of business';
    ids.forEach(id => seen.add(id));
    return reason;
  });
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

/** First sentence saying the business reaches beyond its base: a mileage radius, delivery, shipping, nationwide. */
export function reachHint(text: string): string {
  const re = /[^.!?|]{0,140}\b(\d{2,4}[- ]?miles?|mile radius|radius|nationwide|all 50 states|across the (us|u\.s\.|country|midwest)|surrounding states|we (deliver|ship)|(free |nationwide )?(delivery|shipping) (to|across|available|nationwide)|drop[- ]?ship\w*)\b[^.!?|]{0,140}/i;
  const m = String(text || '').match(re);
  return m ? m[0].replace(/\s+/g, ' ').trim().slice(0, 220) : '';
}

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

export function decideWithJev(row: Row, answers: Record<string, Answer>, area: string, kw: KeywordResult, S: DirectoryRules, siteText = ''): { result: 'Clean' | 'Review' | 'Rejected'; reason: string } {
  const supplies = answers.supplies?.noul ?? 0.5;
  const pub = answers.public_place?.noul ?? 0;
  const serves = answers.serves_state?.choice || 'unclear';
  const servesNo = answers.serves_state?.probabilities?.no ?? 0;
  const noAddressState = !rowArea(row) && searchedInArea(row, area);
  const inState = sameArea(rowArea(row), area) || (noAddressState && serves !== 'no' && serves !== 'partly');
  const where = regionName(area);
  const partial = (why: string) => {
    const result = S.partialArea === 'keep' ? 'Clean' : S.partialArea === 'remove' ? 'Rejected' : 'Review';
    return { result, reason: `Offers ${S.niche} (${pct(supplies)}); based outside ${where} but may reach it` + (why ? `: "${why}"` : '') } as const;
  };
  if (pub >= S.publicReject && !kw.strong) return { result: 'Rejected', reason: `Public/community place, not a supplier (${pct(pub)})` };
  if (supplies <= S.jevLow) return { result: 'Rejected', reason: `Jev: does not offer ${S.niche} (${pct(supplies)})` };
  if (supplies >= S.jevHigh) {
    if (inState || serves === 'yes') return {
      result: 'Clean', reason: `Jev: offers ${S.niche} (${pct(supplies)})` + (sameArea(rowArea(row), area) ? '' : noAddressState && serves !== 'yes' ? '; no address, found in ' + where + ' searches' : '; serves ' + where)
    };
    if (serves === 'partly') return partial(reachHint(siteText));
    if (serves === 'no' && servesNo >= 0.6) {
      // A stated radius, delivery or shipping can reach the area even when Jev says no: never reject on that.
      const hint = reachHint(siteText);
      return hint ? partial(hint) : { result: 'Rejected', reason: `Based outside the area with no sign of serving ${where}` };
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

async function check(row: Row, ctx: CheckContext<DirectoryRules>): Promise<Decision> {
  const S = ctx.rules;
  const site = await ctx.readSite(row, page => [bestLink(page, S), areaLink(page)]);
  const kw = keywordScore(row, site.text, S);
  const fields: Record<string, string | number> = { clean_score: kw.score, clean_site_check: site.status };
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
        d = decideWithJev(row, r.answers, ctx.area, kw, S, site.text);
        fields.clean_supplies = pct(r.answers.supplies?.noul ?? 0);
        fields.clean_role = (r.answers.role?.choice || '').replace(/_/g, ' ');
        fields.clean_serves = r.answers.serves_state?.choice || '';
      } catch (e) {
        if ((e as { code?: string }).code === 'auth') throw e;
        d = { result: 'Review', reason: 'Jev check failed: ' + (e as Error).message };
      }
    } else d = decideWithoutJev(row, kw, ctx.area, S);
  }
  if (d.result !== 'Rejected') fields.clean_services = servicesFor(row, site.text, S).join(', ');
  return { outcome: TO_OUTCOME[d.result], reason: d.reason, fields };
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
