// One cleaning job = one uploaded list, its directory setup, results, saved evidence and the user's own
// decisions. Stored under <dataDir>/jobs/<id>/ so a job survives restarts. Single user for now.
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { guessArea, regionName, rowArea } from '../core/area.js';
import { tableToRows, type ColumnMapping } from '../core/columns.js';
import { writeResults } from '../core/export.js';
import { readTable } from '../core/io.js';
import { runJob, type Evidence, type RowResult } from '../core/pipeline.js';
import type { BrowserRead, FetchHtml } from '../core/site.js';
import type { Classifier, Outcome, Row } from '../core/types.js';
import { directoryTemplate } from '../templates/directory/index.js';
import { parseDirectoryRules, termsFromRows, type DirectoryRules } from '../templates/directory/rules.js';
import { applyAnswers, buildQuestions, type SetupAnswers } from '../templates/directory/setup.js';

export type JobStatus = 'new' | 'suggesting' | 'ready' | 'running' | 'stopping' | 'done' | 'stopped' | 'error';

export interface JobMeta {
  id: string;
  fileName: string;
  inputFile: string;
  createdAt: string;
  updatedAt: string;
  mapOverrides: Record<string, string>;
  area: string;
  directoryName: string;
  /** Starter rules plus Jev's category suggestions; answers are applied on top. */
  baseRules?: DirectoryRules;
  suggestSummary?: string;
  answers: SetupAnswers;
  /** Rules edited by hand in the Advanced tab; when set, they replace base + answers. */
  advancedRules?: DirectoryRules;
  status: JobStatus;
  message?: string;
  progress: { done: number; total: number };
  /** Manual decisions by row index. */
  overrides: Record<string, Outcome>;
  lastRunAt?: string;
  jevCalls: number;
}

export interface JobDeps {
  dataDir: string;
  /** Makes a classifier from the saved key; undefined = no key. */
  classifier: () => (Classifier & { calls?: number }) | undefined;
  fetcher?: FetchHtml;
  browser?: () => Promise<{ read: BrowserRead; close: () => Promise<void> } | null>;
}

const LABEL: Record<Outcome, string> = directoryTemplate.outcomeLabels;

export class JobStore {
  private cache = new Map<string, { rows: Row[]; mapping: ColumnMapping; headers: string[] }>();
  private results = new Map<string, (RowResult | null)[]>();
  private running = new Map<string, AbortController>();

  constructor(private deps: JobDeps) {}

  private dir(id: string) { return join(this.deps.dataDir, 'jobs', id); }
  private async save(job: JobMeta) { job.updatedAt = new Date().toISOString(); await writeFile(join(this.dir(job.id), 'job.json'), JSON.stringify(job, null, 1)); }
  /** Saves through the same queue as patch, so writes never interleave. */
  private writing = Promise.resolve();
  private persist(job: JobMeta) { this.writing = this.writing.catch(() => {}).then(() => this.save(job)); return this.writing; }
  /** Updates only the given fields, so a run never overwrites the user's edits made meanwhile. */
  private patch(id: string, fields: Partial<JobMeta>) {
    this.writing = this.writing.catch(() => {}).then(async () => {
      const p = join(this.dir(id), 'job.json');
      if (!existsSync(p)) return;
      const job = JSON.parse(await readFile(p, 'utf8')) as JobMeta;
      Object.assign(job, fields);
      await this.save(job);
    });
    return this.writing;
  }

  async currentId(): Promise<string | null> {
    const p = join(this.deps.dataDir, 'current.txt');
    return existsSync(p) ? ((await readFile(p, 'utf8')).trim() || null) : null;
  }
  async current(): Promise<JobMeta | null> {
    const id = await this.currentId();
    if (!id || !existsSync(join(this.dir(id), 'job.json'))) return null;
    const job = JSON.parse(await readFile(join(this.dir(id), 'job.json'), 'utf8')) as JobMeta;
    // A run cut short by a restart is resumable, not still running.
    if ((job.status === 'running' || job.status === 'stopping' || job.status === 'suggesting') && !this.running.has(id)) { job.status = job.lastRunAt ? 'stopped' : 'ready'; }
    return job;
  }
  async require(): Promise<JobMeta> {
    const job = await this.current();
    if (!job) throw Object.assign(new Error('Upload a list first.'), { status: 400 });
    return job;
  }

