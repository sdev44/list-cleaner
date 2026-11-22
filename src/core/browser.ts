// Headless browser fallback: reads a site as a visitor would, for sites that block plain requests
// (bot protection, incomplete certificate chains) or build their text with JavaScript.
// Replaces the extension's hidden browser tab. Uses the installed Google Chrome or Edge if present,
// else Playwright's own Chromium (npx playwright-core install chromium).
//
// Two tiers:
//  1. Headless Chrome (fast, up to 3 pages at once).
//  2. Only for sites that cut the connection on tier 1: a normal Chrome window parked off-screen with
//     nothing altered (own user agent, no request interception), one page at a time. Started on first
//     need. Where no screen exists (servers), it falls back to headless.
import type { Browser, BrowserContext } from 'playwright-core';
import { readPage, type FetchedPage } from './site.js';

export interface BrowserReadResult { page: FetchedPage | null; error?: string; status?: number; tier?: 1 | 2 }

export interface BrowserReader {
  read(url: string): Promise<FetchedPage | null>;
  /** Same as read, but says why it failed and which tier read it. */
  readDetailed(url: string): Promise<BrowserReadResult>;
  close(): Promise<void>;
  /** Which browser was started, for logs. */
  name: string;
}

export interface BrowserOptions { concurrency?: number; timeoutMs?: number; settleMs?: number; /** Allow tier 2 (default true). */ retryVisible?: boolean }

/** A normal desktop Chrome user agent for the browser's real version (headless Chrome otherwise says "HeadlessChrome"). */
export function realUserAgent(version: string): string {
  const major = String(version).split('.')[0] || '142';
  const os = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
const BASE_ARGS = ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'];
/** Failures that suggest the site dropped an automated visitor, worth a second, more human attempt. */
const RETRYABLE = /ERR_HTTP2_PROTOCOL_ERROR|ERR_EMPTY_RESPONSE|ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_HTTP_RESPONSE_CODE_FAILURE|HTTP 403|HTTP 429/;

type Chromium = typeof import('playwright-core').chromium;
const CHANNELS = [['chrome', 'Google Chrome'], ['msedge', 'Microsoft Edge'], [undefined, 'Playwright Chromium']] as const;

export async function launch(chromium: Chromium, headless: boolean, extraArgs: string[]): Promise<{ browser: Browser; name: string } | { error: string }> {
  const errors: string[] = [];
  for (const [channel, label] of CHANNELS) {
    try { return { browser: await chromium.launch({ headless, channel, args: [...BASE_ARGS, ...extraArgs] }), name: label }; }
    catch (e) { errors.push(`${label}: ${String((e as Error).message).split('\n')[0]}`); }
  }
  return { error: errors.join('\n  ') };
}

export interface ContextStyle {
  /** Replace "HeadlessChrome" with the browser's real version (headless only). */
  fixUserAgent?: boolean;
  /** Skip images/fonts/media (faster, but request interception is detectable). */
  blockMedia?: boolean;
  /** Hide navigator.webdriver. */
  hideWebdriver?: boolean;
}

export async function makeContext(browser: Browser, style: ContextStyle = { fixUserAgent: true, blockMedia: true, hideWebdriver: true }): Promise<BrowserContext> {
  const context = await browser.newContext({
    ...(style.fixUserAgent ? { userAgent: realUserAgent(browser.version()) } : {}),
    locale: 'en-US', ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }
  });
  if (style.hideWebdriver) await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  if (style.blockMedia) await context.route('**/*', route => ['image', 'font', 'media'].includes(route.request().resourceType()) ? route.abort() : route.continue());
  return context;
}

/** Resolves with `fallback` if `work` takes longer than `ms`. */
function withTimeout<T>(work: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([work, new Promise<T>(r => { timer = setTimeout(() => r(fallback()), ms); })]).finally(() => clearTimeout(timer));
}

function slots(limit: number) {
  let inUse = 0;
  const waiters: (() => void)[] = [];
  return {
    take: async () => { if (inUse < limit) { inUse++; return; } await new Promise<void>(r => waiters.push(r)); },
    give: () => { const next = waiters.shift(); if (next) next(); else inUse--; }
  };
}

/**
 * Reads one page. Every step has a time limit, and the whole read is capped, so a page that hangs
 * (endless scripts, a stuck renderer) can never stall a run. A stuck tab is closed in the background.
 */
