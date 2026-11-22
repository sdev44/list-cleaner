// Runs a template over a list: free stage for everything, then checks with limited concurrency.
import type { Template } from './template.js';
import { readSite, fetchHtml, type FetchHtml } from './site.js';
import type { Classifier, Decision, Row } from './types.js';

export interface RowResult extends Decision {
  stage: 'free' | 'checked' | 'error';
}

export interface RunOptions<R> {
  rows: Row[];
  template: Template<R>;
  rules: R;
  area: string;
  classifier?: Classifier;
  fetcher?: FetchHtml;
  concurrency?: number;
  /** Results from an earlier, interrupted run (same row order). Finished rows are skipped. */
  previous?: (RowResult | null)[];
  /** Only check this many businesses after the free stage (for test runs). */
  limit?: number;
  signal?: AbortSignal;
  onResult?: (index: number, result: RowResult, progress: { done: number; total: number }) => void;
}

export interface RunSummary {
  results: (RowResult | null)[];
  counts: Record<string, number>;
  stoppedEarly: boolean;
  error?: Error;
}

export async function runJob<R>(opts: RunOptions<R>): Promise<RunSummary> {
  const { rows, template, rules, area } = opts;
  const results: (RowResult | null)[] = rows.map((_, i) => opts.previous?.[i] ?? null);
  const fetcher = opts.fetcher || fetchHtml;

  // Free stage. Re-run every time (cheap), but never overwrite a finished check.
  const reasons = template.prefilter(rows, rules, area);
  reasons.forEach((reason, i) => {
    if (reason && !results[i]) results[i] = { outcome: 'remove', reason: 'Free filter: ' + reason, stage: 'free', fields: { clean_site_check: 'Not checked' } };
  });

  let queue = rows.map((_, i) => i).filter(i => !results[i]);
  if (opts.limit !== undefined) queue = queue.slice(0, opts.limit);
  const total = queue.length;
  let done = 0, fatal: Error | undefined;

  const ctx = {
    rules, area, classifier: opts.classifier,
    readSite: (row: Row, pick: Parameters<typeof readSite>[1]) => readSite(row, pick, fetcher)
  };

  const worker = async () => {
    while (queue.length && !fatal && !opts.signal?.aborted) {
      const i = queue.shift()!;
      let result: RowResult;
      try {
        result = { ...(await template.check(rows[i], ctx)), stage: 'checked' };
      } catch (e) {
        const err = e as Error & { code?: string };
        if (err.code === 'auth') { fatal = err; queue.unshift(i); break; }
        result = { outcome: 'review', reason: 'Check failed: ' + err.message, stage: 'error' };
      }
      results[i] = result;
      done++;
      opts.onResult?.(i, result, { done, total });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 6) }, worker));

  const counts: Record<string, number> = { keep: 0, review: 0, remove: 0, unchecked: 0 };
  for (const r of results) counts[r ? r.outcome : 'unchecked']++;
  return { results, counts, stoppedEarly: !!fatal || !!opts.signal?.aborted || results.some(r => !r), error: fatal };
}
