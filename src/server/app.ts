// Local web app: a small HTTP server over the engine. Single user, runs on the user's own PC for now.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AREAS, guessArea, regionName, rowArea } from '../core/area.js';
import { FIELDS } from '../core/columns.js';
import { createBrowserReader } from '../core/browser.js';
import { JevClient } from '../core/jev.js';
import type { FetchHtml } from '../core/site.js';
import type { Classifier, Outcome } from '../core/types.js';
import { JobStore } from './jobs.js';

export interface AppOptions {
  dataDir: string;
  /** For tests: replaces the Jev client built from the saved key. */
  classifier?: () => (Classifier & { calls?: number }) | undefined;
  fetcher?: FetchHtml;
  /** Use headless Chrome for hard-to-read sites (default true). */
  browser?: boolean;
}

const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const OUTCOMES = new Set(['keep', 'review', 'remove']);

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

async function body(req: IncomingMessage, limit = 60 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > limit) throw new HttpError(413, 'That file is too big (60 MB limit).'); chunks.push(c as Buffer); }
  return Buffer.concat(chunks);
}
async function json<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const b = await body(req, 5 * 1024 * 1024);
  try { return (b.length ? JSON.parse(b.toString('utf8')) : {}) as T; } catch { throw new HttpError(400, 'Bad request.'); }
}
function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

