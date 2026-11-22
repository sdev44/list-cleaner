// Headless browser fallback: reads a site as a visitor would, for sites that block plain requests
// (bot protection, incomplete certificate chains) or build their text with JavaScript.
// Replaces the extension's hidden browser tab. Uses the installed Google Chrome or Edge if present,
// else Playwright's own Chromium (npx playwright-core install chromium).
import type { FetchedPage } from './site.js';

export interface BrowserReader {
  read(url: string): Promise<FetchedPage | null>;
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
    try { browser = await chromium.launch({ headless: true, channel }); name = label; break; }
    catch (e) { errors.push(`${label}: ${String((e as Error).message).split('\n')[0]}`); }
  }
  if (!browser) return { reader: null, error: 'No browser could be started. Install Google Chrome, or run: npx playwright-core install chromium\n  ' + errors.join('\n  ') };

  const context = await browser.newContext({ userAgent: UA, locale: 'en-GB', ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  // Text is all we need: skip images, fonts and media to save time and bandwidth.
  await context.route('**/*', route => ['image', 'font', 'media'].includes(route.request().resourceType()) ? route.abort() : route.continue());

  const limit = Math.max(1, opts.concurrency ?? 3), timeout = opts.timeoutMs ?? 25000, settle = opts.settleMs ?? 2500;
  let inUse = 0;
  const waiters: (() => void)[] = [];
  const take = async () => { if (inUse < limit) { inUse++; return; } await new Promise<void>(r => waiters.push(r)); };
  const give = () => { const next = waiters.shift(); if (next) next(); else inUse--; };

  const reader: BrowserReader = {
    name,
    async read(url) {
      await take();
      const page = await context.newPage().catch(() => null);
      try {
        if (!page) return null;
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        if (res && res.status() >= 400 && res.status() !== 403 && res.status() !== 429) return null;
        await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(settle); // let the page finish drawing its text (and pass bot checks)
        const html = (await page.content()).slice(0, 1_500_000);
        const finalUrl = page.url();
        return /^https?:/.test(finalUrl) ? { html, url: finalUrl } : null;
      } catch { return null; }
      finally { await page?.close().catch(() => {}); give(); }
    },
    async close() { await context.close().catch(() => {}); await browser!.close().catch(() => {}); }
  };
  return { reader };
}
