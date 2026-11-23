#!/usr/bin/env node
// list-cleaner command-line runner.
//   clean <file>            clean a list (CSV / XLSX / JSON) and write a results workbook
//   rules <file>            write starter rules for a directory as JSON (edit, then pass with --rules)
//   suggest-rules <file>    ask Jev about the batch's Google categories and improve the rules
//   inspect <file>          show which column was matched to which field
//   compare <old> <new>     compare two result files (e.g. the extension's output vs this tool's)
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { areaCode, guessArea, regionName } from './core/area.js';
import { createBrowserReader, type BrowserReader } from './core/browser.js';
import { fetchDetailed, normaliseUrl, readPage, websiteKind } from './core/site.js';
import { FIELDS, tableToRows } from './core/columns.js';
import { writeResults } from './core/export.js';
import { readSheets, readTable } from './core/io.js';
import { JevClient } from './core/jev.js';
import { runJob, type Evidence, type RowResult } from './core/pipeline.js';
import { outcomeFromLabel } from './core/template.js';
import type { Row } from './core/types.js';
import { termsFromRows } from './templates/directory/rules.js';
import { getTemplate, TEMPLATES } from './templates/index.js';

const HELP = `list-cleaner <command> [options]

Commands
  clean <file>           Clean a list and write a results workbook
  serve                  Open the web app in your browser (http://localhost:4310)
  rules <file>           Write starter rules (JSON) for this list
  suggest-rules <file>   Improve rules by asking Jev about the list's categories (needs JEV_API_KEY)
  inspect <file>         Show how columns were matched
  diagnose <results>     Retry websites a results file couldn't read, and say why they failed
  probe <url...>         Try one or more sites several ways, to see what a blocking site objects to
  redecide <file>        Re-apply rules to an earlier run's saved evidence (no website reads, no Jev calls)
                         --from <earlier output.xlsx>; add --live to fill gaps with fresh checks
  compare <old...> <new> Compare Result columns (old can be several files, e.g. Clean Review Rejected)

Options
  --template <id>        ${Object.keys(TEMPLATES).join(', ')} (default: directory)
  --area <code|name>     Target area, e.g. KS, Kansas, UK, ENG (default: most common in the list)
  --name <text>          Directory name, e.g. "Storm Shelters" (used to build starter rules)
  --rules <file.json>    Rules to use (from "rules" or "suggest-rules")
  --out <file>           Output .xlsx or .csv (default: <input>-cleaned.xlsx / -rules.json)
  --map key=Header,...   Force column matches, e.g. --map website="Company URL",name=Title
  --limit <n>            Only check the first n businesses after the free filter (test runs)
  --concurrency <n>      Businesses checked at once (default 6)
  --no-jev               Don't call Jev even if a key is set (uncertain businesses go to Review)
  --no-browser           Don't open hard-to-read sites in headless Chrome (faster, reads fewer sites)
  --fresh                Ignore saved progress and start again
  --port <n>             (serve) port to use, default 4310
  --from <file.xlsx>     (redecide) the earlier output whose evidence to reuse
  --live                 (redecide) check businesses the evidence doesn't cover, and ask Jev when the rules need a new answer
  --reask                (redecide, with --live) reuse saved website text but ask Jev every question again
  -h, --help

Jev key: set JEV_API_KEY in the environment or in a .env file in the current folder.`;

