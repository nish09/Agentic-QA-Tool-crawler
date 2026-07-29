import { chromium, Browser, Page } from 'playwright';

export interface LocatorResult {
  uid: string;
  elType: string;
  description: string;
  playwright: string[];
  selenium: string[];
}

// ─── Kept-alive scan session ───────────────────────────────────────────────────
// The dashboard can't show a live, interactive browser tab the way the Chrome
// extension can (this runs headless, often inside Docker with no display). To
// still support "hover a locator, see it highlighted on the page", the scanned
// page is kept open after scanLocators() returns, and highlightLocatorOnPage()
// re-visits it on demand to highlight + screenshot just that element. Each new
// scan replaces (closes) the previous session — this is a single-user local
// dashboard, so one active session at a time is sufficient.
let activeBrowser: Browser | null = null;
let activePage: Page | null = null;

async function closeActiveSession(): Promise<void> {
  if (activeBrowser) await activeBrowser.close().catch(() => {});
  activeBrowser = null;
  activePage = null;
}

/**
 * Navigates to `url` with a headless browser and returns Playwright + Selenium
 * locators for every interactive element found on the page.
 * The scanning logic is ported from the Chrome extension's content.ts and runs
 * inside the browser via page.evaluate().
 */
export async function scanLocators(url: string): Promise<LocatorResult[]> {
  await closeActiveSession();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  activeBrowser = browser;
  activePage = page;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    try { await page.waitForLoadState('networkidle', { timeout: 5_000 }); } catch { /* ok */ }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results: LocatorResult[] = await page.evaluate((): any[] => {
      function escLoc(s: string): string { return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
      function escDbl(s: string): string  { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
      function visText(el: Element): string {
        return (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
      }

      function ariaRole(el: Element): string {
        const r = el.getAttribute('role');
        if (r) return r.toLowerCase();
        const tag = el.tagName.toLowerCase();
        const t   = (el.getAttribute('type') ?? '').toLowerCase();
        if (tag === 'button') return 'button';
        if (tag === 'a' && el.hasAttribute('href')) return 'link';
        if (tag === 'input') {
          if (['button','submit','reset','image'].includes(t)) return 'button';
          if (t === 'checkbox') return 'checkbox';
          if (t === 'radio')    return 'radio';
          return 'textbox';
        }
        if (tag === 'select')   return 'combobox';
        if (tag === 'textarea') return 'textbox';
        return '';
      }

      function accessibleName(el: Element): string {
        const al = el.getAttribute('aria-label')?.trim();
        if (al) return al;
        const lbId = el.getAttribute('aria-labelledby');
        if (lbId) { const t = document.getElementById(lbId)?.textContent?.trim(); if (t) return t; }
        const id = el.getAttribute('id');
        if (id) {
          try {
            const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (lbl) return (lbl.textContent ?? '').trim();
          } catch { /* ignore */ }
        }
        const pl = el.closest('label');
        if (pl) {
          const c = pl.cloneNode(true) as Element;
          c.querySelectorAll('input,select,textarea,button').forEach(x => x.remove());
          const t = (c.textContent ?? '').trim();
          if (t) return t;
        }
        const tag = el.tagName.toLowerCase();
        if (['button','a'].includes(tag)) return visText(el);
        return ((el as HTMLInputElement).value ?? '').trim() || (el.getAttribute('alt') ?? '').trim();
      }

      function assocLabel(el: Element): string {
        const id = el.getAttribute('id');
        if (id) {
          try {
            const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (lbl) return (lbl.textContent ?? '').replace(/\s+/g, ' ').trim();
          } catch { /* ignore */ }
        }
        const lbl = el.closest('label');
        if (lbl) {
          const c = lbl.cloneNode(true) as Element;
          c.querySelectorAll('input,select,textarea,button').forEach(x => x.remove());
          return (c.textContent ?? '').replace(/\s+/g, ' ').trim();
        }
        return '';
      }

      function cssSelector(el: Element): string {
        const tag = el.tagName.toLowerCase();
        if (el.id && /^[a-zA-Z_][\w-]*$/.test(el.id)) return `#${el.id}`;
        for (const a of ['data-testid','data-test-id','data-cy','data-qa','data-test']) {
          const v = el.getAttribute(a);
          if (v) return `[${a}="${escDbl(v)}"]`;
        }
        let sel = tag;
        const type = el.getAttribute('type');
        const name = el.getAttribute('name');
        const ph   = el.getAttribute('placeholder');
        const al   = el.getAttribute('aria-label');
        if (type) sel += `[type="${type}"]`;
        if (name) sel += `[name="${escDbl(name)}"]`;
        else if (ph) sel += `[placeholder="${escDbl(ph)}"]`;
        else if (al) sel += `[aria-label="${escDbl(al)}"]`;
        else {
          const cls = Array.from(el.classList).filter((c: string) => /^[a-zA-Z_][\w-]*$/.test(c) && !/\d{4,}/.test(c)).slice(0, 2);
          if (cls.length) sel += '.' + cls.join('.');
        }
        return sel;
      }

      function xpath(el: Element): string {
        const tag = el.tagName.toLowerCase();
        if (el.id) return `//${tag}[@id='${escLoc(el.id)}']`;
        const name = el.getAttribute('name');
        if (name) return `//${tag}[@name='${escLoc(name)}']`;
        const al = el.getAttribute('aria-label');
        if (al) return `//${tag}[@aria-label='${escLoc(al)}']`;
        if (['button','a'].includes(tag)) {
          const t = visText(el);
          if (t && t.length <= 50) return `//${tag}[normalize-space()='${escLoc(t)}']`;
        }
        const parts: string[] = [];
        let cur: Element | null = el;
        while (cur && cur.tagName !== 'HTML') {
          const t2 = cur.tagName.toLowerCase();
          const p: Element | null = cur.parentElement;
          const sibs: Element[] = p ? Array.from(p.children as HTMLCollectionOf<Element>).filter((c: Element) => c.tagName === cur!.tagName) : [];
          parts.unshift(sibs.length > 1 ? `${t2}[${sibs.indexOf(cur) + 1}]` : t2);
          cur = p;
        }
        return '/' + parts.join('/');
      }

      function pwLocators(el: Element): string[] {
        const tag = el.tagName.toLowerCase();
        const out: Array<{c: string; p: number}> = [];
        for (const a of ['data-testid','data-test-id','data-cy','data-qa','data-test']) {
          const v = el.getAttribute(a);
          if (v) { out.push({ c: `page.getByTestId('${escLoc(v)}')`, p: 1 }); break; }
        }
        const role = ariaRole(el);
        const name = accessibleName(el);
        if (role && name)  out.push({ c: `page.getByRole('${role}', { name: '${escLoc(name)}' })`, p: 2 });
        else if (role)     out.push({ c: `page.getByRole('${role}')`, p: 7 });
        const lbl = assocLabel(el);
        if (lbl && ['input','select','textarea'].includes(tag)) out.push({ c: `page.getByLabel('${escLoc(lbl)}')`, p: 3 });
        const ph = el.getAttribute('placeholder');
        if (ph)  out.push({ c: `page.getByPlaceholder('${escLoc(ph)}')`, p: 4 });
        const alt = el.getAttribute('alt');
        if (alt) out.push({ c: `page.getByAltText('${escLoc(alt)}')`, p: 4 });
        const title = el.getAttribute('title');
        if (title) out.push({ c: `page.getByTitle('${escLoc(title)}')`, p: 5 });
        if (['button','a'].includes(tag)) {
          const t = visText(el);
          if (t && t.length <= 50) out.push({ c: `page.getByText('${escLoc(t)}', { exact: true })`, p: 6 });
        }
        if (el.id && /^[a-zA-Z_][\w-]*$/.test(el.id)) out.push({ c: `page.locator('#${el.id}')`, p: 7 });
        const css = cssSelector(el);
        if (!css.startsWith('#')) out.push({ c: `page.locator('${css}')`, p: 8 });
        const seen = new Set<string>();
        return out.sort((a,b)=>a.p-b.p).filter(l=>{ if(seen.has(l.c))return false; seen.add(l.c); return true; }).map(l=>l.c);
      }

      function seLocators(el: Element): string[] {
        const tag = el.tagName.toLowerCase();
        const out: Array<{c: string; p: number}> = [];
        const id = el.id;
        if (id) out.push({ c: `By.id("${escDbl(id)}")`, p: 1 });
        const name = el.getAttribute('name');
        if (name) out.push({ c: `By.name("${escDbl(name)}")`, p: 2 });
        if (id && /^[a-zA-Z_][\w-]*$/.test(id)) out.push({ c: `By.cssSelector("#${id}")`, p: 3 });
        if (tag === 'a') {
          const lt = visText(el);
          if (lt && lt.length <= 60) out.push({ c: `By.linkText("${escDbl(lt)}")`, p: 3 });
        }
        const css = cssSelector(el);
        out.push({ c: `By.cssSelector("${css}")`, p: id ? 5 : 2 });
        out.push({ c: `By.xpath("${xpath(el)}")`, p: 6 });
        const seen = new Set<string>();
        return out.sort((a,b)=>a.p-b.p).filter(l=>{ if(seen.has(l.c))return false; seen.add(l.c); return true; }).map(l=>l.c);
      }

      function elType(el: Element): string {
        const tag  = el.tagName.toLowerCase();
        const t    = (el.getAttribute('type') ?? '').toLowerCase();
        const role = (el.getAttribute('role') ?? '').toLowerCase();
        if (tag==='button'||t==='button'||t==='submit'||t==='reset'||role==='button') return 'button';
        if (tag==='a'||role==='link') return 'link';
        if (t==='checkbox'||role==='checkbox'||role==='switch') return 'checkbox';
        if (t==='radio'||role==='radio') return 'radio';
        if (tag==='select'||role==='combobox'||role==='listbox') return 'select';
        if (tag==='textarea') return 'textarea';
        if (tag==='input') return 'input';
        return 'custom';
      }

      const SEL = [
        'button:not([disabled])','a[href]',
        'input:not([type="hidden"]):not([disabled])',
        'select:not([disabled])','textarea:not([disabled])',
        '[role="button"]:not(button)','[role="link"]:not(a)',
        '[role="checkbox"]:not(input)','[role="radio"]:not(input)',
        '[role="tab"]','[role="switch"]','[role="menuitem"]',
      ].join(',');

      const elements = Array.from(document.querySelectorAll(SEL)).slice(0, 200);
      const results: unknown[] = [];
      const seen = new Set<Element>();

      elements.forEach((el, i) => {
        if (seen.has(el)) return;
        seen.add(el);
        const htmlEl = el as HTMLElement;
        if (!htmlEl.offsetParent && htmlEl.offsetHeight === 0 && htmlEl.offsetWidth === 0) return;
        const name = accessibleName(el);
        const ph   = el.getAttribute('placeholder') ?? '';
        const id   = el.id ? `#${el.id}` : '';
        const desc = (name || ph || id || `${el.tagName.toLowerCase()}[${i}]`).slice(0, 60);
        const uid = `loc-${i}`;
        // Tag the live element so highlightLocatorOnPage() can re-select it later
        // for hover-to-highlight, without needing to hand a live handle across
        // the JS/Node boundary (page.evaluate can only return serializable data).
        el.setAttribute('data-qalens-uid', uid);
        results.push({
          uid,
          elType: elType(el),
          description: desc,
          playwright: pwLocators(el),
          selenium: seLocators(el),
        });
      });

      return results;
    });

    return results as LocatorResult[];
  } catch (e) {
    await closeActiveSession();
    throw e;
  }
}

/**
 * Highlights the element tagged with `uid` on the still-open scan session's
 * page, scrolls it into view, and returns a screenshot (base64 JPEG) so the
 * dashboard can show it as a live preview — the headless-friendly equivalent
 * of the Chrome extension's hover-to-highlight. Returns null if there's no
 * active session (no scan run yet, or it was replaced by a newer one) or the
 * element can no longer be found (page navigated/changed since the scan).
 */
export async function highlightLocatorOnPage(uid: string): Promise<string | null> {
  if (!activePage) return null;

  try {
    const found = await activePage.evaluate((targetUid: string) => {
      document.querySelectorAll('.__qalens_hl').forEach(e => e.classList.remove('__qalens_hl'));
      if (!document.getElementById('__qalens_hl_style')) {
        const style = document.createElement('style');
        style.id = '__qalens_hl_style';
        style.textContent = '.__qalens_hl{outline:3px solid #7c3aed !important;outline-offset:2px !important;background-color:rgba(124,58,237,.15) !important;}';
        document.head.appendChild(style);
      }
      const el = document.querySelector(`[data-qalens-uid="${targetUid}"]`);
      if (!el) return false;
      el.classList.add('__qalens_hl');
      el.scrollIntoView({ block: 'center', inline: 'center' });
      return true;
    }, uid);

    if (!found) return null;

    await activePage.waitForTimeout(120); // let the scroll/highlight paint settle
    const buf = await activePage.screenshot({ type: 'jpeg', quality: 60 });
    return buf.toString('base64');
  } catch {
    return null;
  }
}
