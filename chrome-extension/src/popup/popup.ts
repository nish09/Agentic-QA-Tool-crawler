/**
 * popup.ts — Extension side panel UI.
 * Two views:
 *   API Calls     — live capture list with detail panel, export
 *   Page Locators — on-demand DOM scan generating Playwright + Selenium locators
 */

// ─── Types ────────────────────────────────────────────────────────────────────

interface StoredCall {
  id?: string;
  method: string;
  url: string;
  requestHeaders?: Record<string, string>;
  requestBody?: unknown;
  responseStatus: number;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  triggerAction?: string;
  triggerElement?: string;
  domPath?: string;
  pageUrl?: string;
  pageTitle?: string;
  activeComponent?: string;
  timestamp: number;
}

interface LocatorResult {
  uid: string;
  localUid?: string; // original UID in the content script's locatorMap (for highlight messages)
  frameId?: number;  // which frame this element lives in
  elType: string;
  description: string;
  playwright: string[];
  selenium: string[];
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const pageHostEl        = document.getElementById('page-host')         as HTMLSpanElement;
const statusDotEl       = document.getElementById('status-dot')        as HTMLSpanElement;
const statCapturedNumEl = document.getElementById('stat-captured-num') as HTMLSpanElement;
const statDetectedNumEl = document.getElementById('stat-detected-num') as HTMLSpanElement;
const statMissedNumEl   = document.getElementById('stat-missed-num')   as HTMLSpanElement;
const statHostsNumEl    = document.getElementById('stat-hosts-num')    as HTMLSpanElement;
const endpointListEl    = document.getElementById('endpoint-list')     as HTMLDivElement;
const noDataEl       = document.getElementById('no-data')      as HTMLDivElement;
const toggleBtn      = document.getElementById('toggle-capture') as HTMLButtonElement;
const clearBtn       = document.getElementById('clear-all')    as HTMLButtonElement;
const exportCsvEl    = document.getElementById('export-csv')   as HTMLButtonElement;
const exportJsonEl   = document.getElementById('export-json')  as HTMLButtonElement;
const appEl          = document.getElementById('app')          as HTMLDivElement;
const apiViewEl      = document.getElementById('api-view')     as HTMLDivElement;

// Detail panel
const detailPanel  = document.getElementById('detail-panel')  as HTMLDivElement;
const detailMethod = document.getElementById('detail-method') as HTMLSpanElement;
const detailUrl    = document.getElementById('detail-url')    as HTMLSpanElement;
const closeDetail  = document.getElementById('close-detail')  as HTMLButtonElement;
const paneResponse = document.getElementById('pane-response') as HTMLDivElement;
const paneRequest  = document.getElementById('pane-request')  as HTMLDivElement;
const paneContext  = document.getElementById('pane-context')  as HTMLDivElement;
const responseBody = document.getElementById('response-body') as HTMLPreElement;
const reqMethod    = document.getElementById('req-method')    as HTMLTableCellElement;
const reqUrl       = document.getElementById('req-url')       as HTMLTableCellElement;
const reqStatus    = document.getElementById('req-status')    as HTMLTableCellElement;
const reqBodyEl    = document.getElementById('req-body')      as HTMLTableCellElement;
const reqHeaders   = document.getElementById('req-headers')   as HTMLPreElement;
const ctxTrigger   = document.getElementById('ctx-trigger')   as HTMLTableCellElement;
const ctxElement   = document.getElementById('ctx-element')   as HTMLTableCellElement;
const ctxDompath   = document.getElementById('ctx-dompath')   as HTMLTableCellElement;
const ctxPage      = document.getElementById('ctx-page')      as HTMLTableCellElement;
const ctxComponent = document.getElementById('ctx-component') as HTMLTableCellElement;

// Locators view
const locatorsViewEl = document.getElementById('locators-view') as HTMLDivElement;
const scanBtn        = document.getElementById('scan-btn')      as HTMLButtonElement;
const locStatusEl    = document.getElementById('loc-status')    as HTMLDivElement;
const locListEl      = document.getElementById('loc-list')      as HTMLDivElement;
const locEmptyEl     = document.getElementById('loc-empty')     as HTMLDivElement;
const fwSelectEl     = document.getElementById('fw-select')     as HTMLSelectElement;

// ─── State ────────────────────────────────────────────────────────────────────

let currentTabId: number | null = null;
let currentCalls: StoredCall[] = [];
let selectedIdx: number | null = null;
let isCapturing = true;
let detectedCount = 0;

let isSettled = false; // true when no new calls for SETTLE_MS after page load

let currentMode: 'api' | 'locators' = 'api';
let allLocators: LocatorResult[] = [];
let locatorFilter = 'all';
let locatorFramework = 'both';

let activeStatView: 'captured' | 'detected' | 'missed' | 'host' = 'captured';
let activeHostFilter: string | null = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  currentTabId = tab.id;