function loadDotEnv() {
  if (!existsSync('.env')) return;
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function parseMap(spec?: string): Record<string, string> {
  if (!spec) return {};
  const out: Record<string, string> = {};
  for (const part of spec.split(',')) {
    const i = part.indexOf('=');
    if (i < 1) throw new Error(`--map needs key=Header pairs, got "${part}"`);
    const key = part.slice(0, i).trim(), header = part.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (!FIELDS.some(f => f.key === key)) throw new Error(`Unknown field "${key}". Fields: ${FIELDS.map(f => f.key).join(', ')}`);
    out[key] = header;
  }
  return out;
}

const stem = (p: string) => p.slice(0, p.length - extname(p).length);
const log = (s: string) => process.stderr.write(s + '\n');

async function loadList(path: string, map?: string) {
  const table = await readTable(path);
  const { rows, mapping } = tableToRows(table, parseMap(map));
  if (!mapping.byKey.name) throw new Error('Could not find the business name column. Use --map name="Your Header".');
  return { rows, mapping };
}

async function loadRules(template: ReturnType<typeof getTemplate>, rows: Row[], v: Record<string, unknown>) {
  if (v.rules) return template.parseRules(JSON.parse(await readFile(String(v.rules), 'utf8')));
  const terms = termsFromRows(rows);
  if (!v.name && !terms.length) throw new Error('I can\u2019t tell what this directory lists: the file has no search terms. Add --name "Storm Shelters" (what the directory lists), or --rules rules.json.');
  return template.defaultRules({ name: String(v.name || ''), terms, rows });
}

function resolveArea(v: Record<string, unknown>, rows: Row[]): string {
  if (v.area) {
    const code = areaCode(String(v.area));
    if (!code) throw new Error(`Unknown area "${v.area}". Use a US state (KS or Kansas) or UK, ENG, SCT, WLS, NIR.`);
    return code;
  }
  return guessArea(rows);
}

async function cmdClean(input: string, v: Record<string, unknown>) {
  const template = getTemplate(String(v.template || 'directory'));
  const { rows, mapping } = await loadList(input, v.map as string | undefined);
  const rules = await loadRules(template, rows, v);
  const area = resolveArea(v, rows);
  const out = String(v.out || stem(input) + '-cleaned.xlsx');
  const statePath = out + '.state.json';
  await mkdir(dirname(out), { recursive: true });
  const key = process.env.JEV_API_KEY || '';
  const classifier = key && !v['no-jev'] ? new JevClient({ apiKey: key }) : undefined;

  // Resume support: same input file (size + modified time) and same number of rows.
  const info = await stat(input);
  const fingerprint = `${basename(input)}|${info.size}|${info.mtimeMs}|${rows.length}|${template.id}`;
  let previous: (RowResult | null)[] | undefined;
  if (!v.fresh && existsSync(statePath)) {
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    if (saved.fingerprint === fingerprint) { previous = saved.results; log(`Resuming: ${saved.results.filter(Boolean).length} businesses already done (use --fresh to start again).`); }
  }

  const browser = await startBrowser(v);
  log(`${rows.length} businesses · template: ${template.label} · area: ${area ? regionName(area) : 'none'} · Jev: ${classifier ? 'on' : 'off'} · browser: ${browser ? browser.name : 'off'}`);
  if (!classifier && !v['no-jev']) log('No JEV_API_KEY set: businesses that need a judgment go to Review.');

  const results: (RowResult | null)[] = previous ? [...previous] : rows.map(() => null);
  // Evidence for redecide: one JSON line per checked business, appended as results come in.
  const evidencePath = out + '.evidence.jsonl';
  if (!previous) await writeFile(evidencePath, JSON.stringify({ fingerprint: rowsFingerprint(rows), template: template.id }) + '\n');
  let lastSave = Date.now(), lastLog = 0;
  const save = () => writeFile(statePath, JSON.stringify({ fingerprint, results }));
  const controller = new AbortController();
  let stops = 0;
  process.on('SIGINT', () => {
    if (++stops > 1) { log('\nStopped. Progress up to the last few seconds is saved; run the same command to carry on.'); void save().finally(() => process.exit(130)); return; }
    log('\nStopping after the current businesses… (press Ctrl+C again to stop now; progress is saved)'); controller.abort();
  });

  const summary = await runJob({
    rows, template, rules, area, classifier, previous, browser: browser ? (u: string) => browser.read(u) : undefined,
    concurrency: Number(v.concurrency || 6), limit: v.limit !== undefined ? Number(v.limit) : undefined, signal: controller.signal,
    onResult: (i, r, p, ev) => {
      results[i] = r;
      if (ev.site || ev.asks.length) void appendFile(evidencePath, JSON.stringify({ i, ev }) + '\n');
      if (Date.now() - lastLog > 1000 || p.done === p.total) { lastLog = Date.now(); process.stderr.write(`\rChecked ${p.done}/${p.total}   `); }
      if (Date.now() - lastSave > 5000) { lastSave = Date.now(); void save(); }
    }
  });
  process.stderr.write('\n');
  await browser?.close();
  summary.results.forEach((r, i) => { results[i] = r; });
  await save();

  const labels = template.outcomeLabels;
  const c = summary.counts;
  const lines: [string, string | number][] = [
    ['Input file', basename(input)], ['Template', template.label], ['Target area', area ? regionName(area) : 'none'],
    ['Businesses', rows.length], [labels.keep, c.keep], [labels.review, c.review], [labels.remove, c.remove], ['Not checked', c.unchecked],
    ['Removed by free filter', summary.results.filter(r => r?.stage === 'free').length],
    ['Jev calls', classifier?.calls ?? 0], ['Jev input tokens', classifier?.tokens ?? 0], ['Finished', new Date().toISOString()]
  ];
  await writeResults(out, rows, summary.results, mapping, template, lines);
  log(`${labels.keep}: ${c.keep} · ${labels.review}: ${c.review} · ${labels.remove}: ${c.remove}` + (c.unchecked ? ` · Not checked: ${c.unchecked}` : ''));
  if (classifier) log(`Jev: ${classifier.calls} calls, ${classifier.tokens.toLocaleString()} input tokens`);
  log(`Saved ${out}`);
  if (summary.error) { log('Stopped: ' + summary.error.message); process.exitCode = 2; }
}


async function startBrowser(v: Record<string, unknown>): Promise<BrowserReader | null> {
  if (v['no-browser']) return null;
  const { reader, error } = await createBrowserReader({ concurrency: 3 });
  if (!reader) log('Headless browser not available, so hard-to-read sites will be skipped. ' + error);
  return reader;
}

/** Retries every website a results file marked unreadable, plain request first, then the browser. */
async function cmdDiagnose(input: string, v: Record<string, unknown>) {
  const tables = input.toLowerCase().endsWith('.xlsx') ? (await readSheets(input)).map(s => s.table) : [await readTable(input)];
  const targets: { name: string; website: string; check: string }[] = [];
  for (const table of tables) {
    const h = (table[0] || []).map(x => String(x ?? '').trim());
    const ci = h.indexOf('Website Check'), ni = h.indexOf('Business Name'), wi = h.indexOf('Website');
    if (ci < 0 || ni < 0 || wi < 0) continue;
    for (const line of table.slice(1)) {
      const check = String(line?.[ci] ?? '');
      if (/^Website unreachable|^Website has almost no readable text/.test(check) && websiteKind(line?.[wi]) === 'site') targets.push({ name: String(line[ni]), website: String(line[wi]), check });
    }
  }
  const list = v.limit ? targets.slice(0, Number(v.limit)) : targets;
  log(`${targets.length} unreadable websites found${list.length < targets.length ? `, checking ${list.length}` : ''}.`);
  const browser = await startBrowser(v);
  if (browser) log(`Browser: ${browser.name}`);
  const out: (string | number)[][] = [];
  const tally: Record<string, number> = {};
  let done = 0;
  const queue = [...list];
  const worker = async () => {
    while (queue.length) {
      const t = queue.shift()!;
      const url = normaliseUrl(t.website);
      const first = await fetchDetailed(url);
      const second = first.page ? first : await fetchDetailed(url.startsWith('https:') ? url.replace(/^https:/, 'http:') : url.replace(/^http:/, 'https:'));
      const plainText = second.page ? readPage(second.page.html, second.page.url).text.length : 0;
      const plain = second.page ? (plainText < 80 ? `Read, but only ${plainText} characters` : `OK now (${plainText} characters)`) : (first.error || 'failed') + (second.error && second.error !== first.error ? ' / ' + second.error : '');
      let viaBrowser = 'not tried', browserText = 0;
      if (browser && (!second.page || plainText < 80)) {
        const seen = await browser.readDetailed(url);
        browserText = seen.page ? readPage(seen.page.html, seen.page.url).text.length : 0;
        const how = seen.tier === 2 ? ' (second attempt, off-screen window)' : '';
        viaBrowser = !seen.page ? 'failed: ' + (seen.error || 'unknown') : browserText < 80 ? `only ${browserText} characters` + (seen.error ? ` (${seen.error})` : '') : 'OK' + how;
      }
      const bucket = second.page && plainText >= 80 ? 'Plain request works now' : viaBrowser.startsWith('OK (second') ? 'Fixed by second attempt' : viaBrowser.startsWith('OK') ? 'Fixed by browser' : 'Still unreadable';
      const bReason = viaBrowser.startsWith('failed') ? viaBrowser.replace(/https?:\/\/\S+/g, '').slice(0, 60) : '';
      if (bReason) tally['  browser ' + bReason] = (tally['  browser ' + bReason] || 0) + 1;
      tally[bucket] = (tally[bucket] || 0) + 1;
      const reason = (first.error || '').replace(/\(.*\)/, '').trim() || (second.page ? 'little text' : 'failed');
      tally['  plain failure: ' + reason] = (tally['  plain failure: ' + reason] || 0) + 1;
      out.push([t.name, t.website, t.check, plain, viaBrowser, browserText, bucket]);
      process.stderr.write(`\rChecked ${++done}/${list.length}   `);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  process.stderr.write('\n');
  await browser?.close();
  for (const [k, n] of Object.entries(tally).sort((a, b) => (a[0].startsWith(' ') ? 1 : 0) - (b[0].startsWith(' ') ? 1 : 0) || b[1] - a[1])) log(`${String(n).padStart(5)}  ${k}`);
  const path = String(v.out || stem(input) + '-diagnose.csv');
  const { writeCsv } = await import('./core/io.js');
  await writeCsv(path, ['Business Name', 'Website', 'Earlier Check', 'Plain Request', 'Browser', 'Browser Characters', 'Outcome'], out);
  log(`Details saved to ${path}`);
}

/** Tries one site several ways, to find out what a blocking site objects to. */
async function cmdProbe(urls: string[]) {
  const { chromium } = await import('playwright-core');
  const { launch, makeContext, readWith } = await import('./core/browser.js');
  const variants: { label: string; headless: boolean; args: string[]; style: Parameters<typeof makeContext>[1] }[] = [
    { label: 'A headless, as v4 (fixed version, media blocked)', headless: true, args: ['--disable-blink-features=AutomationControlled'], style: { fixUserAgent: true, blockMedia: true, hideWebdriver: true } },
    { label: 'B headless, nothing altered', headless: true, args: [], style: {} },
    { label: 'C headless, HTTP/1.1', headless: true, args: ['--disable-http2'], style: { fixUserAgent: true } },
    { label: 'D window, nothing altered', headless: false, args: ['--window-position=-32000,-32000'], style: {} },
    { label: 'E window, automation signs hidden', headless: false, args: ['--window-position=-32000,-32000', '--disable-blink-features=AutomationControlled'], style: { hideWebdriver: true } }
  ];
  for (const raw of urls) {
    const url = normaliseUrl(raw);
    const plain = await fetchDetailed(url);
    log(`\n${url}\n  plain request: ${plain.page ? `OK (${readPage(plain.page.html, plain.page.url).text.length} characters)` : plain.error}`);
    for (const v of variants) {
      const b = await launch(chromium, v.headless, v.args);
      if ('error' in b) { log(`  ${v.label}: could not start (${b.error.split('\n')[0]})`); continue; }
      const ctx = await makeContext(b.browser, v.style);
      const r = await readWith(ctx, url, 25000, 3000);
      const chars = r.page ? readPage(r.page.html, r.page.url).text.length : 0;
      log(`  ${v.label}: ${r.page ? `${chars} characters` : 'failed'}${r.error ? ` (${r.error})` : ''}`);
      await b.browser.close().catch(() => {});
    }
  }
}

/** Identifies a list by its businesses, so evidence is only reused for the same list. */
function rowsFingerprint(rows: Row[]): string {
  let h = 0;
  for (const r of rows) for (const c of (r.place_key || r.place_id || r.name || '') + '|') h = (h * 31 + c.charCodeAt(0)) | 0;
  return `${rows.length}:${(h >>> 0).toString(36)}`;
}

async function loadEvidence(path: string, rows: Row[]): Promise<(Evidence | null)[]> {
  if (!existsSync(path)) throw new Error(`No saved evidence at ${path}. Evidence is saved by clean runs from this version on.`);
  const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
  const header = JSON.parse(lines[0] || '{}');
  if (header.fingerprint && header.fingerprint !== rowsFingerprint(rows)) throw new Error('That evidence belongs to a different list (the businesses don\u2019t match).');
  const out: (Evidence | null)[] = rows.map(() => null);
  for (const line of lines.slice(1)) {
    try { const { i, ev } = JSON.parse(line); if (typeof i === 'number' && i < out.length) out[i] = ev; } catch { /* a line cut off by a crash */ }
  }
  return out;
}

async function cmdRedecide(input: string, v: Record<string, unknown>) {
  if (!v.from) throw new Error('redecide needs --from <earlier output.xlsx> (the run whose evidence to reuse).');
  const template = getTemplate(String(v.template || 'directory'));
  const { rows, mapping } = await loadList(input, v.map as string | undefined);
  const rules = await loadRules(template, rows, v);
  const area = resolveArea(v, rows);
  let replay = await loadEvidence(String(v.from) + '.evidence.jsonl', rows);
  // --reask: keep the saved website text, but ask Jev again (e.g. after its questions changed).
  if (v.reask) {
    if (!v.live) throw new Error('--reask asks Jev again, so it needs --live too.');
    replay = replay.map(e => e ? { site: e.site, asks: [] } : e);
  }
  const out = String(v.out || stem(String(v.from)) + '-redecided.xlsx');
  await mkdir(dirname(out), { recursive: true });
  const key = process.env.JEV_API_KEY || '';
  const live = !!v.live;
  const classifier = live && key && !v['no-jev'] ? new JevClient({ apiKey: key }) : undefined;
  const browser = live ? await startBrowser(v) : null;
  log(`${rows.length} businesses · ${replay.filter(Boolean).length} with saved evidence · area: ${area ? regionName(area) : 'none'}` + (live ? ' · filling gaps live' : ''));
  const evidencePath = out + '.evidence.jsonl';
  await writeFile(evidencePath, JSON.stringify({ fingerprint: rowsFingerprint(rows), template: template.id }) + '\n');
  const lines: string[] = [];
  const summary = await runJob({
    rows, template, rules, area, classifier, replay, replayLive: live,
    browser: browser ? (u: string) => browser.read(u) : undefined,
    onResult: (i, _r, p, ev) => { if (ev.site || ev.asks.length) lines.push(JSON.stringify({ i, ev })); if (live) process.stderr.write(`\rChecked ${p.done}/${p.total}   `); }
  });
  await browser?.close();
  await appendFile(evidencePath, lines.join('\n') + (lines.length ? '\n' : ''));
  const labels = template.outcomeLabels, c = summary.counts;
  await writeResults(out, rows, summary.results, mapping, template, [
    ['Input file', basename(input)], ['Re-decided from', basename(String(v.from))], ['Template', template.label], ['Target area', area ? regionName(area) : 'none'],
    ['Businesses', rows.length], [labels.keep, c.keep], [labels.review, c.review], [labels.remove, c.remove], ['Not checked', c.unchecked],
    ['Decided from saved evidence', summary.replayed ?? 0], ['Needed a fresh Jev answer', summary.needsFresh ?? 0],
    ['Jev calls', classifier?.calls ?? 0], ['Finished', new Date().toISOString()]
  ]);
  log(`${labels.keep}: ${c.keep} · ${labels.review}: ${c.review} · ${labels.remove}: ${c.remove}` + (c.unchecked ? ` · Not checked: ${c.unchecked}` : ''));
  if (summary.needsFresh) log(`${summary.needsFresh} need a fresh Jev answer for the new rules: they are in Review. Add --live to ask Jev for those only.`);
  if (c.unchecked) log(`${c.unchecked} have no saved evidence (e.g. newly let through by the free filter). Add --live to check them.`);
  log(`Saved ${out}`);
}

async function cmdServe(v: Record<string, unknown>) {
  const { createApp } = await import('./server/app.js');
  const port = Number(v.port || 4310);
  const { server } = createApp({ dataDir: join(process.cwd(), 'data'), browser: !v['no-browser'] });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve()); });
  const url = `http://localhost:${port}`;
  log(`List cleaner is running at ${url}  (keep this window open; Ctrl+C to stop)`);
  const { spawn } = await import('node:child_process');
  const open = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(open[0] as string, open[1] as string[], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* open it by hand */ }
}

