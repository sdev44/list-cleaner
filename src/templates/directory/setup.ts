// Setup questions: the directory's policy, asked in plain English with examples from the customer's own
// list, instead of hand-edited rules. Answers are applied to the starter rules (never accumulated),
// so changing an answer and re-sorting is always safe.
import { US_STATES } from '../../core/area.js';
import type { Row } from '../../core/types.js';
import { compile, type DirectoryRules } from './rules.js';

export interface SetupOption { value: string; label: string; detail?: string; count?: number }
export interface SetupQuestion {
  id: 'side' | 'hardRemove' | 'names' | 'partial' | 'nearby' | 'duplicates';
  title: string;
  help?: string;
  type: 'single' | 'multi';
  options: SetupOption[];
  /** Suggested answer. */
  value: string | string[];
}
export type SetupAnswers = Partial<Record<SetupQuestion['id'], string | string[]>>;

/** Words the starter rules always exclude by name; not worth asking about. */
const DEFAULT_NAME_WORDS = new Set(['\\bpark\\s*[-–]', 'church', '\\bschool\\b', 'library', 'food ?bank']);
const plainWord = (pattern: string) => pattern.replace(/\\b/g, '').replace(/\\/g, '');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function inCategory(rows: Row[], key: string): Row[] {
  const k = key.toLowerCase();
  return rows.filter(r => String(r.category || '').toLowerCase().includes(k));
}
function examples(list: Row[], n = 3): string {
  const names = [...new Set(list.map(r => String(r.name || '')).filter(Boolean))].slice(0, n);
  return names.length ? 'e.g. ' + names.join(', ') : '';
}

/**
 * Questions for this list and these rules (the rules as they are after `suggest-rules`).
 * Categories and words are only asked about when the list actually contains them.
 */
export function buildQuestions(rows: Row[], rules: DirectoryRules, area: string): SetupQuestion[] {
  const C = compile(rules);
  const niche = rules.niche;
  const qs: SetupQuestion[] = [];

  // 1. Side services: categories that might offer the service (not ones that prove a match).
  const side = rules.plausibleCategories
    .filter(c => !C.core.some(k => c.includes(k)))
    .map(c => ({ key: c, rows: inCategory(rows, c) }))
    .filter(x => x.rows.length)
    .sort((a, b) => b.rows.length - a.rows.length)
    .slice(0, 12);
  if (side.length) {
    const listed = rules.sideServices === 'keep' ? side.map(x => x.key) : side.filter(x => rules.sideServiceCategories.some(c => x.key.includes(c.toLowerCase()))).map(x => x.key);
    qs.push({
      id: 'side', type: 'multi',
      title: `Some businesses' main trade is something else, but they also offer ${niche}. Which kinds should go in your directory?`,
      help: 'Ticked kinds are listed when they really offer it. Unticked kinds go to Review for you to decide one by one.',
      options: side.map(x => ({ value: x.key, label: cap(x.key), count: x.rows.length, detail: examples(x.rows) })),
      value: listed
    });
  }

  // 2. Other trades with look-alike names (e.g. barbers called "Male Grooming").
  const hard = rules.hardExcludeCategory
    .map(c => ({ key: c, rows: inCategory(rows, c).filter(r => C.strong.test(r.name || '')) }))
    .filter(x => x.rows.length);
  if (hard.length) qs.push({
    id: 'hardRemove', type: 'multi',
    title: 'These are a different trade, but some have names that look like yours. Remove them?',
    help: 'Ticked kinds are removed for free, whatever their name says. Unticked kinds are checked like everyone else.',
    options: hard.map(x => ({ value: x.key, label: cap(x.key), count: x.rows.length, detail: examples(x.rows) })),
    value: hard.map(x => x.key)
  });

  // 3. Name words suggested for removal (found only in other trades' names).
  const words = rules.excludeName.filter(w => !DEFAULT_NAME_WORDS.has(w))
    .map(w => { let re: RegExp | null = null; try { re = new RegExp(w, 'i'); } catch { /* skip */ } return { w, rows: re ? rows.filter(r => re!.test(r.name || '')) : [] }; })
    .filter(x => x.rows.length);
  if (words.length) qs.push({
    id: 'names', type: 'multi',
    title: 'Remove businesses whose names contain these words?',
    help: 'These words only appear in other trades’ names in your list. A business in a category that proves a match is never removed by name.',
    options: words.map(x => ({ value: x.w, label: `"${plainWord(x.w)}"`, count: x.rows.length, detail: examples(x.rows) })),
    value: words.map(x => x.w)
  });

  // 4. Businesses based outside the area that say they reach it.
  if (area) qs.push({
    id: 'partial', type: 'single',
    title: 'A business based outside your area says it reaches it (a travel radius, delivery or a region). Where should it go?',
    options: [
      { value: 'review', label: 'Review', detail: 'You decide each one. The reason quotes what its site says.' },
      { value: 'keep', label: 'List it', detail: 'Anyone who says they come to or deliver to your area is listed.' },
      { value: 'remove', label: 'Leave it out', detail: 'Only businesses based in the area, or clearly serving all of it.' }
    ],
    value: rules.partialArea
  });

  // 5. Border distance (US ZIP distances only).
  if (area && US_STATES[area]) qs.push({
    id: 'nearby', type: 'single',
    title: 'A supplier based just outside your area gives no sign of serving it. Within what distance should it still go to Review?',
    options: [{ value: '0', label: 'Never' }, { value: '25', label: '25 miles' }, { value: '50', label: '50 miles' }, { value: '100', label: '100 miles' }],
    value: String(rules.nearbyMiles)
  });

  // 6. Duplicates.
  qs.push({
    id: 'duplicates', type: 'single',
    title: 'Two listings share a phone number and a website but have different names. Treat them as one business?',
    help: 'The better listing is kept. Branches with their own phone numbers are always kept separately.',
    options: [{ value: 'yes', label: 'Yes, keep the better one' }, { value: 'no', label: 'No, keep both' }],
    value: rules.strictDuplicates ? 'yes' : 'no'
  });
  return qs;
}

