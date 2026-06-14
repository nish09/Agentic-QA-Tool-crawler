/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	// The require scope
/******/ 	var __webpack_require__ = {};
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/make namespace object */
/******/ 	(() => {
/******/ 		// define __esModule on exports
/******/ 		__webpack_require__.r = (exports) => {
/******/ 			if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
/******/ 				Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 			}
/******/ 			Object.defineProperty(exports, '__esModule', { value: true });
/******/ 		};
/******/ 	})();
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};
/*!********************************!*\
  !*** ./src/content/content.ts ***!
  \********************************/
__webpack_require__.r(__webpack_exports__);
/**
 * content.ts — ISOLATED world content script.
 * 1. Tracks DOM interactions (click, input, scroll, load) for UIContext.
 * 2. Bridges postMessage from the MAIN-world interceptor.ts → service worker.
 */
let lastUIContext = {
    pageUrl: window.location.href,
    triggerAction: 'load',
};
function sendUIContext(context) {
    chrome.runtime.sendMessage({
        type: 'UI_CONTEXT_UPDATE',
        payload: context,
    }).catch(() => { });
}
function getDOMPath(el) {
    const parts = [];
    let current = el;
    while (current && current !== document.body) {
        let selector = current.tagName.toLowerCase();
        if (current.id) {
            selector += `#${current.id}`;
            parts.unshift(selector);
            break;
        }
        if (current.className) {
            selector += `.${[...current.classList].slice(0, 2).join('.')}`;
        }
        parts.unshift(selector);
        current = current.parentElement;
    }
    return parts.join(' > ');
}
// ─── UIContext tracking ───────────────────────────────────────────────────────
document.addEventListener('click', (e) => {
    const target = e.target;
    lastUIContext = {
        pageUrl: window.location.href,
        pageTitle: document.title,
        activeComponent: target.closest('[data-component]')?.getAttribute('data-component') ?? undefined,
        triggerElement: target.tagName.toLowerCase(),
        triggerAction: 'click',
        domPath: getDOMPath(target),
    };
    sendUIContext(lastUIContext);
}, true);
document.addEventListener('input', (e) => {
    const target = e.target;
    lastUIContext = {
        pageUrl: window.location.href,
        triggerElement: target.tagName.toLowerCase(),
        triggerAction: 'input',
        domPath: getDOMPath(target),
    };
    sendUIContext(lastUIContext);
}, true);
window.addEventListener('load', () => {
    lastUIContext = {
        pageUrl: window.location.href,
        pageTitle: document.title,
        triggerAction: 'load',
    };
    sendUIContext(lastUIContext);
});
// ─── postMessage bridge from MAIN world ──────────────────────────────────────
window.addEventListener('message', (event) => {
    if (event.source !== window)
        return;
    if (event.data?.__src !== 'api-mapper-interceptor')
        return;
    if (event.data?.type !== 'API_MAPPER_CALL')
        return;
    const raw = event.data.payload;
    chrome.runtime.sendMessage({
        type: 'API_CALL_CAPTURED',
        payload: {
            ...raw,
            pageUrl: window.location.href,
            pageTitle: document.title,
            triggerAction: lastUIContext.triggerAction ?? 'unknown',
            triggerElement: lastUIContext.triggerElement,
            domPath: lastUIContext.domPath,
            activeComponent: lastUIContext.activeComponent,
        },
    }).catch(() => { });
});
// ─── Hover-to-highlight ───────────────────────────────────────────────────────
// Maps uid strings to the actual DOM elements captured during the last scan.
// Cleared and rebuilt every time scanPageLocators() runs.
const locatorMap = new Map();
let _hlEl = null;
function injectHlStyle() {
    if (document.getElementById('__amhl_style__'))
        return;
    const s = document.createElement('style');
    s.id = '__amhl_style__';
    s.textContent =
        '.__amhl{outline:2px solid #4d9ef5!important;outline-offset:3px!important;' +
            'box-shadow:0 0 0 6px rgba(77,158,245,.22)!important;' +
            'background-color:rgba(77,158,245,.08)!important;}';
    (document.head ?? document.documentElement).appendChild(s);
}
function hlElement(uid) {
    clearHl();
    const el = locatorMap.get(uid);
    if (!el)
        return;
    injectHlStyle();
    el.classList.add('__amhl');
    _hlEl = el;
    const r = el.getBoundingClientRect();
    const inView = r.top >= 0 && r.bottom <= window.innerHeight &&
        r.left >= 0 && r.right <= window.innerWidth;
    if (!inView)
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
}
function clearHl() {
    if (_hlEl) {
        _hlEl.classList.remove('__amhl');
        _hlEl = null;
    }
}
function escLoc(s) {
    return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
function escLocDbl(s) {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function visibleText(el) {
    return (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
}
function getAriaRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit)
        return explicit.toLowerCase();
    const tag = el.tagName.toLowerCase();
    const t = (el.getAttribute('type') ?? '').toLowerCase();
    if (tag === 'button')
        return 'button';
    if (tag === 'a' && el.hasAttribute('href'))
        return 'link';
    if (tag === 'input') {
        if (['button', 'submit', 'reset', 'image'].includes(t))
            return 'button';
        if (t === 'checkbox')
            return 'checkbox';
        if (t === 'radio')
            return 'radio';
        if (t === 'search')
            return 'searchbox';
        return 'textbox';
    }
    if (tag === 'select')
        return 'combobox';
    if (tag === 'textarea')
        return 'textbox';
    return '';
}
function getAccessibleName(el) {
    const ariaLbl = el.getAttribute('aria-label')?.trim();
    if (ariaLbl)
        return ariaLbl;
    const lblId = el.getAttribute('aria-labelledby');
    if (lblId) {
        const t = document.getElementById(lblId)?.textContent?.trim();
        if (t)
            return t;
    }
    const id = el.getAttribute('id');
    if (id) {
        try {
            const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (lbl)
                return (lbl.textContent ?? '').trim();
        }
        catch { /* ignore invalid id */ }
    }
    const parentLbl = el.closest('label');
    if (parentLbl) {
        const clone = parentLbl.cloneNode(true);
        clone.querySelectorAll('input, select, textarea, button').forEach(c => c.remove());
        const t = (clone.textContent ?? '').trim();
        if (t)
            return t;
    }
    const tag = el.tagName.toLowerCase();
    if (['button', 'a'].includes(tag))
        return visibleText(el);
    const val = el.value?.trim();
    if (val)
        return val;
    return (el.getAttribute('alt') ?? '').trim();
}
function getAssociatedLabel(el) {
    const id = el.getAttribute('id');
    if (id) {
        try {
            const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (lbl)
                return (lbl.textContent ?? '').replace(/\s+/g, ' ').trim();
        }
        catch { /* ignore */ }
    }
    const lbl = el.closest('label');
    if (lbl) {
        const clone = lbl.cloneNode(true);
        clone.querySelectorAll('input, select, textarea, button').forEach(c => c.remove());
        return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
    }
    return '';
}
function buildCssSelector(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id;
    if (id && /^[a-zA-Z_][\w-]*$/.test(id))
        return `#${id}`;
    for (const attr of ['data-testid', 'data-test-id', 'data-cy', 'data-qa', 'data-test']) {
        const v = el.getAttribute(attr);
        if (v)
            return `[${attr}="${escLocDbl(v)}"]`;
    }
    let sel = tag;
    const type = el.getAttribute('type');
    const name = el.getAttribute('name');
    const ph = el.getAttribute('placeholder');
    const al = el.getAttribute('aria-label');
    if (type)
        sel += `[type="${type}"]`;
    if (name)
        sel += `[name="${escLocDbl(name)}"]`;
    else if (ph)
        sel += `[placeholder="${escLocDbl(ph)}"]`;
    else if (al)
        sel += `[aria-label="${escLocDbl(al)}"]`;
    else {
        const cls = [...el.classList]
            .filter(c => /^[a-zA-Z_][\w-]*$/.test(c) && !/\d{4,}/.test(c))
            .slice(0, 2);
        if (cls.length)
            sel += '.' + cls.join('.');
    }
    return sel;
}
function buildXPath(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id)
        return `//${tag}[@id='${escLoc(el.id)}']`;
    const name = el.getAttribute('name');
    if (name)
        return `//${tag}[@name='${escLoc(name)}']`;
    const al = el.getAttribute('aria-label');
    if (al)
        return `//${tag}[@aria-label='${escLoc(al)}']`;
    if (['button', 'a'].includes(tag)) {
        const t = visibleText(el);
        if (t && t.length <= 50)
            return `//${tag}[normalize-space()='${escLoc(t)}']`;
    }
    // positional XPath fallback
    const parts = [];
    let cur = el;
    while (cur && cur.tagName !== 'HTML') {
        const t2 = cur.tagName.toLowerCase();
        const parent = cur.parentElement;
        const curTag = cur.tagName;
        const sibs = parent ? [...parent.children].filter(c => c.tagName === curTag) : [];
        parts.unshift(sibs.length > 1 ? `${t2}[${sibs.indexOf(cur) + 1}]` : t2);
        cur = parent;
    }
    return '/' + parts.join('/');
}
function generatePlaywrightLocators(el) {
    const tag = el.tagName.toLowerCase();
    const out = [];
    // 1. Test ID — most stable, explicit hook for testing
    for (const attr of ['data-testid', 'data-test-id', 'data-cy', 'data-qa', 'data-test']) {
        const v = el.getAttribute(attr);
        if (v) {
            out.push({ c: `page.getByTestId('${escLoc(v)}')`, p: 1 });
            break;
        }
    }
    // 2. ARIA role + accessible name (Playwright's preferred semantic approach)
    const role = getAriaRole(el);
    const aName = getAccessibleName(el);
    if (role && aName) {
        out.push({ c: `page.getByRole('${role}', { name: '${escLoc(aName)}' })`, p: 2 });
    }
    else if (role) {
        out.push({ c: `page.getByRole('${role}')`, p: 7 });
    }
    // 3. Associated label (form controls)
    const lbl = getAssociatedLabel(el);
    if (lbl && ['input', 'select', 'textarea'].includes(tag)) {
        out.push({ c: `page.getByLabel('${escLoc(lbl)}')`, p: 3 });
    }
    // 4. Placeholder
    const ph = el.getAttribute('placeholder');
    if (ph)
        out.push({ c: `page.getByPlaceholder('${escLoc(ph)}')`, p: 4 });
    // 5. Alt text (images)
    const alt = el.getAttribute('alt');
    if (alt)
        out.push({ c: `page.getByAltText('${escLoc(alt)}')`, p: 4 });
    // 6. Title attribute
    const title = el.getAttribute('title');
    if (title)
        out.push({ c: `page.getByTitle('${escLoc(title)}')`, p: 5 });
    // 7. Visible text (buttons/links — fragile elsewhere)
    if (['button', 'a'].includes(tag)) {
        const t = visibleText(el);
        if (t && t.length <= 50)
            out.push({ c: `page.getByText('${escLoc(t)}', { exact: true })`, p: 6 });
    }
    // 8. ID-based CSS
    if (el.id && /^[a-zA-Z_][\w-]*$/.test(el.id)) {
        out.push({ c: `page.locator('#${el.id}')`, p: 7 });
    }
    // 9. CSS selector fallback
    const css = buildCssSelector(el);
    if (!css.startsWith('#'))
        out.push({ c: `page.locator('${css}')`, p: 8 });
    const seen = new Set();
    return out
        .sort((a, b) => a.p - b.p)
        .filter(l => { if (seen.has(l.c))
        return false; seen.add(l.c); return true; })
        .map(l => l.c);
}
function generateSeleniumLocators(el) {
    const tag = el.tagName.toLowerCase();
    const out = [];
    const id = el.id;
    if (id)
        out.push({ c: `By.id("${escLocDbl(id)}")`, p: 1 });
    const name = el.getAttribute('name');
    if (name)
        out.push({ c: `By.name("${escLocDbl(name)}")`, p: 2 });
    if (id && /^[a-zA-Z_][\w-]*$/.test(id)) {
        out.push({ c: `By.cssSelector("#${id}")`, p: 3 });
    }
    if (tag === 'a') {
        const lt = visibleText(el);
        if (lt && lt.length <= 60)
            out.push({ c: `By.linkText("${escLocDbl(lt)}")`, p: 3 });
    }
    const css = buildCssSelector(el);
    out.push({ c: `By.cssSelector("${css}")`, p: id ? 5 : 2 });
    out.push({ c: `By.xpath("${buildXPath(el)}")`, p: 6 });
    const seen = new Set();
    return out
        .sort((a, b) => a.p - b.p)
        .filter(l => { if (seen.has(l.c))
        return false; seen.add(l.c); return true; })
        .map(l => l.c);
}
function getElType(el) {
    const tag = el.tagName.toLowerCase();
    const t = (el.getAttribute('type') ?? '').toLowerCase();
    const role = (el.getAttribute('role') ?? '').toLowerCase();
    if (tag === 'button' || t === 'button' || t === 'submit' || t === 'reset' || role === 'button')
        return 'button';
    if (tag === 'a' || role === 'link')
        return 'link';
    if (t === 'checkbox' || role === 'checkbox' || role === 'switch')
        return 'checkbox';
    if (t === 'radio' || role === 'radio')
        return 'radio';
    if (tag === 'select' || role === 'combobox' || role === 'listbox')
        return 'select';
    if (tag === 'textarea')
        return 'textarea';
    if (tag === 'input')
        return 'input';
    return 'custom';
}
function scanPageLocators() {
    clearHl();
    locatorMap.clear();
    const SEL = [
        'button:not([disabled])',
        'a[href]',
        'input:not([type="hidden"]):not([disabled])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        '[role="button"]:not(button)',
        '[role="link"]:not(a)',
        '[role="checkbox"]:not(input)',
        '[role="radio"]:not(input)',
        '[role="tab"]',
        '[role="switch"]',
        '[role="menuitem"]',
    ].join(',');
    const elements = [...document.querySelectorAll(SEL)].slice(0, 200);
    const results = [];
    const seen = new Set();
    elements.forEach((el, i) => {
        if (seen.has(el))
            return;
        seen.add(el);
        // Skip invisible elements
        const htmlEl = el;
        if (!htmlEl.offsetParent && htmlEl.offsetHeight === 0 && htmlEl.offsetWidth === 0)
            return;
        const name = getAccessibleName(el);
        const ph = el.getAttribute('placeholder') ?? '';
        const id = el.id ? `#${el.id}` : '';
        const desc = (name || ph || id || `${el.tagName.toLowerCase()}[${i}]`).slice(0, 60);
        const uid = `loc-${i}`;
        locatorMap.set(uid, el);
        results.push({
            uid,
            elType: getElType(el),
            description: desc,
            playwright: generatePlaywrightLocators(el),
            selenium: generateSeleniumLocators(el),
        });
    });
    return results;
}
// Handle scan + highlight requests from the popup (all synchronous)
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'SCAN_PAGE_LOCATORS') {
        try {
            sendResponse({ ok: true, locators: scanPageLocators() });
        }
        catch (e) {
            sendResponse({ ok: false, error: String(e) });
        }
        return false;
    }
    if (msg.type === 'HIGHLIGHT_LOCATOR') {
        hlElement(msg.uid);
        sendResponse({ ok: true });
        return false;
    }
    if (msg.type === 'CLEAR_HIGHLIGHT') {
        clearHl();
        sendResponse({ ok: true });
        return false;
    }
});


/******/ })()
;
//# sourceMappingURL=content.js.map