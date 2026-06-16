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
  time?: number;
  source?: 'interceptor' | 'webRequest';
  error?: string;
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

// ─── Extension context guard ──────────────────────────────────────────────────
// If the extension is reloaded/updated (chrome://extensions) while this side
// panel is still open, chrome.runtime/chrome.tabs become invalidated and calling
// them throws "Extension context invalidated" SYNCHRONOUSLY — before a promise
// exists — so a trailing .catch() never attaches. Guard + try/catch instead.

function isExtensionContextValid(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function safeTabsSendMessage(
  tabId: number,
  message: unknown,
  options?: chrome.tabs.MessageSendOptions,
): Promise<unknown> {
  if (!isExtensionContextValid()) return Promise.resolve(undefined);
  try {
    return chrome.tabs.sendMessage(tabId, message, options ?? {});
  } catch {
    return Promise.resolve(undefined);
  }
}

function safeRuntimeSendMessage(message: unknown): void {
  if (!isExtensionContextValid()) return;
  try {
    chrome.runtime.sendMessage(message)?.catch(() => {});
  } catch {
    // Context was invalidated between the check above and this call — ignore.
  }
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const pageHostEl        = document.getElementById('page-host')         as HTMLSpanElement;
const statusDotEl       = document.getElementById('status-dot')        as HTMLSpanElement;
const endpointCountEl   = document.getElementById('endpoint-count')    as HTMLSpanElement;
const endpointListEl    = document.getElementById('endpoint-list')     as HTMLDivElement;
const noDataEl       = document.getElementById('no-data')      as HTMLDivElement;
const toggleBtn      = document.getElementById('toggle-capture') as HTMLButtonElement;
const clearBtn       = document.getElementById('clear-all')    as HTMLButtonElement;
const exportCsvEl    = document.getElementById('export-csv')   as HTMLButtonElement;
const exportJsonEl   = document.getElementById('export-json')  as HTMLButtonElement;
const appEl          = document.getElementById('app')          as HTMLDivElement;
const apiViewEl      = document.getElementById('api-view')     as HTMLDivElement;

// Detail panel
const detailPanel   = document.getElementById('detail-panel')   as HTMLDivElement;
const detailMethod  = document.getElementById('detail-method')  as HTMLSpanElement;
const detailUrl     = document.getElementById('detail-url')     as HTMLSpanElement;
const closeDetail   = document.getElementById('close-detail')   as HTMLButtonElement;
const detailParamsEl  = document.getElementById('detail-params')  as HTMLTableElement;
const detailHeadersEl = document.getElementById('detail-headers') as HTMLTableElement;

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
  const flags = await chrome.storage.local.get('qalens_capturing') as Record<string, unknown>;
  isCapturing = flags['qalens_capturing'] !== false;
  updateStatusDot();

  await loadData(tab.id);

  // Switch data when the user changes tabs
  chrome.tabs.onActivated.addListener(async (info) => {
    currentTabId = info.tabId;
    selectedIdx = null;
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
    const captureKey  = `qalens_${currentTabId}`;
    const settledKey  = `qalens_settled_${currentTabId}`;

    if (changes[captureKey]) {
      currentCalls = (changes[captureKey].newValue as StoredCall[] | undefined) ?? [];
      renderList();
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
  const settledKey = `qalens_settled_${tabId}`;
  const result = await chrome.storage.local.get([key, settledKey]) as Record<string, unknown>;
  currentCalls  = Array.isArray(result[key]) ? (result[key] as StoredCall[]) : [];
  isSettled     = result[settledKey] === true;
  renderList();
  updateStatusDot();
  updateToggleBtn();
}

// ─── Render API list ──────────────────────────────────────────────────────────
// Endpoints are deduped by method + path (query string ignored) so repeated
// calls to the same endpoint (pagination, polling) collapse into one row —
// the most recent call's data wins. idx always refers to the position of the
// representative call inside currentCalls, so showDetail/export can look it
// up directly.

interface DedupedEndpoint { call: StoredCall; idx: number; }

function dedupeEndpoints(calls: StoredCall[]): DedupedEndpoint[] {
  const ordered = calls
    .map((call, idx) => ({ call, idx }))
    .sort((a, b) => b.call.timestamp - a.call.timestamp);

  const seen = new Set<string>();
  const result: DedupedEndpoint[] = [];
  for (const entry of ordered) {
    let key: string;
    try {
      const u = new URL(entry.call.url);
      key = `${entry.call.method}::${u.origin}${u.pathname}`;
    } catch {
      key = `${entry.call.method}::${entry.call.url}`;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function renderList(): void {
  noDataEl.classList.add('hidden');
  [...endpointListEl.children].forEach(c => { if (c !== noDataEl) c.remove(); });

  const deduped = dedupeEndpoints(currentCalls);
  endpointCountEl.textContent = `${deduped.length} endpoint${deduped.length !== 1 ? 's' : ''}`;

  if (currentCalls.length === 0) {
    noDataEl.classList.remove('hidden');
    return;
  }

  const fragment = document.createDocumentFragment();
  deduped.forEach(({ call, idx }) => {
    const div = document.createElement('div');
    div.className = 'ep-row' + (selectedIdx === idx ? ' selected' : '');
    div.dataset['idx'] = String(idx);

    let path: string;
    try { path = new URL(call.url).pathname || '/'; } catch { path = call.url; }
    if (path.length > 56) path = path.slice(0, 56) + '…';

    const isErr = call.error != null || call.responseStatus === 0;
    const scLabel = isErr ? 'ERR' : String(call.responseStatus);
    const scCls = isErr ? 'err' : call.responseStatus >= 500 ? 'err' : call.responseStatus >= 400 ? 'warn' : 'ok';
    const time = typeof call.time === 'number' ? `${call.time}ms` : '—';

    div.innerHTML = `
      <span class="method m-${call.method.toLowerCase()}">${escHtml(call.method)}</span>
      <span class="path" title="${escHtml(call.url)}">${escHtml(path)}</span>
      <span class="sc sc-${scCls}">${escHtml(scLabel)}</span>
      <span class="time">${time}</span>`;

    div.addEventListener('click', () => showDetail(idx));
    fragment.appendChild(div);
  });

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

  let params: Array<[string, string]> = [];
  try { params = [...new URL(call.url).searchParams.entries()]; } catch { /* not a valid URL */ }
  detailParamsEl.innerHTML = params.length
    ? params.map(([k, v]) => `<tr><td class="dt-label">${escHtml(k)}</td><td class="dt-val mono">${escHtml(v)}</td></tr>`).join('')
    : `<tr><td class="dt-val" colspan="2">(none)</td></tr>`;

  const headers = call.requestHeaders ? Object.entries(call.requestHeaders) : [];
  detailHeadersEl.innerHTML = headers.length
    ? headers.map(([k, v]) => `<tr><td class="dt-label">${escHtml(k)}</td><td class="dt-val mono">${escHtml(v)}</td></tr>`).join('')
    : `<tr><td class="dt-val" colspan="2">(none)</td></tr>`;

  detailPanel.classList.remove('hidden');
  appEl.classList.add('detail-open');
}

function hideDetail(): void {
  selectedIdx = null;
  detailPanel.classList.add('hidden');
  appEl.classList.remove('detail-open');
  endpointListEl.querySelectorAll('.ep-row').forEach(r => r.classList.remove('selected'));
}

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
        safeTabsSendMessage(currentTabId!, { type: 'CLEAR_HIGHLIGHT' }, { frameId: fid })
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
        safeTabsSendMessage(currentTabId!, { type: 'SCAN_PAGE_LOCATORS' }, { frameId })
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
        safeTabsSendMessage(currentTabId, { type: 'HIGHLIGHT_LOCATOR', uid: loc.localUid ?? loc.uid }, opts);
      });
      item.addEventListener('mouseleave', () => {
        if (!currentTabId) return;
        const opts = loc.frameId !== undefined ? { frameId: loc.frameId } : {};
        safeTabsSendMessage(currentTabId, { type: 'CLEAR_HIGHLIGHT' }, opts);
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
      safeRuntimeSendMessage({ type: 'RECHECK_SETTLE', tabId: currentTabId });
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
  await chrome.storage.local.remove([`qalens_${currentTabId}`]);
  currentCalls = [];
  hideDetail();
  renderList();
});

// ─── Detail close ─────────────────────────────────────────────────────────────

closeDetail.addEventListener('click', hideDetail);

// ─── Export ───────────────────────────────────────────────────────────────────
// Exports the same deduped endpoint list shown in the panel — one row per
// unique endpoint, full URL (with query params) preserved, for building a
// Data Mapping Document.

interface ExportRow { method: string; url: string; status: number | string; time: number | string; }

function buildExportRows(): ExportRow[] {
  return dedupeEndpoints(currentCalls).map(({ call }) => ({
    method: call.method,
    url: call.url,
    status: call.error != null || call.responseStatus === 0 ? 'ERR' : call.responseStatus,
    time: typeof call.time === 'number' ? call.time : '',
  }));
}

// Prevents CSV/Excel formula injection: a captured URL or header-derived
// value starting with =, +, -, @, tab, or CR would otherwise be interpreted
// as a formula by Excel/Sheets when the exported data is pasted or opened.
// Prefixing with a single quote is the standard mitigation both respect.
function sanitizeForSpreadsheet(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function sanitizeRow(r: ExportRow): ExportRow {
  return {
    method: sanitizeForSpreadsheet(r.method),
    url: sanitizeForSpreadsheet(r.url),
    status: typeof r.status === 'string' ? sanitizeForSpreadsheet(r.status) : r.status,
    time: typeof r.time === 'string' ? sanitizeForSpreadsheet(r.time) : r.time,
  };
}

async function copyCSV(): Promise<void> {
  const rows = buildExportRows().map(sanitizeRow);
  const hdr = ['method', 'full_url', 'status', 'time'];
  const csv = [hdr, ...rows.map(r => [r.method, r.url, r.status, r.time])]
    .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  await copyText(csv);
  flashCopied(exportCsvEl, '⎘ Copy CSV');
}

async function copyJSON(): Promise<void> {
  await copyText(JSON.stringify(buildExportRows().map(sanitizeRow), null, 2));
  flashCopied(exportJsonEl, '⎘ Copy JSON');
}

function flashCopied(btn: HTMLButtonElement, restoreText: string): void {
  btn.textContent = '✓ Copied';
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = restoreText;
    btn.disabled = false;
  }, 1500);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Wire events ─────────────────────────────────────────────────────────────

exportCsvEl.addEventListener('click', () => copyCSV().catch(console.error));
exportJsonEl.addEventListener('click', () => copyJSON().catch(console.error));

init().catch(console.error);
