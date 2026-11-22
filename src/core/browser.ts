// Headless browser fallback: reads a site as a visitor would, for sites that block plain requests
// (bot protection, incomplete certificate chains) or build their text with JavaScript.
// Replaces the extension's hidden browser tab. Uses the installed Google Chrome or Edge if present,
// else Playwright's own Chromium (npx playwright-core install chromium).
import type { FetchedPage } from './site.js';

export interface BrowserReader {
  read(url: string): Promise<FetchedPage | null>;
  /** Same as read, but says why it failed. */
  readDetailed(url: string): Promise<{ page: FetchedPage | null; error?: string; status?: number }>;
  close(): Promise<void>;
  /** Which browser was started, for logs. */
  name: string;
}

export interface BrowserOptions { concurrency?: number; timeoutMs?: number; settleMs?: number }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

/** Starts a headless browser, or returns null (with the reason) when none is available. */
export async function createBrowserReader(opts: BrowserOptions = {}): Promise<{ reader: BrowserReader | null; error?: string }> {
  let chromium: typeof import('playwright-core').chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch { return { reader: null, error: 'playwright-core is not installed (run npm install).' }; }

  let browser: import('playwright-core').Browser | null = null, name = '';
  const errors: string[] = [];
  for (const [channel, label] of [['chrome', 'Google Chrome'], ['msedge', 'Microsoft Edge'], [undefined, 'Playwright Chromium']] as const) {
    try {
      browser = await chromium.launch({ headless: true, channel, args: ['--disable-blink-features=AutomationControlled', '--no-first-run'] });
      name = label; break;
    }
    catch (e) { errors.push(`${label}: ${String((e as Error).message).split('\n')[0]}`); }
  }
  if (!browser) return { reader: null, error: 'No browser could be started. Install Google Chrome, or run: npx playwright-core install chromium\n  ' + errors.join('\n  ') };

  const context = await browser.newContext({ userAgent: UA, locale: 'en-US', ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  // Look like an ordinary visitor's browser to simple bot checks.
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  // Text is all we need: skip images, fonts and media to save time and bandwidth.
  await context.route('**/*', route => ['image', 'font', 'media'].includes(route.request().resourceType()) ? route.abort() : route.continue());

  const limit = Math.max(1, opts.concurrency ?? 3), timeout = opts.timeoutMs ?? 25000, settle = opts.settleMs ?? 2500;
  let inUse = 0;
  const waiters: (() => void)[] = [];
  const take = async () => { if (inUse < limit) { inUse++; return; } await new Promise<void>(r => waiters.push(r)); };
  const give = () => { const next = waiters.shift(); if (next) next(); else inUse--; };

  const reader: BrowserReader = {
    name,
    async read(url) { return (await reader.readDetailed(url)).page; },
    async readDetailed(url) {
      await take();
      const page = await context.newPage().catch(() => null);
      try {
        if (!page) return { page: null, error: 'Could not open a tab' };
        let status: number | undefined, navError = '';
        try {
          const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
          status = res?.status();
        } catch (e) {
          // Keep going if something loaded (slow pages can time out after drawing their text).
          navError = String((e as Error).message).split('\n')[0].replace(/^page\.goto: /, '');
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
      finally { await page?.close().catch(() => {}); give(); }
    },
    async close() { await context.close().catch(() => {}); await browser!.close().catch(() => {}); }
  };
  return { reader };
}