  if (tab.url) {
    try {
      pageHostEl.textContent = new URL(tab.url).hostname || tab.url;
      pageHostEl.title = tab.url;
    } catch {
      pageHostEl.textContent = tab.url;
    }
  }

  // Load capturing flag
  const flags = await chrome.storage.local.get('qalens_capturing') as Record<string, unknown>;
  isCapturing = flags['qalens_capturing'] !== false;
  updateStatusDot();

  await loadData(tab.id);

  // Switch data when the user changes tabs
  chrome.tabs.onActivated.addListener(async (info) => {
    currentTabId = info.tabId;
    selectedIdx = null;
    detectedCount = 0;
    currentCalls = [];
    allLocators = [];
    isSettled = false;
    activeStatView = 'captured';
    activeHostFilter = null;
    document.querySelectorAll('.stat-pill').forEach(p => p.classList.remove('active'));
    document.getElementById('stat-count')?.classList.add('active');
    hideDetail();

    const t = await chrome.tabs.get(info.tabId);
    if (t.url) {
      try {
        pageHostEl.textContent = new URL(t.url).hostname || t.url;
        pageHostEl.title = t.url;
      } catch {
        pageHostEl.textContent = t.url;
      }
    } else {
      pageHostEl.textContent = '—';
    }

    await loadData(info.tabId);

    // Reset locators view when switching tabs
    if (currentMode === 'locators') resetLocatorsView();
  });

  // Live updates while popup is open
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const captureKey  = `qalens_${currentTabId}`;
    const detectedKey = `qalens_detected_${currentTabId}`;
    const settledKey  = `qalens_settled_${currentTabId}`;

    if (changes[captureKey]) {
      currentCalls = (changes[captureKey].newValue as StoredCall[] | undefined) ?? [];
      renderList();
    }
    if (changes[detectedKey]) {
      detectedCount = (changes[detectedKey].newValue as number | undefined) ?? 0;
      updateVerification();
    }
    if (changes['qalens_capturing']) {
      isCapturing = changes['qalens_capturing'].newValue as boolean;
      updateStatusDot();
      updateToggleBtn();
    }
    if (changes[settledKey]) {
      isSettled = changes[settledKey].newValue === true;
      updateStatusDot();
      updateToggleBtn();
    }
  });
}

// ─── Data loading ─────────────────────────────────────────────────────────────

async function loadData(tabId: number): Promise<void> {
  const key        = `qalens_${tabId}`;
  const detKey     = `qalens_detected_${tabId}`;
  const settledKey = `qalens_settled_${tabId}`;
  const result = await chrome.storage.local.get([key, detKey, settledKey]) as Record<string, unknown>;
  currentCalls  = Array.isArray(result[key]) ? (result[key] as StoredCall[]) : [];
  detectedCount = typeof result[detKey] === 'number' ? (result[detKey] as number) : 0;
  isSettled     = result[settledKey] === true;
  renderList();
  updateStatusDot();
  updateToggleBtn();
}

// ─── Render API list ──────────────────────────────────────────────────────────

function updateVerification(): void {
  const missed = Math.max(0, detectedCount - currentCalls.length);
  statDetectedNumEl.textContent = String(detectedCount);
  statMissedNumEl.textContent   = String(missed);
  const missedBtn = document.getElementById('stat-missed');
  if (missedBtn) {
    if (missed > 0) {
      missedBtn.classList.remove('hidden');
      missedBtn.classList.add('warn');
    } else {
      missedBtn.classList.add('hidden');
      missedBtn.classList.remove('warn');
      if (activeStatView === 'missed') {
        activeStatView = 'captured';
        document.querySelectorAll('.stat-pill').forEach(p => p.classList.remove('active'));
        document.getElementById('stat-count')?.classList.add('active');
        renderStatView();
      }
    }
  }
}