/**
 * Applies answers to the rules the questions were built from (same rows and area). Only options that
 * were actually asked can be switched off; unanswered questions keep the rule as is.
 */
export function applyAnswers(base: DirectoryRules, answers: SetupAnswers, rows: Row[], area: string): DirectoryRules {
  const next: DirectoryRules = { ...base, plausibleCategories: [...base.plausibleCategories], hardExcludeCategory: [...base.hardExcludeCategory], excludeName: [...base.excludeName] };
  const asked = new Map(buildQuestions(rows, base, area).map(q => [q.id, q.options.map(o => o.value)]));
  const list = (v: unknown) => Array.isArray(v) ? v.map(String) : [];

  if (answers.side !== undefined && asked.has('side')) {
    const options = asked.get('side')!, ticked = list(answers.side).filter(v => options.includes(v));
    const all = options.every(k => ticked.includes(k));
    next.sideServices = all ? 'keep' : 'review';
    next.sideServiceCategories = all ? [] : ticked;
  }
  if (answers.hardRemove !== undefined && asked.has('hardRemove')) {
    const ticked = new Set(list(answers.hardRemove));
    const untick = asked.get('hardRemove')!.filter(c => !ticked.has(c));
    // Unticked: checked like everyone else (moved to the "might offer it" list).
    next.hardExcludeCategory = base.hardExcludeCategory.filter(c => !untick.includes(c));
    for (const c of untick) if (!next.plausibleCategories.includes(c)) next.plausibleCategories.push(c);
  }
  if (answers.names !== undefined && asked.has('names')) {
    const ticked = new Set(list(answers.names));
    const untick = new Set(asked.get('names')!.filter(w => !ticked.has(w)));
    next.excludeName = base.excludeName.filter(w => !untick.has(w));
  }
  if (typeof answers.partial === 'string' && ['keep', 'review', 'remove'].includes(answers.partial)) next.partialArea = answers.partial as DirectoryRules['partialArea'];
  if (typeof answers.nearby === 'string' && /^\d+$/.test(answers.nearby)) next.nearbyMiles = Number(answers.nearby);
  if (typeof answers.duplicates === 'string') next.strictDuplicates = answers.duplicates !== 'no';
  return next;
}
