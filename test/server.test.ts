// The web app's API end to end: upload, setup questions, clean, re-sort on a new answer, override, bulk,
// download, start a new list. Mock Jev, mock websites, no browser.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import ExcelJS from 'exceljs';
import { createApp } from '../src/server/app.js';
import { MockClassifier } from '../src/core/jev.js';

const CSV = [
  'Business Name,Category,Website,Address,Phone Number,Search Query,Search Location,Maps Identifier',
  'Happy Paws Dog Grooming,Pet groomer,,"1 Main St, Lisburn BT28 1AA, United Kingdom",+44 28 9266 0000,dog groomer,"Northern Ireland, UK",a1',
  'Posh Pooch,Pet groomer,,"2 High St, Bangor BT20 5AA, United Kingdom",+44 28 9146 0000,dog groomer,"Northern Ireland, UK",a2',
  'Riverview Kennels,Kennel,http://riverview.example/,"3 Lough Rd, Lisburn BT28 2AA, United Kingdom",+44 28 9267 0000,dog grooming near me,"Northern Ireland, UK",a3',
  'Riverview Kennels Two,Kennel,http://riverview2.example/,"4 Lough Rd, Lisburn BT28 2AB, United Kingdom",+44 28 9267 1111,dog grooming near me,"Northern Ireland, UK",a3b',
  'Flynn Vets,Veterinarian,http://flynn.example/,"5 Lisburn Rd, Belfast BT9 7AA, United Kingdom",+44 28 9066 0000,dog groomer,"Northern Ireland, UK",a4',
  'Flynn Vets South,Veterinarian,http://flynn2.example/,"6 Lisburn Rd, Belfast BT9 7AB, United Kingdom",+44 28 9066 1111,dog groomer,"Northern Ireland, UK",a4b',
  'AC Male Grooming,Barber shop,,"7 Scotch St, Armagh BT61 7AA, United Kingdom",+44 28 3752 0000,groomer near me,"Northern Ireland, UK",a5',
  'Luxe Male Grooming,Barber shop,,"8 Scotch St, Armagh BT61 7AB, United Kingdom",+44 28 3752 1111,groomer near me,"Northern Ireland, UK",a6',
  'Dublin Dog Spa,Pet groomer,,"1 Main St, Dublin 2, D02 X285, Ireland",+353 1 555 0000,dog groomer,"Northern Ireland, UK",a7'
].join('\n');

const sites: Record<string, string> = {
  'http://riverview.example/': '<title>Riverview Kennels</title><body>Boarding kennels and cattery near Lisburn. We also offer full dog grooming: bath, clip and nail trim.</body>',
  'http://riverview2.example/': '<title>Riverview Kennels Two</title><body>Boarding kennels and cattery near Lisburn. We also offer full dog grooming: bath, clip and nail trim.</body>',
  'http://flynn.example/': '<title>Flynn Vets</title><body>Veterinary practice in Belfast: vaccinations, surgery, dental care, and dog grooming by our nurse team.</body>',
  'http://flynn2.example/': '<title>Flynn Vets South</title><body>Veterinary practice in Belfast: vaccinations, surgery, dental care, and dog grooming by our nurse team.</body>'
};

let base = '', dir = '', close: () => void;
const jev = new MockClassifier(req => {
  if (req.questions.relation) {
    const cat = String((req.state as { google_category: string }).google_category).toLowerCase();
    const p = cat.includes('barber') ? { different_trade: 0.95 } : cat.includes('groom') ? { is_the_service: 0.9 } : { might_offer: 0.8 };
    return { relation: { choice: Object.keys(p)[0], probabilities: p } };
  }
  const text = JSON.stringify(req.state);
  const side = /Kennels|Vets/.test(text);
  return { supplies: { noul: 0.95 }, public_place: { noul: 0 }, serves_state: { choice: 'yes', probabilities: { yes: 0.9 } },
    kind: { choice: side ? 'side_service' : 'supplier', probabilities: side ? { side_service: 0.9 } : { supplier: 0.9 } }, role: { choice: 'provider' } };
});