function renderList(): void {
  const hosts = new Set(currentCalls.map(c => { try { return new URL(c.url).hostname; } catch { return '?'; } }));
  statCapturedNumEl.textContent = String(currentCalls.length);
  statHostsNumEl.textContent    = String(hosts.size);
  updateVerification();
  renderStatView();
}

function renderStatView(): void {
  switch (activeStatView) {
    case 'captured':
      renderCapturedList(null);
      break;
    case 'host':
      if (activeHostFilter) renderCapturedList(activeHostFilter);
      else renderHostBreakdown();
      break;
    case 'detected':
      renderEndpointSummary(
        currentCalls,
        `${currentCalls.length} of ${detectedCount} detected`
      );
      break;
    case 'missed': {
      const missed = Math.max(0, detectedCount - currentCalls.length);
      renderInfoPanel(
        missed > 0 ? `${missed} call${missed !== 1 ? 's' : ''} not captured` : 'All calls captured',
        missed > 0
          ? `${missed} request${missed !== 1 ? 's' : ''} were detected at the network layer but fired before the extension was ready — no endpoint details available.`
          : 'Every detected API call was successfully captured.',
        missed > 0 ? 'warn' : 'ok'
      );
      break;
    }
  }
}

function renderCapturedList(hostFilter: string | null): void {
  noDataEl.classList.add('hidden');
  [...endpointListEl.children].forEach(c => { if (c !== noDataEl) c.remove(); });

  const calls = hostFilter
    ? currentCalls.filter(c => { try { return new URL(c.url).hostname === hostFilter; } catch { return false; } })
    : currentCalls;

  if (hostFilter) {
    const crumb = document.createElement('div');
    crumb.className = 'host-crumb';
    crumb.innerHTML = `<button class="crumb-back">← Hosts</button><span>${escHtml(hostFilter)} · ${calls.length} call${calls.length !== 1 ? 's' : ''}</span>`;
    crumb.querySelector('.crumb-back')?.addEventListener('click', () => {
      activeHostFilter = null;
      renderStatView();
    });
    endpointListEl.appendChild(crumb);
  }

  if (calls.length === 0) {
    noDataEl.classList.remove('hidden');
    return;
  }

  const sorted = calls
    .map(c => ({ c, i: currentCalls.indexOf(c) }))
    .sort((a, b) => b.c.timestamp - a.c.timestamp);

  const fragment = document.createDocumentFragment();
  sorted.forEach(({ c, i }) => {
    const div = document.createElement('div');
    div.className = 'ep-row' + (selectedIdx === i ? ' selected' : '');
    div.dataset['idx'] = String(i);

    let path: string;
    try {
      const u = new URL(c.url);
      path = u.pathname + (u.search.length > 1 ? u.search.slice(0, 20) + (u.search.length > 20 ? '…' : '') : '');
    } catch { path = c.url; }
    if (path.length > 52) path = path.slice(0, 52) + '…';

    const sc = c.responseStatus;
    const scCls = sc >= 500 ? 'err' : sc >= 400 ? 'warn' : 'ok';
    const trig = c.triggerAction ?? 'unknown';
    const trigCls = ['load','click','input','scroll','hover'].includes(trig) ? trig : 'unknown';

    div.innerHTML = `
      <span class="method m-${c.method.toLowerCase()}">${c.method}</span>
      <span class="path" title="${escHtml(c.url)}">${escHtml(path)}</span>
      <span class="sc sc-${scCls}">${sc}</span>
      <span class="trig t-${trigCls}">${trigCls}</span>`;

    div.addEventListener('click', () => showDetail(i));
    fragment.appendChild(div);
  });

  endpointListEl.appendChild(fragment);
}

function renderHostBreakdown(): void {
  hideDetail();
  noDataEl.classList.add('hidden');
  [...endpointListEl.children].forEach(c => { if (c !== noDataEl) c.remove(); });

  if (currentCalls.length === 0) {
    noDataEl.classList.remove('hidden');
    return;
  }

  const hostMap = new Map<string, number>();
  currentCalls.forEach(c => {
    try { const h = new URL(c.url).hostname; hostMap.set(h, (hostMap.get(h) ?? 0) + 1); } catch { /* skip */ }
  });

  const fragment = document.createDocumentFragment();
  [...hostMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([host, count]) => {
      const row = document.createElement('div');
      row.className = 'host-row';
      row.innerHTML = `<span class="host-name">${escHtml(host)}</span><span class="host-count">${count} call${count !== 1 ? 's' : ''}</span>`;
      row.addEventListener('click', () => {
        activeHostFilter = host;
        renderStatView();
      });
      fragment.appendChild(row);
    });

  endpointListEl.appendChild(fragment);
}

