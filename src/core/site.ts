// Reading business websites on the server. Replaces the extension's fetch + hidden-tab reader.
import * as cheerio from 'cheerio';
import type { Link, Page, Row, SiteRead, WebsiteKind } from './types.js';

export const SOCIAL = /facebook\.com|fb\.com|instagram\.com|linkedin\.com|yelp\.com|google\.[a-z.]+\/|business\.site|nextdoor\.com|angi\.com|homeadvisor\.com|houzz\.com|bbb\.org|yellowpages\.com|tiktok\.com|youtube\.com|x\.com|twitter\.com/i;

export function websiteKind(url: unknown): WebsiteKind {
  const u = String(url || '').trim();
  if (!u) return 'none';
  if (SOCIAL.test(u)) return 'social';
  return 'site';
}

export function normaliseUrl(url: unknown): string {
  let u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  try { return new URL(u).href; } catch { return ''; }
}

/** Website hostname without www, or '' for none / social pages. */
export function siteHost(url: unknown): string {
  const u = String(url || '').trim();
  if (!u || SOCIAL.test(u)) return '';
  try { return new URL(/^https?:\/\//i.test(u) ? u : 'http://' + u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

/** Page HTML -> readable text (title | description | body) and its links. */
export function readPage(html: string, baseUrl: string): Page {
  const $ = cheerio.load(html);
  const title = $('title').first().text() || '';
  const desc = $('meta').filter((_, el) => String($(el).attr('name') || '').toLowerCase() === 'description').first().attr('content') || '';
  const links: Link[] = $('a[href]').toArray().map(a => ({ href: $(a).attr('href') || '', text: $(a).text() || '' }));
  $('script,style,noscript,svg,iframe,template').remove();
  // Keep words in neighbouring elements apart, as a browser's textContent would after layout.
  $('br,p,div,li,h1,h2,h3,h4,h5,h6,td,th,section,article,header,footer,nav,span,a').each((_, el) => { $(el).append(' '); });
  const body = $('body').text() || $.root().text() || '';
  const text = `${title} | ${desc} | ${body}`.replace(/\s+/g, ' ').trim();
  return {
    text,
    links: links.map(l => ({ href: l.href, text: l.text.replace(/\s+/g, ' ').trim() })).filter(l => l.href),
    base: baseUrl
  };
}

/** Same-site absolute URL for a link, or '' when it leaves the site or points back at the page. */
export function sameSiteUrl(link: Link, page: Page): string {
  try {
    const u = new URL(link.href, page.base);
    const host = (h: string) => h.replace(/^www\./, '');
    if (!/^https?:$/.test(u.protocol) || host(u.hostname) !== host(new URL(page.base).hostname)) return '';
    u.hash = '';
    return u.href === new URL(page.base).href ? '' : u.href;
  } catch { return ''; }
}

export interface FetchedPage { html: string; url: string }
export type FetchHtml = (url: string) => Promise<FetchedPage | null>;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

/** Plain HTTP fetch with timeout and size cap. Returns the page, or why it failed. */
export async function fetchDetailed(url: string): Promise<{ page: FetchedPage | null; error?: string }> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20000), redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-GB,en;q=0.9' }
    });
    if (!res.ok) return { page: null, error: `HTTP ${res.status}` + (res.headers.get('server') ? ` (${res.headers.get('server')})` : '') };
    const type = res.headers.get('content-type') || '';
    if (type && !/html|text/i.test(type)) return { page: null, error: 'Not a web page: ' + type.split(';')[0] };
    return { page: { html: (await res.text()).slice(0, 1_500_000), url: res.url || url } };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    if (err.name === 'TimeoutError') return { page: null, error: 'Timed out' };
    return { page: null, error: err.cause?.code || err.cause?.message || err.message };
  }
}

export const fetchHtml: FetchHtml = async (url) => (await fetchDetailed(url)).page;

/** Chooses one inner page worth reading after the homepage ('' = none). Supplied by the template. */
export type InnerPagePicker = (page: Page) => string;

/** Opens a page in a real (headless) browser. See browser.ts. */
export type BrowserRead = (url: string) => Promise<FetchedPage | null>;

/**
 * Reads a business's homepage and, if the template picks one, one inner page.
 * When the plain request fails or comes back nearly empty, and a browser is available, the page is
 * read in the browser instead (as the extension's hidden tab did).
 * Status strings match the extension so old and new results can be compared.
 */
export async function readSite(row: Row, pickInner: InnerPagePicker, fetcher: FetchHtml = fetchHtml, browser?: BrowserRead): Promise<SiteRead> {
  const kind = websiteKind(row.website);
  if (kind === 'none') return { ok: false, kind, status: 'No website', text: '' };
  if (kind === 'social') return { ok: false, kind, status: 'Social/listing page only', text: '' };
  const url = normaliseUrl(row.website);
  if (!url) return { ok: false, kind, status: 'Website address not valid', text: '' };
  let home = (await fetcher(url)) || (await fetcher(url.startsWith('https:') ? url.replace(/^https:/, 'http:') : url.replace(/^http:/, 'https:')));
  let viaBrowser = false;
  if (browser && (!home || readPage(home.html, home.url).text.length < 80)) {
    const seen = await browser(url);
    if (seen && (!home || readPage(seen.html, seen.url).text.length > readPage(home.html, home.url).text.length)) { home = seen; viaBrowser = true; }
  }
  if (!home) return { ok: false, kind, status: browser ? 'Website unreachable (also tried in a browser tab)' : 'Website unreachable', text: '' };
  const page = readPage(home.html, home.url);
  let text = page.text, status = viaBrowser ? 'Read homepage in a browser tab' : 'Read homepage';
  const inner = pickInner(page);
  if (inner) {
    const more = (await fetcher(inner)) || (viaBrowser && browser ? await browser(inner) : null);
    if (more) { text = readPage(more.html, more.url).text.slice(0, 4000) + ' || HOMEPAGE: ' + text; status += ' + ' + new URL(more.url).pathname; }
  }
  if (text.length < 80) return { ok: false, kind, status: 'Website has almost no readable text', text };
  return { ok: true, kind, status, text: text.slice(0, 9000) };
}
