// A template turns the generic engine into a product for one use case:
// which questions to ask, which free checks to run, how to decide, and which columns come out.
import type { Classifier, Decision, Outcome, Row, SiteRead } from './types.js';
import type { InnerPagePicker } from './site.js';

export interface OutputColumn { key: string; header: string; width: number; link?: boolean; number?: boolean }

export interface CheckContext<R> {
  rules: R;
  /** Target area code (e.g. "KS", "UK", "ENG"), or '' for none. */
  area: string;
  readSite(row: Row, pickInner: InnerPagePicker): Promise<SiteRead>;
  /** Undefined when no API key is set: templates must still decide (usually "review"). */
  classifier?: Classifier;
}

export interface RuleSuggestion<R> { rules: R; summary: string }

export interface Template<R = unknown> {
  id: string;
  label: string;
  description: string;
  /** What each outcome is called in this template's output. */
  outcomeLabels: Record<Outcome, string>;
  /** Extra output columns, after the business's own columns. */
  columns: OutputColumn[];
  /** Starter rules from a directory name, its search terms and the rows themselves. */
  defaultRules(input: { name: string; terms: string[]; rows: Row[] }): R;
  /** Validates a rules object (e.g. loaded from JSON) and fills missing values. Throws on bad patterns. */
  parseRules(input: unknown): R;
  /** Free stage over the whole list (duplicates need every row). '' = passes. */
  prefilter(rows: Row[], rules: R, area: string): string[];
  /** Paid/slow stage for one business. */
  check(row: Row, ctx: CheckContext<R>): Promise<Decision>;
  /** Optional: improve rules by asking the classifier about the batch's categories. */
  suggestRules?(rows: Row[], rules: R, classifier: Classifier, onProgress?: (done: number, total: number) => void): Promise<RuleSuggestion<R>>;
}

export const outcomeFromLabel = (t: Template, label: string): Outcome | '' =>
  (Object.entries(t.outcomeLabels).find(([, l]) => l.toLowerCase() === String(label || '').trim().toLowerCase())?.[0] as Outcome) || '';