function renderEndpointSummary(calls: StoredCall[], subtitle: string): void {
  hideDetail();
  noDataEl.classList.add('hidden');
  [...endpointListEl.children].forEach(c => { if (c !== noDataEl) c.remove(); });

  const header = document.createElement('div');
  header.className = 'summary-header';
  header.textContent = subtitle;
  endpointListEl.appendChild(header);

  if (calls.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'summary-empty';
    empty.textContent = 'No calls captured yet.';
    endpointListEl.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  [...calls].sort((a, b) => b.timestamp - a.timestamp).forEach(c => {
    const div = document.createElement('div');
    div.className = 'ep-row ep-readonly';

    let path: string;
    try {
      const u = new URL(c.url);
      path = u.pathname + (u.search.length > 1 ? u.search.slice(0, 20) + (u.search.length > 20 ? '…' : '') : '');
    } catch { path = c.url; }
    if (path.length > 52) path = path.slice(0, 52) + '…';

    const sc = c.responseStatus;
    const scCls = sc >= 500 ? 'err' : sc >= 400 ? 'warn' : 'ok';

    div.innerHTML = `
      <span class="method m-${c.method.toLowerCase()}">${c.method}</span>
      <span class="path" title="${escHtml(c.url)}">${escHtml(path)}</span>
      <span class="sc sc-${scCls}">${sc}</span>`;
    fragment.appendChild(div);
  });
  endpointListEl.appendChild(fragment);
}

function renderInfoPanel(title: string, body: string, type: 'info' | 'warn' | 'ok' = 'info'): void {
  hideDetail();
  noDataEl.classList.add('hidden');
  [...endpointListEl.children].forEach(c => { if (c !== noDataEl) c.remove(); });

  const panel = document.createElement('div');
  panel.className = `info-panel ip-${type}`;
  panel.innerHTML = `<strong class="ip-title">${escHtml(title)}</strong><p class="ip-body">${escHtml(body)}</p>`;
  endpointListEl.appendChild(panel);
}

// ─── Detail panel ─────────────────────────────────────────────────────────────

function showDetail(idx: number): void {
  const call = currentCalls[idx];
  if (!call) return;

  selectedIdx = idx;
  endpointListEl.querySelectorAll('.ep-row').forEach(r => {
    r.classList.toggle('selected', (r as HTMLElement).dataset['idx'] === String(idx));
  });

  detailMethod.textContent = call.method;
  detailMethod.className = `method m-${call.method.toLowerCase()}`;
  detailUrl.textContent = call.url;
  detailUrl.title = call.url;

  if (call.responseBody != null) {
    responseBody.textContent = typeof call.responseBody === 'string'
      ? call.responseBody
      : JSON.stringify(call.responseBody, null, 2);
  } else {
    responseBody.textContent = '(no body)';
  }

  reqMethod.textContent = call.method;
  reqUrl.textContent    = call.url;
  reqStatus.textContent = String(call.responseStatus);
  reqBodyEl.textContent = call.requestBody != null
    ? (typeof call.requestBody === 'string' ? call.requestBody : JSON.stringify(call.requestBody, null, 2))
    : '—';
  reqHeaders.textContent = call.requestHeaders
    ? Object.entries(call.requestHeaders).map(([k, v]) => `${k}: ${v}`).join('\n')
    : '—';

  const trig = call.triggerAction ?? 'unknown';
  const trigCls = ['load','click','input','scroll','hover'].includes(trig) ? trig : 'unknown';
  ctxTrigger.innerHTML   = `<span class="trig-badge t-${trigCls}">${trig}</span>`;
  ctxElement.textContent  = call.triggerElement ?? '—';
  ctxDompath.textContent  = call.domPath ?? '—';
  ctxPage.textContent     = call.pageUrl ?? '—';
  ctxComponent.textContent = call.activeComponent ?? '—';

  detailPanel.classList.remove('hidden');
  appEl.classList.add('detail-open');
  activateTab('response');
}

function hideDetail(): void {
  selectedIdx = null;
  detailPanel.classList.add('hidden');
  appEl.classList.remove('detail-open');
  endpointListEl.querySelectorAll('.ep-row').forEach(r => r.classList.remove('selected'));
}

// ─── API detail tabs ──────────────────────────────────────────────────────────

function activateTab(name: string): void {
  document.querySelectorAll('#detail-tabs .tab-btn').forEach(b => {
    b.classList.toggle('active', (b as HTMLElement).dataset['tab'] === name);
  });
  [paneResponse, paneRequest, paneContext].forEach(p => p.classList.add('hidden'));
  document.getElementById(`pane-${name}`)?.classList.remove('hidden');
}

document.querySelectorAll('#detail-tabs .tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    activateTab((btn as HTMLElement).dataset['tab'] ?? 'response');
  });
});

