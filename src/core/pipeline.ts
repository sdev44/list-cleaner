// Runs a template over a list: free stage for everything, then checks with limited concurrency.
// Every check records its evidence (what the website said, what Jev answered) so the same list
// can later be re-decided under new rules in seconds, without reading sites or asking Jev again.
import type { Template } from './template.js';
import { readSite, fetchHtml, type BrowserRead, type FetchHtml } from './site.js';
import type { Classifier, ClassifierRequest, ClassifierResponse, Decision, Row, SiteRead } from './types.js';

export interface RowResult extends Decision {
  stage: 'free' | 'checked' | 'error';
}

/** What one check saw: the website read and each classifier answer, in order. */
export interface Evidence {
  site?: SiteRead;
  asks: { questions: string[]; response: ClassifierResponse }[];
}

export interface RunOptions<R> {
  rows: Row[];
  template: Template<R>;
  rules: R;
  area: string;
  classifier?: Classifier;
  fetcher?: FetchHtml;
  /** Headless browser fallback for sites plain requests can't read. */
  browser?: BrowserRead;
  concurrency?: number;
  /** Results from an earlier, interrupted run (same row order). Finished rows are skipped. */
  previous?: (RowResult | null)[];
  /**
   * Re-decide from saved evidence instead of reading sites and asking Jev. Rows without evidence are
   * checked live only if `replayLive` is set (else left unchecked). When the rules need a Jev answer the
   * evidence lacks, `classifier` is asked if given; otherwise the row goes to Review.
   */
  replay?: (Evidence | null)[];
  replayLive?: boolean;
  /** Longest one business may take before it goes to Review (default 4 minutes). */
  checkTimeoutMs?: number;
  /** Only check this many businesses after the free stage (for test runs). */
  limit?: number;
  signal?: AbortSignal;
  onResult?: (index: number, result: RowResult, progress: { done: number; total: number }, evidence: Evidence) => void;
}

export interface RunSummary {
  results: (RowResult | null)[];
  evidence: (Evidence | null)[];
  counts: Record<string, number>;
  /** Replay only: rows decided from evidence / rows that needed a Jev answer the evidence lacked. */
  replayed?: number;
  needsFresh?: number;
  stoppedEarly: boolean;
  error?: Error;
}

class NeedsFreshAnswer extends Error { code = 'needs-fresh' as const }

export async function runJob<R>(opts: RunOptions<R>): Promise<RunSummary> {
  const { rows, template, rules, area } = opts;
  const results: (RowResult | null)[] = rows.map((_, i) => opts.previous?.[i] ?? null);
  const evidence: (Evidence | null)[] = rows.map(() => null);
  const fetcher = opts.fetcher || fetchHtml;
  const replaying = !!opts.replay;

  // Free stage. Re-run every time (cheap), but never overwrite a finished check.
  const reasons = template.prefilter(rows, rules, area);
  reasons.forEach((reason, i) => {
    if (reason && !results[i]) results[i] = { outcome: 'remove', reason: 'Free filter: ' + reason, stage: 'free', fields: { clean_site_check: 'Not checked' } };
  });

  let queue = rows.map((_, i) => i).filter(i => !results[i]);
  if (replaying && !opts.replayLive) queue = queue.filter(i => opts.replay![i]);
  if (opts.limit !== undefined) queue = queue.slice(0, opts.limit);
  const total = queue.length;
  let done = 0, replayed = 0, needsFresh = 0, fatal: Error | undefined;

  /** Per-row context that records evidence, or replays it. */
  const contextFor = (i: number) => {
    const saved = replaying ? opts.replay![i] : null;
    const ev: Evidence = { asks: [] };
    let askIndex = 0;
    const live = opts.classifier;
    const recording: Classifier = {
      async ask(request: ClassifierRequest) {
        const questions = Object.keys(request.questions).sort();
        if (saved) {
          const prior = saved.asks[askIndex++];
          if (prior && prior.questions.join() === questions.join()) { ev.asks.push(prior); return prior.response; }
          if (!live) {
            // Asked again with the same questions (e.g. a second opinion the first run didn't need):
            // reuse the saved answer rather than leaving the business undecided.
            const same = [...saved.asks].reverse().find(a => a.questions.join() === questions.join());
            if (same && prior === undefined) return same.response;
            throw new NeedsFreshAnswer('needs a new Jev answer');
          }
        }
        const response = await live!.ask(request);
        ev.asks.push({ questions, response });
        return response;
      }
    };
    return {
      ev, saved,
      ctx: {
        rules, area,
        classifier: saved ? (saved.asks.length || live ? recording : undefined) : live ? recording : undefined,
        readSite: async (row: Row, pick: Parameters<typeof readSite>[1]) => {
          const site = saved?.site ?? await readSite(row, pick, fetcher, opts.browser);
          ev.site = site;
          return site;
        }
      }
    };
  };

  const worker = async () => {
    while (queue.length && !fatal && !opts.signal?.aborted) {
      const i = queue.shift()!;
      const { ctx, ev, saved } = contextFor(i);
      let result: RowResult;
      try {
        let timer: NodeJS.Timeout | undefined;
        const limit = opts.checkTimeoutMs ?? 240000;
        const decision = await Promise.race([
          template.check(rows[i], ctx),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`took longer than ${Math.round(limit / 1000)}s`)), limit); })
        ]).finally(() => clearTimeout(timer));
        result = { ...decision, stage: 'checked' };
        if (saved) replayed++;
      } catch (e) {
        const err = e as Error & { code?: string };
        if (err.code === 'auth') { fatal = err; queue.unshift(i); break; }
        if (err.code === 'needs-fresh') {
          needsFresh++;
          result = { outcome: 'review', reason: 'Needs a fresh check: the new rules ask Jev something the saved answers don’t cover', stage: 'error', priority: 44 };
        } else result = { outcome: 'review', reason: 'Check failed: ' + err.message, stage: 'error' };
      }
      results[i] = result;
      evidence[i] = ev.site || ev.asks.length ? ev : null;
      done++;
      opts.onResult?.(i, result, { done, total }, ev);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? (replaying ? 16 : 6)) }, worker));

  const counts: Record<string, number> = { keep: 0, review: 0, remove: 0, unchecked: 0 };
  for (const r of results) counts[r ? r.outcome : 'unchecked']++;
  return {
    results, evidence, counts, stoppedEarly: !!fatal || !!opts.signal?.aborted || results.some(r => !r), error: fatal,
    ...(replaying ? { replayed, needsFresh } : {})
  };
}
