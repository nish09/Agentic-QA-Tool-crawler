import { chromium } from 'playwright';
import type { CapturedAPICall, UIContext } from '@qalens/shared/types';
import { generateId, extractSchema } from '@qalens/shared/utils';

export interface CrawlOptions {
  url: string;
  maxPages?: number;
  timeoutMs?: number;
  headless?: boolean;
  onCall?: (call: CapturedAPICall) => void;
  onPageVisit?: (pageUrl: string, visited: number, queued: number) => void;
  onPageCaptured?: (page: CrawledPage) => void;
  onScreenshot?: (b64: string, pageUrl: string, pageIndex: number) => void;
}

export interface CrawledPage {
  index: number;
  url: string;
  title: string;
  dom: string;
  links: string[];
  elements: Record<string, string>[];
  timestamp: number;
}

export interface CrawlResult {
  calls: CapturedAPICall[];
  pagesVisited: string[];
  pages: CrawledPage[];
}

export async function crawl(options: CrawlOptions): Promise<CrawlResult> {
  const { url, maxPages = 10, timeoutMs = 30_000, headless = true, onCall, onPageVisit, onPageCaptured, onScreenshot } = options;

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (QALens-Agent/2.0) AppleWebKit/537.36',
  });
  const page = await context.newPage();

  const calls: CapturedAPICall[] = [];
  const pages: CrawledPage[] = [];
  const visited = new Set<string>();
  const queue: string[] = [url];
  const origin = new URL(url).origin;

  page.on('response', async (response) => {
    const req = response.request();
    if (req.resourceType() !== 'xhr' && req.resourceType() !== 'fetch') return;

    const uiContext: UIContext = { pageUrl: page.url(), triggerAction: 'load' };
    try { uiContext.pageTitle = await page.title(); } catch { /* navigated */ }

    const call: CapturedAPICall = {
      id: generateId(),
      timestamp: Date.now(),
      url: req.url(),
      method: req.method() as CapturedAPICall['method'],
      requestHeaders: req.headers(),
      requestPayload: (() => { try { return req.postDataJSON() ?? undefined; } catch { return undefined; } })(),
      responseStatus: response.status(),
      responseHeaders: response.headers(),
      uiContext,
    };

    try {
      const body: unknown = await response.json();
      call.responseBody = body;
      call.responseSchema = extractSchema(body);
    } catch { /* non-JSON — skip body */ }

    calls.push(call);
    onCall?.(call);
  });

  while (queue.length > 0 && visited.size < maxPages) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    console.log(`  → [${visited.size}/${maxPages}] ${current}`);
    onPageVisit?.(current, visited.size, queue.length);

    try {
      await page.goto(current, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      // Try to wait for network to settle (catches XHR on load), but never fail the page because of it
      try { await page.waitForLoadState('networkidle', { timeout: 5_000 }); } catch { /* ok */ }
    } catch { continue; }

    // ── Live preview screenshot ──────────────────────────────────────────────
    if (onScreenshot) {
      try {
        const buf = await page.screenshot({ type: 'jpeg', quality: 55, fullPage: false });
        onScreenshot(buf.toString('base64'), current, visited.size);
      } catch { /* screenshot failed — non-fatal */ }
    }

    // ── Capture DOM snapshot ─────────────────────────────────────────────────
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const snapshot = await page.evaluate((): any => {
        const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
          .map(a => a.href).filter(h => h.startsWith('http'));

        const elements = Array.from(document.querySelectorAll<HTMLElement>(
          'a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"]'
        )).slice(0, 300).map(el => {
          const tag = el.tagName.toLowerCase();
          const entry: Record<string, string> = {
            type: tag,
            text: (el.textContent ?? '').trim().slice(0, 120),
          };
          if (el.id) entry['id'] = el.id;
          const name = el.getAttribute('name');
          if (name) entry['name'] = name;
          const href = (el as HTMLAnchorElement).href;
          if (href) entry['href'] = href;
          const role = el.getAttribute('role');
          if (role) entry['role'] = role;
          const ph = el.getAttribute('placeholder');
          if (ph) entry['placeholder'] = ph;
          return entry;
        });

        const rawDom = document.documentElement.outerHTML;
        return {
          title: document.title,
          links: [...new Set(links)],
          elements,
          dom: rawDom.length > 2_000_000
            ? rawDom.slice(0, 2_000_000) + '<!-- DOM truncated by QALens -->'
            : rawDom,
        };
      });

      const crawledPage: CrawledPage = {
        index: pages.length + 1,
        url: current,
        title: (snapshot.title as string) ?? '',
        dom: (snapshot.dom as string) ?? '',
        links: (snapshot.links as string[]) ?? [],
        elements: (snapshot.elements as Record<string, string>[]) ?? [],
        timestamp: Date.now(),
      };
      pages.push(crawledPage);
      onPageCaptured?.(crawledPage);

      // Enqueue same-origin links discovered from this page
      for (const href of crawledPage.links) {
        try {
          const parsed = new URL(href);
          const clean  = parsed.origin + parsed.pathname;
          if (parsed.origin === origin && !visited.has(clean) && !queue.includes(clean)) {
            queue.push(clean);
          }
        } catch { /* invalid URL */ }
      }
    } catch { /* DOM capture failed — continue */ }

    // ── Click visible interactive elements to surface more API calls ─────────
    try {
      const targets = await page.$$('button:visible, [role="button"]:visible, [data-action]:visible');
      for (const el of targets.slice(0, 5)) {
        try {
          await el.click({ timeout: 1_500 });
          await page.waitForTimeout(600);
        } catch { /* not clickable */ }
      }
    } catch { /* element query failed */ }
  }

  await browser.close();
  return { calls, pagesVisited: Array.from(visited), pages };
}