// ─── Mode switching ───────────────────────────────────────────────────────────

function switchMode(mode: 'api' | 'locators'): void {
  currentMode = mode;

  document.querySelectorAll('.mode-tab').forEach(btn => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset['mode'] === mode);
  });

  if (mode === 'api') {
    apiViewEl.classList.remove('hidden');
    locatorsViewEl.classList.add('hidden');
    if (currentTabId !== null) {
      // Clear highlight in every frame that was scanned
      const fids = new Set(allLocators.map(l => l.frameId ?? 0));
      if (fids.size === 0) fids.add(0);
      fids.forEach(fid =>
        chrome.tabs.sendMessage(currentTabId!, { type: 'CLEAR_HIGHLIGHT' }, { frameId: fid }).catch(() => {})
      );
    }
  } else {
    apiViewEl.classList.add('hidden');
    locatorsViewEl.classList.remove('hidden');
    hideDetail();
  }
}

document.querySelectorAll('.mode-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    switchMode((btn as HTMLElement).dataset['mode'] as 'api' | 'locators');
  });
});

// ─── Page Locators ────────────────────────────────────────────────────────────

function resetLocatorsView(): void {
  allLocators = [];
  locListEl.innerHTML = '';
  locListEl.appendChild(locEmptyEl);
  locStatusEl.classList.add('hidden');
  scanBtn.disabled = false;
  scanBtn.classList.remove('scanning');
  scanBtn.textContent = '⬡ Scan Page';
}

async function scanLocators(): Promise<void> {
  if (!currentTabId) return;

  scanBtn.disabled = true;
  scanBtn.classList.add('scanning');
  scanBtn.textContent = '⟳ Scanning…';
  locStatusEl.classList.add('hidden');

  try {
    // Collect results from ALL frames (top frame + iframes like embedded ATS forms)
    const frames = await chrome.webNavigation.getAllFrames({ tabId: currentTabId }) ?? [];
    const frameIds = frames.map(f => f.frameId);

    const perFrame = await Promise.allSettled(
      frameIds.map(frameId =>
        chrome.tabs.sendMessage(currentTabId!, { type: 'SCAN_PAGE_LOCATORS' }, { frameId })
          .then(r => ({ ...(r as { ok: boolean; locators?: LocatorResult[]; error?: string }), frameId }))
          .catch(() => ({ ok: false as const, locators: [] as LocatorResult[], frameId }))
      )
    );

    const merged: LocatorResult[] = [];
    let uidOffset = 0;
    for (const result of perFrame) {
      if (result.status === 'fulfilled' && result.value.ok && result.value.locators) {
        const { frameId } = result.value;
        // Preserve original UID as localUid so highlight messages use the right key
        const reindexed = result.value.locators.map((l, i) => ({
          ...l,
          uid: `loc-${uidOffset + i}`,
          localUid: l.uid,
          frameId,
        }));
        merged.push(...reindexed);
        uidOffset += result.value.locators.length;
      }
    }

    if (merged.length === 0) {
      locStatusEl.textContent = `No interactive elements found. Try reloading the page.`;
      locStatusEl.classList.remove('hidden');
      return;
    }

    allLocators = merged;
    renderLocators();
  } catch (e) {
    locStatusEl.textContent = `Could not reach page content script. Try reloading the page.`;
    locStatusEl.classList.remove('hidden');
  } finally {
    scanBtn.disabled = false;
    scanBtn.classList.remove('scanning');
    scanBtn.textContent = '⬡ Scan Page';
  }
}