async function cmdRules(input: string, v: Record<string, unknown>) {
  const template = getTemplate(String(v.template || 'directory'));
  const { rows } = await loadList(input, v.map as string | undefined);
  const rules = await loadRules(template, rows, v);
  const out = String(v.out || stem(input) + '-rules.json');
  await writeFile(out, JSON.stringify(rules, null, 2) + '\n');
  log(`Starter rules saved to ${out}. Edit them, then run: clean ${basename(input)} --rules ${basename(out)}`);
}

async function cmdSuggest(input: string, v: Record<string, unknown>) {
  const template = getTemplate(String(v.template || 'directory'));
  if (!template.suggestRules) throw new Error(`${template.label} has no rule suggestions.`);
  const key = process.env.JEV_API_KEY;
  if (!key) throw new Error('Set JEV_API_KEY to get suggestions.');
  const { rows } = await loadList(input, v.map as string | undefined);
  const rules = await loadRules(template, rows, v);
  const classifier = new JevClient({ apiKey: key });
  const { rules: next, summary } = await template.suggestRules(rows, rules, classifier, (d, t) => process.stderr.write(`\rAsking Jev about categories… ${d}/${t}   `));
  process.stderr.write('\n');
  const out = String(v.out || v.rules || stem(input) + '-rules.json');
  await writeFile(out, JSON.stringify(next, null, 2) + '\n');
  log(summary);
  log(`Jev: ${classifier.calls} calls, ${classifier.tokens.toLocaleString()} input tokens. Rules saved to ${out}.`);
}

