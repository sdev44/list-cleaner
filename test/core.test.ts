import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { areaCode, guessArea, inArea, rowArea, ukNation } from '../src/core/area.js';
import { tableToRows } from '../src/core/columns.js';
import { readTable, writeWorkbook } from '../src/core/io.js';
import { readPage, readSite, siteHost, websiteKind } from '../src/core/site.js';

describe('area', () => {
  it('reads area codes and names', () => {
    expect(areaCode('Kansas, USA')).toBe('KS');
    expect(areaCode('ks')).toBe('KS');
    expect(areaCode('United Kingdom')).toBe('UK');
    expect(areaCode('Narnia')).toBe('');
  });
  it('maps UK postcodes to nations', () => {
    expect(ukNation('1 High St, Belfast BT1 1AA')).toBe('NIR');
    expect(ukNation('Edinburgh EH1 1YZ')).toBe('SCT');
    expect(ukNation('Cardiff CF10 1AA')).toBe('WLS');
    expect(ukNation('Grimsby DN31 1HU')).toBe('ENG');
  });
  it('finds a row area from State or address', () => {
    expect(rowArea({ address: '608 Chestnut St, Burden, KS 67019, United States' })).toBe('KS');
    expect(rowArea({ state: 'Missouri' })).toBe('MO');
    expect(rowArea({ address: '' })).toBe('');
    expect(guessArea([{ state: 'KS' }, { state: 'KS' }, { state: 'MO' }])).toBe('KS');
  });
  it('counts no-address businesses found by area searches as in the area', () => {
    expect(inArea({ search_location: 'Kansas, USA; Abilene, Kansas, USA' }, 'KS')).toBe(true);
    expect(inArea({ search_location: 'Oklahoma, USA' }, 'KS')).toBe(false);
  });
});

describe('column mapping', () => {
  it('maps Outscraper headers', () => {
    const { rows, mapping } = tableToRows([
      ['name', 'site', 'full_address', 'category', 'type', 'phone', 'rating', 'reviews', 'business_status', 'place_id', 'google_id', 'query'],
      ['Acme Shelters', 'acme.com', '1 Main St, Wichita, KS 67202', 'Contractor', 'Contractor, Builder', '+1 316 555 0100', '4.8', '12', 'CLOSED_PERMANENTLY', 'ChIJ1', '0x1:0x2', 'storm shelters']
    ]);
    expect(mapping.byKey.website).toBe('site');
    expect(mapping.byKey.category).toBe('category');
    expect(rows[0].business_status).toBe('Permanently closed');
    expect(rows[0].search_term).toBe('storm shelters');
    expect(rowArea(rows[0])).toBe('KS');
  });
  it('maps Apify Google Maps scraper headers', () => {
    const { rows, mapping } = tableToRows([
      ['title', 'website', 'address', 'categoryName', 'phone', 'totalScore', 'reviewsCount', 'permanentlyClosed', 'placeId', 'url', 'searchString'],
      ['Bob’s Bunkers', 'https://bobs.example', '2 Oak Rd', 'Construction company', '555', '5', '3', 'false', 'ChIJ2', 'https://maps.google.com/?cid=1', 'bunker']
    ]);
    expect(mapping.byKey.name).toBe('title');
    expect(mapping.byKey.maps_url).toBe('url');
    expect(rows[0].business_status).toBe('');
    expect(rows[0].category).toBe('Construction company');
  });
  it('keeps unknown columns and drops old result columns', () => {
    const { rows, mapping } = tableToRows([['Business Name', 'Owner', 'Result', 'Reason'], ['A', 'Sam', 'Clean', 'x']]);
    expect(mapping.extras).toEqual(['Owner']);
    expect(rows[0]['extra:Owner']).toBe('Sam');
    expect(rows[0].Result).toBeUndefined();
  });
  it('lets overrides win', () => {
    const { mapping } = tableToRows([['Company', 'Company URL'], ['A', 'a.com']], { name: 'Company', website: 'Company URL' });
    expect(mapping.byKey.website).toBe('Company URL');
  });
});

describe('site reading', () => {
  it('classifies website kinds and hosts', () => {
    expect(websiteKind('')).toBe('none');
    expect(websiteKind('https://facebook.com/acme')).toBe('social');
    expect(websiteKind('acme.com')).toBe('site');
    expect(siteHost('https://www.Acme.com/x')).toBe('acme.com');
  });
  it('extracts readable text and links', () => {
    const page = readPage('<html><head><title>Acme</title><meta name="Description" content="We build shelters"><script>var x=1</script></head><body><ul><li>Storm</li><li>Shelters</li></ul><a href="/services">Our services</a></body></html>', 'https://acme.com/');
    expect(page.text).toContain('Acme | We build shelters |');
    expect(page.text).toContain('Storm Shelters');
    expect(page.text).not.toContain('var x');
    expect(page.links).toEqual([{ href: '/services', text: 'Our services' }]);
  });
  it('reads the homepage plus one inner page, and reports failures', async () => {
    const pages: Record<string, string> = {
      'http://acme.com/': '<title>Acme Builders</title><body>' + 'We are a family firm building garages and homes across Kansas. '.repeat(2) + '<a href="/services">Services</a></body>',
      'http://acme.com/services': '<body>Tornado shelter installation</body>'
    };
    const fetcher = async (u: string) => pages[u] ? { html: pages[u], url: u } : null;
    const read = await readSite({ website: 'acme.com' }, p => new URL('/services', p.base).href, fetcher);
    expect(read.ok).toBe(true);
    expect(read.status).toBe('Read homepage + /services');
    expect(read.text.startsWith('| | Tornado shelter installation')).toBe(true);
    // Two inner pages, and a long homepage keeps its footer.
    const long = { 'http://big.example/': '<body>' + 'Intro text about our family firm. '.repeat(300) + '<a href="/a">A</a><a href="/b">B</a><footer>We serve all of Kansas and Missouri.</footer></body>', 'http://big.example/a': '<body>Page A</body>', 'http://big.example/b': '<body>Page B</body>' } as Record<string, string>;
    const f2 = async (u: string) => long[u] ? { html: long[u], url: u } : null;
    const two = await readSite({ website: 'big.example' }, p => [new URL('/a', p.base).href, new URL('/b', p.base).href], f2);
    expect(two.status).toBe('Read homepage + /a + /b');
    expect(two.text).toContain('We serve all of Kansas');
    expect((await readSite({ website: 'gone.example' }, () => '', fetcher)).status).toBe('Website unreachable');
    expect((await readSite({ website: '' }, () => '', fetcher)).status).toBe('No website');
    expect((await readSite({ website: 'facebook.com/x' }, () => '', fetcher)).status).toBe('Social/listing page only');
  });
});

describe('workbook I/O', () => {
  it('round-trips a workbook with links and numbers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lc-'));
    const path = join(dir, 'out.xlsx');
    await writeWorkbook(path, [{ name: 'Clean', columns: [{ header: 'Business Name', width: 20 }, { header: 'Website', width: 20, link: true }, { header: 'Google Rating', width: 8, number: true }], rows: [['=Acme', 'https://acme.com', '4.5']] }]);
    const table = await readTable(path);
    expect(table[0]).toEqual(['Business Name', 'Website', 'Google Rating']);
    expect(table[1]).toEqual(['=Acme', 'https://acme.com', '4.5']);
  });
});
