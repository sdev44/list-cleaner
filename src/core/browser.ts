// Headless browser fallback: reads a site as a visitor would, for sites that block plain requests
// (bot protection, incomplete certificate chains) or build their text with JavaScript.
// Replaces the extension's hidden browser tab. Uses the installed Google Chrome or Edge if present,
// else Playwright's own Chromium (npx playwright-core install chromium).
//
// Two tiers:
//  1. Headless Chrome (fast, up to 3 pages at once).
//  2. Only for sites that cut the connection on tier 1 (bot protection spotting headless Chrome):
//     a normal Chrome window parked off-screen, using HTTP/1.1, one page at a time. Started on first
//     need. Where no screen exists (servers), it falls back to headless with HTTP/1.1.
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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const BASE_ARGS = ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'];
/** Failures that suggest the site dropped an automated visitor, worth a second, more human attempt. */
const RETRYABLE = /ERR_HTTP2_PROTOCOL_ERROR|ERR_EMPTY_RESPONSE|ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_HTTP_RESPONSE_CODE_FAILURE|HTTP 403|HTTP 429/;

type Chromium = typeof import('playwright-core').chromium;
const CHANNELS = [['chrome', 'Google Chrome'], ['msedge', 'Microsoft Edge'], [undefined, 'Playwright Chromium']] as const;

async function launch(chromium: Chromium, headless: boolean, extraArgs: string[]): Promise<{ browser: Browser; name: string } | { error: string }> {
  const errors: string[] = [];
  for (const [channel, label] of CHANNELS) {
    try { return { browser: await chromium.launch({ headless, channel, args: [...BASE_ARGS, ...extraArgs] }), name: label }; }
    catch (e) { errors.push(`${label}: ${String((e as Error).message).split('\n')[0]}`); }
  }
  return { error: errors.join('\n  ') };
}

async function makeContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ userAgent: UA, locale: 'en-US', ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  // Look like an ordinary visitor's browser to simple bot checks.
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  // Text is all we need: skip images, fonts and media to save time and bandwidth.
  await context.route('**/*', route => ['image', 'font', 'media'].includes(route.request().resourceType()) ? route.abort() : route.continue());
  return context;
}

function slots(limit: number) {
  let inUse = 0;
  const waiters: (() => void)[] = [];
  return {
    take: async () => { if (inUse < limit) { inUse++; return; } await new Promise<void>(r => waiters.push(r)); },
    give: () => { const next = waiters.shift(); if (next) next(); else inUse--; }
  };
}

async function readWith(context: BrowserContext, url: string, timeout: number, settle: number): Promise<BrowserReadResult> {
  const page = await context.newPage().catch(() => null);
  try {
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
    const html = (await page.content()).slice(0, 1_500_000);
    return { page: { html, url: finalUrl }, status, error: navError || (status && status >= 400 ? `HTTP ${status}` : undefined) };
  } catch (e) { return { page: null, error: String((e as Error).message).split('\n')[0] }; }
  finally { await page?.close().catch(() => {}); }
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
    const http1 = ['--disable-http2'];
    const visible = await launch(chromium, false, [...http1, '--window-position=-32000,-32000', '--window-size=1280,900', '--start-minimized']);
    const got = 'error' in visible ? await launch(chromium, true, http1) : visible;
    if ('error' in got) return null;
    return { browser: got.browser, context: await makeContext(got.browser) };
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
      const s = await startSecond();
      if (!s) return result;
      await tier2.take();
      try {
        const retry = await readWith(s.context, url, timeout, settle + 1500);
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