export async function readWith(context: BrowserContext, url: string, timeout: number, settle: number): Promise<BrowserReadResult> {
  let page: import('playwright-core').Page | null = null;
  const work = (async (): Promise<BrowserReadResult> => {
    page = await context.newPage().catch(() => null);
    if (!page) return { page: null, error: 'Could not open a tab' };
    let status: number | undefined, navError = '';
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      status = res?.status();
    } catch (e) {
      // Keep going if something loaded (slow pages can time out after drawing their text).
      navError = String((e as Error).message).split('\n')[0].replace(/^page\.goto: /, '').replace(/ at https?:\/\/\S+/, '');
    }
    await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(settle); // let the page finish drawing its text (and pass bot checks)
    const finalUrl = page.url();
    if (!/^https?:/.test(finalUrl)) return { page: null, error: navError || 'Did not load', status };
    // Like the extension's tab, use whatever the page shows, even on an error status:
    // some sites send 404/406/503 while still showing their normal content. The caller checks the text.
    const html = await withTimeout(page.content(), 10000, () => '');
    if (!html) return { page: null, error: 'Page did not respond', status };
    return { page: { html: html.slice(0, 1_500_000), url: finalUrl }, status, error: navError || (status && status >= 400 ? `HTTP ${status}` : undefined) };
  })().catch(e => ({ page: null, error: String((e as Error).message).split('\n')[0] }) as BrowserReadResult);
  const result = await withTimeout(work, timeout + settle + 25000, () => ({ page: null, error: 'Browser read took too long' }));
  // Never wait long for a tab to close: a hung tab is left to the browser to clean up.
  const p = page as import('playwright-core').Page | null;
  if (p) await withTimeout(p.close({ runBeforeUnload: false }).catch(() => {}), 5000, () => undefined);
  return result;
}

/** Starts a headless browser, or returns null (with the reason) when none is available. */
export async function createBrowserReader(opts: BrowserOptions = {}): Promise<{ reader: BrowserReader | null; error?: string }> {
  let chromium: Chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch { return { reader: null, error: 'playwright-core is not installed (run npm install).' }; }

  const first = await launch(chromium, true, []);
  if ('error' in first) return { reader: null, error: 'No browser could be started. Install Google Chrome, or run: npx playwright-core install chromium\n  ' + first.error };
  const context = await makeContext(first.browser);
  const timeout = opts.timeoutMs ?? 25000, settle = opts.settleMs ?? 2500;
  const tier1 = slots(Math.max(1, opts.concurrency ?? 3)), tier2 = slots(1);

  // Tier 2 starts on first need.
  let second: Promise<{ browser: Browser; context: BrowserContext } | null> | null = null;
  const startSecond = () => second ||= (async () => {
    const visible = await launch(chromium, false, ['--window-position=-32000,-32000', '--window-size=1280,900']);
    if (!('error' in visible)) return { browser: visible.browser, context: await makeContext(visible.browser, { hideWebdriver: true }) };
    const headless = await launch(chromium, true, []);
    return 'error' in headless ? null : { browser: headless.browser, context: await makeContext(headless.browser, { fixUserAgent: true, hideWebdriver: true }) };
  })();

  const reader: BrowserReader = {
    name: first.name,
    async read(url) { return (await reader.readDetailed(url)).page; },
    async readDetailed(url) {
      await tier1.take();
      let result: BrowserReadResult;
      try { result = { ...(await readWith(context, url, timeout, settle)), tier: 1 }; }
      finally { tier1.give(); }
      if (opts.retryVisible === false || !RETRYABLE.test(result.error || '')) return result;
      const s = await withTimeout(startSecond(), 30000, () => null);
      if (!s) return result;
      await tier2.take();
      try {
        const retry = await readWith(s.context, url, timeout, settle + 1500);
        // (tier 2 loads images too, so it is slower; it only runs for sites that cut tier 1 off)
        // Keep whichever attempt shows more text; report both failures if neither loaded.
        const len = (r: BrowserReadResult) => r.page ? readPage(r.page.html, r.page.url).text.length : -1;
        if (retry.page && len(retry) >= len(result)) return { ...retry, tier: 2 };
        return result.page ? result : { ...result, error: `${result.error}; retry: ${retry.error}` };
      } finally { tier2.give(); }
    },
    async close() {
      await context.close().catch(() => {}); await first.browser.close().catch(() => {});
      const s = second && await second.catch(() => null);
      if (s) { await s.context.close().catch(() => {}); await s.browser.close().catch(() => {}); }
    }
  };
  return { reader };
}