async function call(path: string, init: RequestInit & { json?: unknown } = {}) {
  const res = await fetch(base + path, { ...init, body: init.json !== undefined ? JSON.stringify(init.json) : init.body, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) } as { status: number; body: any };
}
async function waitIdle() {
  for (let n = 0; n < 200; n++) { const s = (await call('/api/state')).body; if (!s.job.running) return s; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('run did not finish');
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lc-app-'));
  const { server } = createApp({ dataDir: dir, classifier: () => jev, fetcher: async u => sites[u] ? { html: sites[u], url: u } : null, browser: false });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(async () => { close(); await rm(dir, { recursive: true, force: true }); });

describe('web app API', () => {
  it('serves the page', async () => {
    const r = await fetch(base + '/');
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('List cleaner');
  });

  it('uploads a list, matches columns and guesses the area and name', async () => {
    const r = await call('/api/upload', { method: 'POST', body: CSV, headers: { 'X-File-Name': 'ni-test.csv', 'Content-Type': 'application/octet-stream' } });
    expect(r.status).toBe(200);
    const job = r.body.job;
    expect(job.businesses).toBe(9);
    expect(job.mapping.name).toBe('Business Name');
    expect(job.area).toBe('NIR');
    expect(job.directoryName).toBe('Dog groomer');
  });

  it('builds rules, gets suggestions and asks plain-English questions', async () => {
    let s = (await call('/api/job/setup', { method: 'PUT', json: { name: 'Dog grooming', area: 'NIR' } })).body;
    expect(s.job.rules.niche).toBe('dog grooming');
    s = (await call('/api/job/suggest', { method: 'POST' })).body;
    expect(s.job.suggestSummary).toMatch(/barber shop/i);
    const ids = s.job.questions.map((q: { id: string }) => q.id);
    expect(ids).toEqual(expect.arrayContaining(['side', 'hardRemove', 'names', 'partial', 'duplicates']));
    const side = s.job.questions.find((q: { id: string }) => q.id === 'side');
    expect(side.options.map((o: { value: string }) => o.value)).toEqual(expect.arrayContaining(['kennel', 'veterinarian']));
  });

  it('cleans the list', async () => {
    await call('/api/job/run', { method: 'POST' });
    const s = await waitIdle();
    expect(s.job.status).toBe('done');
    expect(s.job.counts).toMatchObject({ keep: 6, remove: 3, unchecked: 0 });   // barbers (2) and Dublin rejected
  });

  it('re-sorts instantly when an answer changes (vets to Review, kennels listed), without new web or Jev calls', async () => {
    const before = jev.requests.length;
    const s = (await call('/api/job/answers', { method: 'PUT', json: { answers: { side: ['kennel'] } } })).body;
    expect(jev.requests.length).toBe(before);
    expect(s.job.counts).toMatchObject({ keep: 4, review: 2, remove: 3 });
    const review = (await call('/api/job/rows?filter=review')).body;
    expect(review.rows.map((r: { name: string }) => r.name).sort()).toEqual(['Flynn Vets', 'Flynn Vets South']);
    expect(review.rows[0].reason).toMatch(/as an extra to another main trade/);
  });

  it('lets the user decide one business, and bulk-set a search', async () => {
    const review = (await call('/api/job/rows?filter=review')).body;
    await call(`/api/job/rows/${review.rows[0].i}`, { method: 'PUT', json: { outcome: 'keep' } });
    let s = (await call('/api/state')).body;
    expect(s.job.counts).toMatchObject({ keep: 5, review: 1, overridden: 1 });
    const bulk = (await call('/api/job/bulk', { method: 'POST', json: { filter: 'all', q: 'flynn', outcome: 'remove' } })).body;
    expect(bulk.changed).toBe(2);
    s = (await call('/api/state')).body;
    expect(s.job.counts).toMatchObject({ keep: 4, review: 0, remove: 5, overridden: 2 });
    const rows = (await call('/api/job/rows?q=flynn')).body.rows;
    expect(rows.every((r: { overridden: boolean; reason: string }) => r.overridden && /^Set by you/.test(r.reason))).toBe(true);
  });

  it('downloads a workbook with the user’s decisions', async () => {
    const r = await call('/api/job/download?format=xlsx');
    expect(r.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body as Buffer);
    expect(wb.worksheets.map(w => w.name)).toEqual(['Clean', 'Review', 'Rejected', 'Summary']);
    expect(wb.getWorksheet('Rejected')!.rowCount - 1).toBe(5);
  });

  it('refuses requests from other websites', async () => {
    const r = await fetch(base + '/api/job/new', { method: 'POST', headers: { Origin: 'https://evil.example' } });
    expect(r.status).toBe(403);
  });

  it('starts a new list', async () => {
    const s = (await call('/api/job/new', { method: 'POST' })).body;
    expect(s.job).toBeNull();
  });

  it('never returns the saved Jev key', async () => {
    const s = (await call('/api/settings', { method: 'PUT', json: { jevKey: 'secret-key-123' } })).body;
    expect(JSON.stringify(s)).not.toContain('secret-key-123');
    expect(s.settings.hasKey).toBe(true);
  });
});