  // ---------- list ----------

  async create(fileName: string, data: Buffer): Promise<JobMeta> {
    const safe = fileName.replace(/[^\w.\- ]+/g, '_').slice(-120) || 'list.xlsx';
    if (!/\.(xlsx|csv|tsv|json)$/i.test(safe)) throw Object.assign(new Error('Upload an .xlsx, .csv, .tsv or .json file.'), { status: 400 });
    const id = new Date().toISOString().slice(0, 10) + '-' + randomUUID().slice(0, 8);
    await mkdir(this.dir(id), { recursive: true });
    const inputFile = 'input' + safe.slice(safe.lastIndexOf('.')).toLowerCase();
    await writeFile(join(this.dir(id), inputFile), data);
    const now = new Date().toISOString();
    const job: JobMeta = { id, fileName: safe, inputFile, createdAt: now, updatedAt: now, mapOverrides: {}, area: '', directoryName: '', answers: {}, status: 'new', progress: { done: 0, total: 0 }, overrides: {}, jevCalls: 0 };
    try {
      const { rows, mapping } = await this.rows(job);
      if (!mapping.byKey.name) throw new Error('Could not find a business name column. Pick it below.');
      job.area = guessArea(rows);
      job.directoryName = suggestName(termsFromRows(rows));
    } catch (e) {
      job.message = (e as Error).message;
    }
    await this.persist(job);
    await writeFile(join(this.deps.dataDir, 'current.txt'), id);
    return job;
  }

  async rows(job: JobMeta) {
    const key = job.id + JSON.stringify(job.mapOverrides);
    if (!this.cache.has(key)) {
      const table = await readTable(join(this.dir(job.id), job.inputFile));
      this.cache.set(key, tableToRows(table, job.mapOverrides));
    }
    return this.cache.get(key)!;
  }

  async startNew(): Promise<void> {
    const id = await this.currentId();
    if (id) this.running.get(id)?.abort();
    await rm(join(this.deps.dataDir, 'current.txt'), { force: true });
  }

  /** Deletes a job's files entirely. */
  async remove(id: string) { await rm(this.dir(id), { recursive: true, force: true }); this.results.delete(id); }

  async setMapping(overrides: Record<string, string>): Promise<JobMeta> {
    const job = await this.require();
    this.assertIdle(job);
    job.mapOverrides = Object.fromEntries(Object.entries(overrides).filter(([, h]) => h));
    const { rows, mapping } = await this.rows(job);
    job.message = mapping.byKey.name ? undefined : 'Could not find a business name column. Pick it below.';
    if (!job.area) job.area = guessArea(rows);
    await this.persist(job);
    return job;
  }

  // ---------- setup ----------

  async setup(directoryName: string, area: string): Promise<JobMeta> {
    const job = await this.require();
    this.assertIdle(job);
    const { rows } = await this.rows(job);
    const terms = termsFromRows(rows);
    if (!directoryName.trim() && !terms.length) throw Object.assign(new Error('Say what the directory lists, e.g. "Dog grooming".'), { status: 400 });
    job.directoryName = directoryName.trim();
    job.area = area;
    job.baseRules = directoryTemplate.defaultRules({ name: job.directoryName, terms, rows });
    job.answers = {};
    job.advancedRules = undefined;
    job.suggestSummary = undefined;
    job.status = 'ready';
    await this.persist(job);
    return job;
  }

