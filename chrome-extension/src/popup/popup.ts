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
  elType: string;
  description: string;
  playwright: string[];
  selenium: string[];
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const pageHostEl     = document.getElementById('page-host')    as HTMLSpanElement;
const statusDotEl    = document.getElementById('status-dot')   as HTMLSpanElement;
const statCountEl    = document.getElementById('stat-count')    as HTMLSpanElement;
const statHostsEl    = document.getElementById('stat-hosts')    as HTMLSpanElement;
const statDetectedEl = document.getElementById('stat-detected') as HTMLSpanElement;
const statMissedEl   = document.getElementById('stat-missed')   as HTMLSpanElement;
const endpointListEl = document.getElementById('endpoint-list') as HTMLDivElement;
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
  const flags = await chrome.storage.local.get('apimapper_capturing') as Record<string, unknown>;
  isCapturing = flags['apimapper_capturing'] !== false;
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
    const captureKey  = `apimapper_${currentTabId}`;
    const detectedKey = `apimapper_detected_${currentTabId}`;
    const settledKey  = `apimapper_settled_${currentTabId}`;

    if (changes[captureKey]) {
      currentCalls = (changes[captureKey].newValue as StoredCall[] | undefined) ?? [];
      renderList();
    }
    if (changes[detectedKey]) {
      detectedCount = (changes[detectedKey].newValue as number | undefined) ?? 0;
      updateVerification();
    }
    if (changes['apimapper_capturing']) {
      isCapturing = changes['apimapper_capturing'].newValue as boolean;
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
  const key        = `apimapper_${tabId}`;
  const detKey     = `apimapper_detected_${tabId}`;
  const settledKey = `apimapper_settled_${tabId}`;
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
  statDetectedEl.textContent = `${detectedCount} detected`;
  const missed = detectedCount - currentCalls.length;
  if (missed > 0) {
    statMissedEl.textContent = `⚠ ${missed} missed`;
    statMissedEl.classList.remove('hidden');
  } else {
    statMissedEl.classList.add('hidden');
  }
}

function renderList(): void {
  const hosts = new Set(currentCalls.map(c => { try { return new URL(c.url).hostname; } catch { return '?'; } }));
  statCountEl.textContent = `${currentCalls.length} captured`;
  statHostsEl.textContent = `${hosts.size} host${hosts.size !== 1 ? 's' : ''}`;
  updateVerification();

  if (currentCalls.length === 0) {
    noDataEl.classList.remove('hidden');
    [...endpointListEl.children].forEach(c => { if (c !== noDataEl) c.remove(); });
    return;
  }

  noDataEl.classList.add('hidden');

  const sorted = currentCalls
    .map((c, i) => ({ c, i }))
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

  [...endpointListEl.children].forEach(c => { if (c !== noDataEl) c.remove(); });
  endpointListEl.appendChild(fragment);
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
      chrome.tabs.sendMessage(currentTabId, { type: 'CLEAR_HIGHLIGHT' }).catch(() => {});
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
    const response = await chrome.tabs.sendMessage(currentTabId, { type: 'SCAN_PAGE_LOCATORS' }) as
      { ok: boolean; locators?: LocatorResult[]; error?: string };

    if (!response.ok || !response.locators) {
      locStatusEl.textContent = `Scan failed: ${response.error ?? 'unknown error'}`;
      locStatusEl.classList.remove('hidden');
      return;
    }

    allLocators = response.locators;
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

      const badgeLabel = loc.elType.length > 4 ? loc.elType.slice(0, 4).toUpperCase() : loc.elType.toUpperCase();

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
      item.addEventListener('mouseenter', () => {
        if (!currentTabId) return;
        chrome.tabs.sendMessage(currentTabId, { type: 'HIGHLIGHT_LOCATOR', uid: loc.uid }).catch(() => {});
      });
      item.addEventListener('mouseleave', () => {
        if (!currentTabId) return;
        chrome.tabs.sendMessage(currentTabId, { type: 'CLEAR_HIGHLIGHT' }).catch(() => {});
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

// Type filter buttons
document.querySelectorAll('.lf-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.lf-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    locatorFilter = (btn as HTMLElement).dataset['filter'] ?? 'all';
    if (allLocators.length > 0) renderLocators();
  });
});

// Framework selector
fwSelectEl.addEventListener('change', () => {
  locatorFramework = fwSelectEl.value;
  if (allLocators.length > 0) renderLocators();
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
  await chrome.storage.local.set({ apimapper_capturing: isCapturing });
  updateStatusDot();
  updateToggleBtn();
});

clearBtn.addEventListener('click', async () => {
  if (currentTabId === null) return;
  await chrome.storage.local.remove([
    `apimapper_${currentTabId}`,
    `apimapper_detected_${currentTabId}`,
  ]);
  currentCalls = [];
  detectedCount = 0;
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
    'api-mapper.csv', 'text/csv',
  );
}

function exportJSON(): void {
  download(JSON.stringify(currentCalls, null, 2), 'api-mapper.json', 'application/json');
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