async function cmdInspect(input: string, v: Record<string, unknown>) {
  const table = await readTable(input);
  const { rows, mapping } = tableToRows(table, parseMap(v.map as string | undefined));
  log(`${rows.length} rows`);
  for (const f of FIELDS) log(`  ${f.key.padEnd(22)} ${mapping.byKey[f.key] ? '← ' + mapping.byKey[f.key] : '(not found)'}`);
  if (mapping.extras.length) log(`  kept as extra columns: ${mapping.extras.join(', ')}`);
  const area = guessArea(rows);
  log(`Most common area: ${area ? regionName(area) : 'none found'}`);
}

/** Business identity for matching rows across files. */
const idOf = (r: Row) => r.place_key || r.place_id || `${String(r.name || '').toLowerCase()}|${String(r.phone || '').replace(/\D/g, '')}`;

/** Every row with a Result, from a CSV or from all sheets of a workbook (Clean, Review, Rejected...). */
async function readResultFile(path: string) {
  const tables = path.toLowerCase().endsWith('.xlsx') ? (await readSheets(path)).map(s => s.table) : [await readTable(path)];
  const out: { id: string; name: string; result: string; reason: string }[] = [];
  for (const table of tables) {
    const headers = (table[0] || []).map(h => String(h ?? '').trim());
    const ri = headers.findIndex(h => h.toLowerCase() === 'result'), why = headers.findIndex(h => h.toLowerCase() === 'reason');
    if (ri < 0) continue;
    // Map rows by position: tableToRows skips blank lines, so walk the table directly.
    const { rows } = tableToRows([table[0], ...table.slice(1).filter(l => l && (l as unknown[]).some(v => String(v ?? '').trim()))]);
    const lines = table.slice(1).filter(l => l && (l as unknown[]).some(v => String(v ?? '').trim()));
    rows.forEach((row, i) => out.push({ id: idOf(row), name: row.name, result: String(lines[i]?.[ri] ?? ''), reason: why >= 0 ? String(lines[i]?.[why] ?? '') : '' }));
  }
  if (!out.length) throw new Error(`${basename(path)} has no Result column.`);
  return out;
}