  /** Asks Jev about the list's Google categories; the setup questions are then built from the result. */
  async suggest(onProgress?: (done: number, total: number) => void): Promise<JobMeta> {
    const job = await this.require();
    this.assertIdle(job);
    if (!job.baseRules) throw Object.assign(new Error('Describe the directory first.'), { status: 400 });
    const classifier = this.deps.classifier();
    if (!classifier) throw Object.assign(new Error('Add your Jev key in Settings to get suggestions.'), { status: 400 });
    const { rows } = await this.rows(job);
    job.status = 'suggesting'; await this.persist(job);
    try {
      const s = await directoryTemplate.suggestRules!(rows, job.baseRules, classifier, onProgress);
      job.baseRules = s.rules;
      job.suggestSummary = s.summary;
      job.answers = {};
      job.status = 'ready';
      job.message = undefined;
    } catch (e) {
      job.status = 'ready';
      job.message = 'Suggestions stopped: ' + (e as Error).message;
    }
    await this.persist(job);
    return job;
  }

  async rules(job: JobMeta): Promise<DirectoryRules | null> {
    if (job.advancedRules) return job.advancedRules;
    if (!job.baseRules) return null;
    const { rows } = await this.rows(job);
    return applyAnswers(job.baseRules, job.answers, rows, job.area);
  }

  async questions(job: JobMeta) {
    if (!job.baseRules) return [];
    const { rows } = await this.rows(job);
    const qs = buildQuestions(rows, job.baseRules, job.area);
    // Show the current answers in place of the suggestions.
    return qs.map(q => ({ ...q, value: job.answers[q.id] ?? q.value }));
  }

  async setAnswers(answers: SetupAnswers): Promise<JobMeta> {
    const job = await this.require();
    this.assertIdle(job);
    job.answers = { ...job.answers, ...answers };
    job.advancedRules = undefined;
    await this.persist(job);
    await this.redecideIfPossible(job);
    return job;
  }

  async setAdvanced(rules: unknown | null): Promise<JobMeta> {
    const job = await this.require();
    this.assertIdle(job);
    job.advancedRules = rules ? parseDirectoryRules(rules) : undefined;
    await this.persist(job);
    await this.redecideIfPossible(job);
    return job;
  }

  // ---------- run ----------

  private assertIdle(job: JobMeta) {
    if (this.running.has(job.id)) throw Object.assign(new Error('Wait for the current run to stop.'), { status: 409 });
  }

  /** Checks every business not yet decided (all of them on a first run). Returns at once; poll the job. */
  async run(): Promise<JobMeta> {
    const job = await this.require();
    this.assertIdle(job);
    const rules = await this.rules(job);
    if (!rules) throw Object.assign(new Error('Describe the directory first.'), { status: 400 });
    const { rows } = await this.rows(job);
    const previous = await this.loadResults(job);
    const controller = new AbortController();
    this.running.set(job.id, controller);
    job.status = 'running'; job.message = undefined; job.lastRunAt = new Date().toISOString();
    job.progress = { done: 0, total: previous.filter(r => !r).length };
    await this.persist(job);

    const classifier = this.deps.classifier();
    const evidencePath = join(this.dir(job.id), 'evidence.jsonl');
    const end: Partial<JobMeta> = { message: undefined };
    void (async () => {
      const browser = this.deps.browser ? await this.deps.browser().catch(() => null) : null;
      let lastSave = Date.now();
      try {
        const summary = await runJob({
          rows, template: directoryTemplate, rules, area: job.area, classifier, fetcher: this.deps.fetcher,
          browser: browser?.read, previous, signal: controller.signal,
          onResult: (i, r, p, ev) => {
            previous[i] = r;
            job.progress = p;
            if (ev.site || ev.asks.length) void appendFile(evidencePath, JSON.stringify({ i, ev }) + '\n');
            if (Date.now() - lastSave > 3000) { lastSave = Date.now(); void this.saveResults(job, previous); void this.patch(job.id, { progress: p }); }
          }
        });
        summary.results.forEach((r, i) => { previous[i] = r; });
        end.status = summary.error || controller.signal.aborted || summary.results.some(r => !r) ? 'stopped' : 'done';
        if (summary.error) end.message = summary.error.message;
      } catch (e) {
        end.status = 'error'; end.message = (e as Error).message;
      } finally {
        await browser?.close().catch(() => {});
        await this.saveResults(job, previous);
        await this.patch(job.id, { ...end, progress: job.progress, jevCalls: job.jevCalls + (classifier?.calls ?? 0) });
        this.running.delete(job.id);
      }
    })();
    return job;
  }