function renderLocators(): void {
  const fw = fwSelectEl.value as 'both' | 'playwright' | 'selenium';
  locatorFramework = fw;

  // Apply type filter
  const typeMap: Record<string, string[]> = {
    button: ['button'],
    input:  ['input', 'checkbox', 'radio', 'select', 'textarea'],
    link:   ['link'],
  };
  const allowed = locatorFilter === 'all' ? null : (typeMap[locatorFilter] ?? null);
  const filtered = allowed
    ? allLocators.filter(l => allowed.includes(l.elType))
    : allLocators;

  // Status line
  const total = allLocators.length;
  const shown = filtered.length;
  locStatusEl.textContent = shown === total
    ? `${total} element${total !== 1 ? 's' : ''} found`
    : `${shown} of ${total} elements (filtered)`;
  locStatusEl.classList.remove('hidden');

  // Build list
  const fragment = document.createDocumentFragment();

  if (filtered.length === 0) {
    const msg = document.createElement('div');
    msg.style.cssText = 'padding:20px;text-align:center;color:var(--muted);font-size:12px;';
    msg.textContent = 'No elements match the current filter.';
    fragment.appendChild(msg);
  } else {
    filtered.forEach(loc => {
      const item = document.createElement('div');
      item.className = 'loc-item';
      item.dataset['type'] = loc.elType;
      item.dataset['uid']  = loc.uid;

      const TYPE_ABBR: Record<string, string> = {
        button: 'BTN', link: 'LINK', input: 'INP', checkbox: 'CHK',
        radio: 'RAD', select: 'SEL', textarea: 'TXT', custom: 'CUST',
      };
      const badgeLabel = TYPE_ABBR[loc.elType] ?? loc.elType.slice(0, 4).toUpperCase();

      let rows = '';

      if (fw === 'both' || fw === 'playwright') {
        const pw = loc.playwright[0] ?? '';
        if (pw) {
          rows += `
            <div class="loc-code-row">
              <span class="fw-badge fw-pw">PW</span>
              <code class="loc-code" title="${escHtml(pw)}">${escHtml(pw)}</code>
              <button class="loc-copy-btn" data-copy="${escHtml(pw)}" title="Copy Playwright locator">⎘</button>
            </div>`;
        }
      }

      if (fw === 'both' || fw === 'selenium') {
        const se = loc.selenium[0] ?? '';
        if (se) {
          rows += `
            <div class="loc-code-row">
              <span class="fw-badge fw-se">SE</span>
              <code class="loc-code" title="${escHtml(se)}">${escHtml(se)}</code>
              <button class="loc-copy-btn" data-copy="${escHtml(se)}" title="Copy Selenium locator">⎘</button>
            </div>`;
        }
      }

      item.innerHTML = `
        <div class="loc-header">
          <span class="loc-type-badge lt-${loc.elType}">${badgeLabel}</span>
          <span class="loc-desc" title="${escHtml(loc.description)}">${escHtml(loc.description)}</span>
        </div>
        ${rows}`;

      // Hover over a card → highlight the element on the live page
      // Use localUid (the key in the frame's locatorMap) and target the correct frame
      item.addEventListener('mouseenter', () => {
        if (!currentTabId) return;
        const opts = loc.frameId !== undefined ? { frameId: loc.frameId } : {};
        chrome.tabs.sendMessage(currentTabId, { type: 'HIGHLIGHT_LOCATOR', uid: loc.localUid ?? loc.uid }, opts).catch(() => {});
      });
      item.addEventListener('mouseleave', () => {
        if (!currentTabId) return;
        const opts = loc.frameId !== undefined ? { frameId: loc.frameId } : {};
        chrome.tabs.sendMessage(currentTabId, { type: 'CLEAR_HIGHLIGHT' }, opts).catch(() => {});
      });

      fragment.appendChild(item);
    });
  }

  locListEl.innerHTML = '';
  locListEl.appendChild(fragment);
}

// Copy button handler (event delegation on the list)
locListEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.loc-copy-btn') as HTMLButtonElement | null;
  if (!btn) return;

  const text = btn.dataset['copy'] ?? '';
  copyText(text).then(() => {
    btn.classList.add('copied');
    btn.textContent = '✓';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.textContent = '⎘';
    }, 1500);
  }).catch(() => { /* ignore */ });
});

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