async function cmdCompare(olds: string[], b: string, v: Record<string, unknown>) {
  const template = getTemplate(String(v.template || 'directory'));
  const left = (await Promise.all(olds.map(readResultFile))).flat();
  const right = await readResultFile(b);
  const a = olds.length > 1 ? `${olds.length} old files` : olds[0];
  const byId = new Map(right.map(r => [r.id, r]));
  const matrix: Record<string, Record<string, number>> = {};
  const diffs: string[][] = [];
  let matched = 0, same = 0, skipped = 0;
  for (const l of left) {
    const r = byId.get(l.id);
    if (!r) continue;
    if (/^not checked$/i.test(r.result) || /^not checked$/i.test(l.result)) { skipped++; continue; }
    matched++;
    const lo = outcomeFromLabel(template, l.result) || l.result, ro = outcomeFromLabel(template, r.result) || r.result;
    (matrix[lo] ||= {})[ro] = (matrix[lo][ro] || 0) + 1;
    if (lo === ro) same++; else diffs.push([l.name || '', l.result, r.result, l.reason, r.reason]);
  }
  log(`Compared ${matched} of ${left.length} businesses${skipped ? ` (${skipped} not checked yet, skipped)` : ''}. Same result: ${same} (${matched ? Math.round(same / matched * 1000) / 10 : 0}%).`);
  log('Rows = ' + basename(a) + ', columns = ' + basename(b));
  const keys = ['keep', 'review', 'remove'];
  log('            ' + keys.map(k => template.outcomeLabels[k as 'keep'].padStart(10)).join(''));
  for (const k of keys) log(template.outcomeLabels[k as 'keep'].padEnd(12) + keys.map(j => String(matrix[k]?.[j] || 0).padStart(10)).join(''));
  if (v.out && diffs.length) {
    const { writeCsv } = await import('./core/io.js');
    await writeCsv(String(v.out), ['Business Name', 'Old Result', 'New Result', 'Old Reason', 'New Reason'], diffs);
    log(`${diffs.length} differences saved to ${v.out}`);
  }
}