  async stop(): Promise<JobMeta> {
    const job = await this.require();
    const c = this.running.get(job.id);
    if (c) { c.abort(); await this.patch(job.id, { status: 'stopping' }); job.status = 'stopping'; }
    return job;
  }

  isRunning(id: string) { return this.running.has(id); }

  /** Re-applies the current rules to saved evidence, in seconds. Businesses without evidence stay unchecked. */
  private async redecideIfPossible(job: JobMeta) {
    const evidence = await this.loadEvidence(job);
    if (!evidence.some(Boolean)) return;
    const rules = await this.rules(job);
    if (!rules) return;
    const { rows } = await this.rows(job);
    const summary = await runJob({ rows, template: directoryTemplate, rules, area: job.area, replay: evidence });
    // A business needing an answer the evidence lacks keeps its earlier result rather than a placeholder.
    const before = await this.loadResults(job);
    const results = summary.results.map((r, i) => r?.reason.startsWith('Needs a fresh check') && before[i] ? before[i] : r);
    await this.saveResults(job, results);
    job.message = summary.needsFresh ? `${summary.needsFresh} businesses need a fresh check for the new rules: click Check the rest.` : undefined;
    await this.persist(job);
  }

  // ---------- results ----------

  private async loadEvidence(job: JobMeta): Promise<(Evidence | null)[]> {
    const { rows } = await this.rows(job);
    const out: (Evidence | null)[] = rows.map(() => null);
    const p = join(this.dir(job.id), 'evidence.jsonl');
    if (!existsSync(p)) return out;
    for (const line of (await readFile(p, 'utf8')).split('\n')) {
      if (!line) continue;
      try { const { i, ev } = JSON.parse(line); if (typeof i === 'number' && i < out.length) out[i] = ev; } catch { /* partial line */ }
    }
    return out;
  }

  async loadResults(job: JobMeta): Promise<(RowResult | null)[]> {
    if (this.results.has(job.id)) return [...this.results.get(job.id)!];
    const { rows } = await this.rows(job);
    const p = join(this.dir(job.id), 'results.json');
    const saved: (RowResult | null)[] = existsSync(p) ? JSON.parse(await readFile(p, 'utf8')) : [];
    const out = rows.map((_, i) => saved[i] ?? null);
    this.results.set(job.id, out);
    return [...out];
  }
  private async saveResults(job: JobMeta, results: (RowResult | null)[]) {
    this.results.set(job.id, [...results]);
    await writeFile(join(this.dir(job.id), 'results.json'), JSON.stringify(results));
  }

  /** Results with the user's own decisions applied. */
  async finalResults(job: JobMeta): Promise<(RowResult | null)[]> {
    const results = await this.loadResults(job);
    return results.map((r, i) => {
      const o = job.overrides[i];
      if (!o) return r;
      const was = r ? `${LABEL[r.outcome]}: ${r.reason}` : 'not checked';
      return { outcome: o, reason: `Set by you (was ${was})`, stage: r?.stage ?? 'checked', fields: r?.fields, priority: o === 'review' ? r?.priority : undefined };
    });
  }

  async counts(job: JobMeta) {
    const results = await this.finalResults(job);
    const c: Record<string, number> = { keep: 0, review: 0, remove: 0, unchecked: 0, overridden: Object.keys(job.overrides).length };
    for (const r of results) c[r ? r.outcome : 'unchecked']++;
    return c;
  }