export function createApp(opts: AppOptions): { server: Server; jobs: JobStore } {
  const settingsPath = join(opts.dataDir, 'settings.json');
  let settings: { jevKey?: string } = {};
  const loadSettings = async () => { if (existsSync(settingsPath)) settings = JSON.parse(await readFile(settingsPath, 'utf8')); };
  const jevKey = () => settings.jevKey || process.env.JEV_API_KEY || '';
  const classifier = opts.classifier ?? (() => jevKey() ? new JevClient({ apiKey: jevKey() }) : undefined);
  const jobs = new JobStore({
    dataDir: opts.dataDir, classifier, fetcher: opts.fetcher,
    browser: opts.browser === false ? undefined : async () => {
      const { reader } = await createBrowserReader({ concurrency: 3 });
      return reader ? { read: (u: string) => reader.read(u), close: () => reader.close() } : null;
    }
  });
  let suggestProgress: { done: number; total: number } | null = null;
  const ready = (async () => { await mkdir(join(opts.dataDir, 'jobs'), { recursive: true }); await loadSettings(); })();

  async function state() {
    const job = await jobs.current();
    const base = { settings: { hasKey: !!jevKey(), keyFrom: settings.jevKey ? 'app' : process.env.JEV_API_KEY ? 'env' : '' }, areas: AREAS, fields: FIELDS.map(f => ({ key: f.key, label: f.label })) };
    if (!job) return { ...base, job: null };
    const { rows, mapping, headers } = await jobs.rows(job);
    const areaCounts: Record<string, number> = {};
    for (const r of rows) { const a = rowArea(r); if (a) areaCounts[a] = (areaCounts[a] || 0) + 1; }
    return {
      ...base,
      job: {
        ...job, running: jobs.isRunning(job.id),
        businesses: rows.length, headers, mapping: mapping.byKey,
        areaGuess: { code: guessArea(rows), name: regionName(guessArea(rows)), counts: areaCounts },
        rules: await jobs.rules(job), questions: await jobs.questions(job), counts: await jobs.counts(job),
        suggestProgress
      }
    };
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    await ready;
    const url = new URL(req.url || '/', 'http://localhost');
    const p = url.pathname, m = req.method || 'GET';

    if (!p.startsWith('/api/')) {
      const file = p === '/' ? 'index.html' : p.slice(1);
      if (!/^[\w.-]+$/.test(file)) throw new HttpError(404, 'Not found');
      const path = join(WEB, file);
      if (!existsSync(path)) throw new HttpError(404, 'Not found');
      res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(await readFile(path));
      return;
    }

    if (p === '/api/state' && m === 'GET') return send(res, 200, await state());

    if (p === '/api/settings' && m === 'PUT') {
      const { jevKey: key } = await json<{ jevKey?: string }>(req);
      settings.jevKey = String(key || '').trim() || undefined;
      await writeFile(settingsPath, JSON.stringify(settings));
      return send(res, 200, await state());
    }
    if (p === '/api/settings/test' && m === 'POST') {
      const c = classifier();
      if (!c) throw new HttpError(400, 'No Jev key saved.');
      try {
        const r = await c.ask({ model: 'jev-latest', state: 'We are a family-run plumbing company in Wichita, Kansas.', questions: { t: { type: 'noul', instructions: 'Is this a plumbing business?' } } });
        return send(res, 200, { ok: true, message: `Key works (test answer ${Math.round((r.answers.t?.noul ?? 0) * 100)}% yes).` });
      } catch (e) { return send(res, 200, { ok: false, message: (e as Error).message }); }
    }

    if (p === '/api/upload' && m === 'POST') {
      const name = decodeURIComponent(String(req.headers['x-file-name'] || 'list.xlsx'));
      const data = await body(req);
      if (!data.length) throw new HttpError(400, 'The file is empty.');
      await jobs.create(name, data);
      return send(res, 200, await state());
    }
    if (p === '/api/job/new' && m === 'POST') { await jobs.startNew(); return send(res, 200, await state()); }
    if (p === '/api/job/mapping' && m === 'PUT') { await jobs.setMapping((await json<{ overrides: Record<string, string> }>(req)).overrides || {}); return send(res, 200, await state()); }
    if (p === '/api/job/setup' && m === 'PUT') {
      const b = await json<{ name?: string; area?: string }>(req);
      if (b.area && !AREAS[b.area]) throw new HttpError(400, 'Unknown area.');
      await jobs.setup(String(b.name || ''), String(b.area || ''));
      return send(res, 200, await state());
    }
    if (p === '/api/job/suggest' && m === 'POST') {
      suggestProgress = { done: 0, total: 0 };
      try { await jobs.suggest((done, total) => { suggestProgress = { done, total }; }); }
      finally { suggestProgress = null; }
      return send(res, 200, await state());
    }
    if (p === '/api/job/answers' && m === 'PUT') { await jobs.setAnswers((await json<{ answers: Record<string, string | string[]> }>(req)).answers || {}); return send(res, 200, await state()); }
    if (p === '/api/job/rules' && m === 'PUT') { await jobs.setAdvanced((await json<{ rules: unknown }>(req)).rules ?? null); return send(res, 200, await state()); }
    if (p === '/api/job/run' && m === 'POST') { await jobs.run(); return send(res, 200, await state()); }
    if (p === '/api/job/stop' && m === 'POST') { await jobs.stop(); return send(res, 200, await state()); }

    if (p === '/api/job/rows' && m === 'GET') {
      const n = (k: string, d: number) => Math.max(0, Number(url.searchParams.get(k) ?? d) || 0);
      return send(res, 200, await jobs.listRows(url.searchParams.get('filter') || 'all', url.searchParams.get('q') || '', n('offset', 0), Math.min(500, n('limit', 100) || 100)));
    }
    const rowMatch = p.match(/^\/api\/job\/rows\/(\d+)$/);
    if (rowMatch && m === 'PUT') {
      const { outcome } = await json<{ outcome: string | null }>(req);
      if (outcome !== null && !OUTCOMES.has(outcome)) throw new HttpError(400, 'Unknown result.');
      await jobs.override(Number(rowMatch[1]), outcome as Outcome | null);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/job/bulk' && m === 'POST') {
      const b = await json<{ filter?: string; q?: string; outcome: string | null }>(req);
      if (b.outcome !== null && !OUTCOMES.has(b.outcome)) throw new HttpError(400, 'Unknown result.');
      const changed = await jobs.bulk(b.filter || 'all', b.q || '', b.outcome as Outcome | null);
      return send(res, 200, { changed });
    }
    if (p === '/api/job/download' && m === 'GET') {
      const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'xlsx';
      const { path, name } = await jobs.download(format);
      res.writeHead(200, {
        'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${name}"`
      });
      res.end(await readFile(path));
      return;
    }
    throw new HttpError(404, 'Not found');
  }

  const server = createServer((req, res) => {
    // Local only: refuse requests from other sites (a page elsewhere can't drive this app).
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) { send(res, 403, { error: 'Forbidden' }); return; }
    route(req, res).catch(e => {
      const status = (e as { status?: number }).status || 500;
      send(res, status, { error: (e as Error).message || 'Something went wrong.' });
    });
  });
  return { server, jobs };
}