async function main() {
  loadDotEnv();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      template: { type: 'string' }, area: { type: 'string' }, name: { type: 'string' }, rules: { type: 'string' }, out: { type: 'string' },
      map: { type: 'string' }, port: { type: 'string' }, from: { type: 'string' }, live: { type: 'boolean' }, reask: { type: 'boolean' }, limit: { type: 'string' }, concurrency: { type: 'string' }, 'no-jev': { type: 'boolean' }, 'no-browser': { type: 'boolean' }, fresh: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }
    }
  });
  const [cmd, ...args] = positionals;
  if (values.help || !cmd) { console.log(HELP); return; }
  if (cmd === 'serve') return cmdServe(values);
  const need = (n: number) => { if (args.length < n) throw new Error(`"${cmd}" needs ${n === 1 ? 'a file' : n + ' files'}. See --help.`); };
  switch (cmd) {
    case 'clean': need(1); return cmdClean(args[0], values);
    case 'rules': need(1); return cmdRules(args[0], values);
    case 'suggest-rules': need(1); return cmdSuggest(args[0], values);
    case 'inspect': need(1); return cmdInspect(args[0], values);
    case 'redecide': need(1); return cmdRedecide(args[0], values);
    case 'diagnose': need(1); return cmdDiagnose(args[0], values);
    case 'probe': need(1); return cmdProbe(args);
    case 'compare': need(2); return cmdCompare(args.slice(0, -1), args[args.length - 1], values);
    default: throw new Error(`Unknown command "${cmd}". See --help.`);
  }
}

main().catch(e => { log('Error: ' + (e as Error).message); process.exitCode = 1; });