  async listRows(filter: string, q: string, offset: number, limit: number) {
    const job = await this.require();
    const { rows } = await this.rows(job);
    const results = await this.finalResults(job);
    const matches = this.matching(rows, results, filter, q);
    // Review: highest priority first.
    if (filter === 'review') matches.sort((a, b) => (results[b]?.priority ?? 0) - (results[a]?.priority ?? 0) || a - b);
    return {
      total: matches.length,
      rows: matches.slice(offset, offset + limit).map(i => {
        const r = results[i], row = rows[i];
        return {
          i, name: row.name || '', category: row.category || '', address: row.address || '', phone: row.phone || '', website: row.website || '', mapsUrl: row.maps_url || '',
          area: regionName(rowArea(row)), result: r ? r.outcome : 'unchecked', reason: r?.reason || '', priority: r?.priority ?? null,
          miles: r?.fields?.clean_miles ?? '', site: r?.fields?.clean_site_check ?? '', overridden: !!job.overrides[i]
        };
      })
    };
  }

  private matching(rows: Row[], results: (RowResult | null)[], filter: string, q: string): number[] {
    const needle = q.trim().toLowerCase();
    return rows.map((_, i) => i).filter(i => {
      const r = results[i];
      const outcome = r ? r.outcome : 'unchecked';
      if (filter && filter !== 'all' && outcome !== filter) return false;
      if (!needle) return true;
      const row = rows[i];
      return [row.name, row.category, row.address, row.website, r?.reason].some(v => String(v || '').toLowerCase().includes(needle));
    });
  }

  async override(index: number, outcome: Outcome | null): Promise<JobMeta> {
    const job = await this.require();
    if (outcome) job.overrides[index] = outcome; else delete job.overrides[index];
    await this.persist(job);
    return job;
  }

  /** Sets every business matching the filter and search (not just those shown). */
  async bulk(filter: string, q: string, outcome: Outcome | null): Promise<number> {
    const job = await this.require();
    const { rows } = await this.rows(job);
    const results = await this.finalResults(job);
    const matches = this.matching(rows, results, filter, q);
    for (const i of matches) { if (outcome) job.overrides[i] = outcome; else delete job.overrides[i]; }
    await this.persist(job);
    return matches.length;
  }

  async download(format: 'xlsx' | 'csv'): Promise<{ path: string; name: string }> {
    const job = await this.require();
    const { rows, mapping } = await this.rows(job);
    const results = await this.finalResults(job);
    const c = await this.counts(job);
    const base = (job.directoryName || job.fileName.replace(/\.\w+$/, '')).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'cleaned';
    const name = `${base}-${job.area || 'all'}-cleaned.${format}`;
    const path = join(this.dir(job.id), name);
    await writeResults(path, rows, results, mapping, directoryTemplate, [
      ['Input file', job.fileName], ['Directory', job.directoryName], ['Target area', job.area ? regionName(job.area) : 'none'],
      ['Businesses', rows.length], [LABEL.keep, c.keep], [LABEL.review, c.review], [LABEL.remove, c.remove], ['Not checked', c.unchecked],
      ['Set by you', c.overridden], ['Jev calls', job.jevCalls], ['Exported', new Date().toISOString()]
    ]);
    return { path, name };
  }
}

/** A directory name from the list's search terms ("dog groomer; dog grooming near me" -> "Dog grooming"). */
export function suggestName(terms: string[]): string {
  if (!terms.length) return '';
  const clean = (t: string) => t.toLowerCase().replace(/\b(near me|nearby|near by|local|best|in|the|services?)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const counts = new Map<string, number>();
  for (const t of terms) { const c = clean(t); if (c) counts.set(c, (counts.get(c) || 0) + 1); }
  // Prefer a specific two-or-more-word term ("dog groomer" over "groomer"), then the most common, then the shortest.
  const words = (t: string) => (t.split(' ').length >= 2 ? 1 : 0);
  const best = [...counts.entries()].sort((a, b) => words(b[0]) - words(a[0]) || b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] || '';
  return best ? best.charAt(0).toUpperCase() + best.slice(1) : '';
}
