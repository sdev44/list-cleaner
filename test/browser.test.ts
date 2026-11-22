// Headless fallback against a local test server. Skipped when no browser can be started.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createBrowserReader, type BrowserReader } from '../src/core/browser.js';
import { readSite } from '../src/core/site.js';

let server: Server, base = '', reader: BrowserReader | null = null, flakyDrops = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const ua = String(req.headers['user-agent'] || '');
    if (req.url === '/js') {
      // Text only appears after JavaScript runs (like Wix / site-builder pages).
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>Cat Cans</title></head><body><div id="app"></div><script>document.getElementById("app").innerText = "We install concrete storm shelters and septic tanks across Manhattan, Kansas. Call today for a free quote on your tornado shelter.";</script></body></html>');
    } else if (req.url === '/blocked') {
      // Refuses plain requests, like bot protection; a real browser gets through.
      if (!/HeadlessChrome|Chrome/.test(ua) || !req.headers['sec-ch-ua']) { res.writeHead(403); res.end('Forbidden'); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><p>' + 'Safe rooms built to FEMA P-361 for homes and schools across Kansas. '.repeat(3) + '</p></body></html>');
    } else if (req.url === '/flaky') {
      // Drops the first visits (like bot protection cutting off headless Chrome), serves the next.
      if (flakyDrops < 3) { flakyDrops++; req.socket.destroy(); return; } // Chrome retries a dropped request itself
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><p>' + 'Atlas safe rooms: above-ground tornado shelters installed in your garage. '.repeat(3) + '</p></body></html>');
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  reader = (await createBrowserReader({ concurrency: 2, settleMs: 300 })).reader;
}, 60000);

afterAll(async () => { await reader?.close(); server.close(); });

describe('headless browser fallback', () => {
  it('reads text built with JavaScript', async (ctx) => {
    if (!reader) return ctx.skip();
    const plain = await readSite({ website: base + '/js' }, () => '');
    expect(plain.status).toBe('Website has almost no readable text');
    const seen = await readSite({ website: base + '/js' }, () => '', undefined, u => reader!.read(u));
    expect(seen.status).toBe('Read homepage in a browser tab');
    expect(seen.text).toContain('concrete storm shelters');
  }, 60000);

  it('gets past sites that refuse plain requests', async (ctx) => {
    if (!reader) return ctx.skip();
    expect((await readSite({ website: base + '/blocked' }, () => '')).status).toBe('Website unreachable');
    const seen = await readSite({ website: base + '/blocked' }, () => '', undefined, u => reader!.read(u));
    expect(seen.ok).toBe(true);
    expect(seen.text).toContain('FEMA P-361');
  }, 60000);

  it('retries a site that cut off the first visit', async (ctx) => {
    if (!reader) return ctx.skip();
    const seen = await reader.readDetailed(base + '/flaky');
    expect(seen.tier).toBe(2);
    expect(seen.page?.html).toContain('tornado shelters');
  }, 90000);

  it('reports a site that is down even in the browser', async (ctx) => {
    if (!reader) return ctx.skip();
    const seen = await readSite({ website: base + '/missing' }, () => '', undefined, u => reader!.read(u));
    expect(seen.status).toBe('Website unreachable (also tried in a browser tab)');
  }, 60000);
});