// Scan button
scanBtn.addEventListener('click', () => scanLocators().catch(console.error));

// Type filter buttons — event delegation so it survives any DOM rebuilds
document.getElementById('loc-filters')?.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.lf-btn') as HTMLButtonElement | null;
  if (!btn) return;
  document.querySelectorAll('.lf-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  locatorFilter = btn.dataset['filter'] ?? 'all';
  if (allLocators.length > 0) renderLocators();
});

// Framework selector
fwSelectEl.addEventListener('change', () => {
  locatorFramework = fwSelectEl.value;
  if (allLocators.length > 0) renderLocators();
});

// Stat pill clicks → switch view
document.getElementById('stats-row')?.addEventListener('click', (e) => {
  const pill = (e.target as HTMLElement).closest('.stat-pill') as HTMLElement | null;
  if (!pill) return;
  const stat = pill.dataset['stat'] as 'captured' | 'detected' | 'missed' | 'host' | undefined;
  if (!stat) return;
  activeStatView  = stat;
  activeHostFilter = null;
  document.querySelectorAll('.stat-pill').forEach(p => p.classList.remove('active'));
  pill.classList.add('active');
  renderStatView();
});

// ─── Status / capture toggle ──────────────────────────────────────────────────

function updateStatusDot(): void {
  if (!isCapturing) {
    statusDotEl.textContent = '● Paused';
    statusDotEl.className   = 'paused';
  } else if (isSettled) {
    statusDotEl.textContent = '● Done';
    statusDotEl.className   = 'done';
  } else {
    statusDotEl.textContent = '● Live';
    statusDotEl.className   = 'live';
  }
}

function updateToggleBtn(): void {
  if (!isCapturing) {
    toggleBtn.textContent = '▶ Resume';
    toggleBtn.className   = 'ctrl-btn';
  } else if (isSettled) {
    toggleBtn.textContent = '↺ Recheck';
    toggleBtn.className   = 'ctrl-btn recheck';
  } else {
    toggleBtn.textContent = '⏸ Pause';
    toggleBtn.className   = 'ctrl-btn';
  }
}

toggleBtn.addEventListener('click', async () => {
  if (isSettled && isCapturing) {
    // User wants to re-observe — tell service worker to restart the settle timer
    isSettled = false;
    updateStatusDot();
    updateToggleBtn();
    if (currentTabId !== null) {
      chrome.runtime.sendMessage({ type: 'RECHECK_SETTLE', tabId: currentTabId }).catch(() => {});
    }
    return;
  }

  isCapturing = !isCapturing;
  await chrome.storage.local.set({ qalens_capturing: isCapturing });
  updateStatusDot();
  updateToggleBtn();
});

clearBtn.addEventListener('click', async () => {
  if (currentTabId === null) return;
  await chrome.storage.local.remove([
    `qalens_${currentTabId}`,
    `qalens_detected_${currentTabId}`,
  ]);
  currentCalls = [];
  detectedCount = 0;
  activeStatView  = 'captured';
  activeHostFilter = null;
  document.querySelectorAll('.stat-pill').forEach(p => p.classList.remove('active'));
  document.getElementById('stat-count')?.classList.add('active');
  hideDetail();
  renderList();
});

// ─── Detail close ─────────────────────────────────────────────────────────────

closeDetail.addEventListener('click', hideDetail);

// ─── Export ───────────────────────────────────────────────────────────────────

function exportCSV(): void {
  const hdr = ['Method','URL','Status','Trigger','Element','DOM Path','Page','Timestamp'];
  const rows = currentCalls.map(c => [
    c.method, c.url, c.responseStatus,
    c.triggerAction ?? '', c.triggerElement ?? '', c.domPath ?? '',
    c.pageUrl ?? '', new Date(c.timestamp).toISOString(),
  ]);
  download(
    [hdr, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n'),
    'qalens.csv', 'text/csv',
  );
}

function exportJSON(): void {
  download(JSON.stringify(currentCalls, null, 2), 'qalens.json', 'application/json');
}

function download(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Wire events ─────────────────────────────────────────────────────────────

exportCsvEl.addEventListener('click', exportCSV);
exportJsonEl.addEventListener('click', exportJSON);

init().catch(console.error);
