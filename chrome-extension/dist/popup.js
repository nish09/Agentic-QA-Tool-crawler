/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/*!****************************!*\
  !*** ./src/popup/popup.ts ***!
  \****************************/

/**
 * popup.ts — Extension toolbar popup.
 * Reads captured API calls from chrome.storage.local (written by service-worker.ts).
 * Shows a list of calls; clicking a row opens a detail panel with Response/Request/Context tabs.
 * Works 100% independently — no DevTools needed.
 */
// ─── DOM refs ─────────────────────────────────────────────────────────────────
const pageHostEl = document.getElementById('page-host');
const statusDotEl = document.getElementById('status-dot');
const statCountEl = document.getElementById('stat-count');
const statHostsEl = document.getElementById('stat-hosts');
const statDetectedEl = document.getElementById('stat-detected');
const statMissedEl = document.getElementById('stat-missed');
const endpointListEl = document.getElementById('endpoint-list');
const noDataEl = document.getElementById('no-data');
const toggleBtn = document.getElementById('toggle-capture');
const clearBtn = document.getElementById('clear-all');
const exportCsvEl = document.getElementById('export-csv');
const exportJsonEl = document.getElementById('export-json');
const appEl = document.getElementById('app');
// Detail panel
const detailPanel = document.getElementById('detail-panel');
const detailMethod = document.getElementById('detail-method');
const detailUrl = document.getElementById('detail-url');
const closeDetail = document.getElementById('close-detail');
const paneResponse = document.getElementById('pane-response');
const paneRequest = document.getElementById('pane-request');
const paneContext = document.getElementById('pane-context');
const responseBody = document.getElementById('response-body');
const reqMethod = document.getElementById('req-method');
const reqUrl = document.getElementById('req-url');
const reqStatus = document.getElementById('req-status');
const reqBodyEl = document.getElementById('req-body');
const reqHeaders = document.getElementById('req-headers');
const ctxTrigger = document.getElementById('ctx-trigger');
const ctxElement = document.getElementById('ctx-element');
const ctxDompath = document.getElementById('ctx-dompath');
const ctxPage = document.getElementById('ctx-page');
const ctxComponent = document.getElementById('ctx-component');
// ─── State ────────────────────────────────────────────────────────────────────
let currentTabId = null;
let currentCalls = [];
let selectedIdx = null;
let isCapturing = true;
let detectedCount = 0;
// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id)
        return;
    currentTabId = tab.id;
    if (tab.url) {
        try {
            pageHostEl.textContent = new URL(tab.url).hostname || tab.url;
            pageHostEl.title = tab.url;
        }
        catch {
            pageHostEl.textContent = tab.url;
        }
    }
    // Load capturing flag
    const flags = await chrome.storage.local.get('apimapper_capturing');
    isCapturing = flags['apimapper_capturing'] !== false;
    updateStatusDot();
    await loadData(tab.id);
    // Live updates while popup is open
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local')
            return;
        const captureKey = `apimapper_${currentTabId}`;
        const detectedKey = `apimapper_detected_${currentTabId}`;
        if (changes[captureKey]) {
            currentCalls = changes[captureKey].newValue ?? [];
            renderList();
        }
        if (changes[detectedKey]) {
            detectedCount = changes[detectedKey].newValue ?? 0;
            updateVerification();
        }
        if (changes['apimapper_capturing']) {
            isCapturing = changes['apimapper_capturing'].newValue;
            updateStatusDot();
            updateToggleBtn();
        }
    });
}
// ─── Data loading ─────────────────────────────────────────────────────────────
async function loadData(tabId) {
    const key = `apimapper_${tabId}`;
    const detKey = `apimapper_detected_${tabId}`;
    const result = await chrome.storage.local.get([key, detKey]);
    currentCalls = Array.isArray(result[key]) ? result[key] : [];
    detectedCount = typeof result[detKey] === 'number' ? result[detKey] : 0;
    renderList();
}
// ─── Render list ─────────────────────────────────────────────────────────────
function updateVerification() {
    statDetectedEl.textContent = `${detectedCount} detected`;
    const missed = detectedCount - currentCalls.length;
    if (missed > 0) {
        statMissedEl.textContent = `⚠ ${missed} missed`;
        statMissedEl.classList.remove('hidden');
    }
    else {
        statMissedEl.classList.add('hidden');
    }
}
function renderList() {
    const hosts = new Set(currentCalls.map(c => { try {
        return new URL(c.url).hostname;
    }
    catch {
        return '?';
    } }));
    statCountEl.textContent = `${currentCalls.length} captured`;
    statHostsEl.textContent = `${hosts.size} host${hosts.size !== 1 ? 's' : ''}`;
    updateVerification();
    if (currentCalls.length === 0) {
        noDataEl.classList.remove('hidden');
        // Remove old rows but keep #no-data in place
        [...endpointListEl.children].forEach(c => { if (c !== noDataEl)
            c.remove(); });
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
        let path;
        try {
            const u = new URL(c.url);
            path = u.pathname + (u.search.length > 1 ? u.search.slice(0, 20) + (u.search.length > 20 ? '…' : '') : '');
        }
        catch {
            path = c.url;
        }
        if (path.length > 52)
            path = path.slice(0, 52) + '…';
        const sc = c.responseStatus;
        const scCls = sc >= 500 ? 'err' : sc >= 400 ? 'warn' : 'ok';
        const trig = c.triggerAction ?? 'unknown';
        const trigCls = ['load', 'click', 'input', 'scroll', 'hover'].includes(trig) ? trig : 'unknown';
        div.innerHTML = `
      <span class="method m-${c.method.toLowerCase()}">${c.method}</span>
      <span class="path" title="${escHtml(c.url)}">${escHtml(path)}</span>
      <span class="sc sc-${scCls}">${sc}</span>
      <span class="trig t-${trigCls}">${trigCls}</span>`;
        div.addEventListener('click', () => showDetail(i));
        fragment.appendChild(div);
    });
    // Replace rows (keep #no-data node)
    [...endpointListEl.children].forEach(c => { if (c !== noDataEl)
        c.remove(); });
    endpointListEl.appendChild(fragment);
}
// ─── Detail panel ─────────────────────────────────────────────────────────────
function showDetail(idx) {
    const call = currentCalls[idx];
    if (!call)
        return;
    selectedIdx = idx;
    // Mark selected row
    endpointListEl.querySelectorAll('.ep-row').forEach(r => {
        r.classList.toggle('selected', r.dataset['idx'] === String(idx));
    });
    // Header
    detailMethod.textContent = call.method;
    detailMethod.className = `method m-${call.method.toLowerCase()}`;
    detailUrl.textContent = call.url;
    detailUrl.title = call.url;
    // Response tab
    if (call.responseBody != null) {
        responseBody.textContent = typeof call.responseBody === 'string'
            ? call.responseBody
            : JSON.stringify(call.responseBody, null, 2);
    }
    else {
        responseBody.textContent = '(no body)';
    }
    // Request tab
    reqMethod.textContent = call.method;
    reqUrl.textContent = call.url;
    reqStatus.textContent = String(call.responseStatus);
    reqBodyEl.textContent = call.requestBody != null
        ? (typeof call.requestBody === 'string' ? call.requestBody : JSON.stringify(call.requestBody, null, 2))
        : '—';
    reqHeaders.textContent = call.requestHeaders
        ? Object.entries(call.requestHeaders).map(([k, v]) => `${k}: ${v}`).join('\n')
        : '—';
    // Context tab
    const trig = call.triggerAction ?? 'unknown';
    const trigCls = ['load', 'click', 'input', 'scroll', 'hover'].includes(trig) ? trig : 'unknown';
    ctxTrigger.innerHTML = `<span class="trig-badge t-${trigCls}">${trig}</span>`;
    ctxElement.textContent = call.triggerElement ?? '—';
    ctxDompath.textContent = call.domPath ?? '—';
    ctxPage.textContent = call.pageUrl ?? '—';
    ctxComponent.textContent = call.activeComponent ?? '—';
    // Show panel
    detailPanel.classList.remove('hidden');
    appEl.classList.add('detail-open');
    // Activate Response tab by default
    activateTab('response');
}
function hideDetail() {
    selectedIdx = null;
    detailPanel.classList.add('hidden');
    appEl.classList.remove('detail-open');
    endpointListEl.querySelectorAll('.ep-row').forEach(r => r.classList.remove('selected'));
}
// ─── Tabs ─────────────────────────────────────────────────────────────────────
function activateTab(name) {
    document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset['tab'] === name);
    });
    [paneResponse, paneRequest, paneContext].forEach(p => p.classList.add('hidden'));
    const pane = document.getElementById(`pane-${name}`);
    pane?.classList.remove('hidden');
}
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        activateTab(btn.dataset['tab'] ?? 'response');
    });
});
// ─── Status / capture toggle ──────────────────────────────────────────────────
function updateStatusDot() {
    statusDotEl.textContent = isCapturing ? '● Live' : '● Paused';
    statusDotEl.className = isCapturing ? 'live' : 'paused';
}
function updateToggleBtn() {
    toggleBtn.textContent = isCapturing ? '⏸ Pause' : '▶ Resume';
}
toggleBtn.addEventListener('click', async () => {
    isCapturing = !isCapturing;
    await chrome.storage.local.set({ apimapper_capturing: isCapturing });
    updateStatusDot();
    updateToggleBtn();
});
clearBtn.addEventListener('click', async () => {
    if (currentTabId === null)
        return;
    await chrome.storage.local.remove([
        `apimapper_${currentTabId}`,
        `apimapper_detected_${currentTabId}`,
    ]);
    currentCalls = [];
    detectedCount = 0;
    hideDetail();
    renderList();
});
// ─── Detail close / tab switching ─────────────────────────────────────────────
closeDetail.addEventListener('click', hideDetail);
// ─── Export ───────────────────────────────────────────────────────────────────
function exportCSV() {
    const hdr = ['Method', 'URL', 'Status', 'Trigger', 'Element', 'DOM Path', 'Page', 'Timestamp'];
    const rows = currentCalls.map(c => [
        c.method, c.url, c.responseStatus,
        c.triggerAction ?? '', c.triggerElement ?? '', c.domPath ?? '',
        c.pageUrl ?? '', new Date(c.timestamp).toISOString(),
    ]);
    download([hdr, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n'), 'api-mapper.csv', 'text/csv');
}
function exportJSON() {
    download(JSON.stringify(currentCalls, null, 2), 'api-mapper.json', 'application/json');
}
function download(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}
// ─── Helpers ──────────────────────────────────────────────────────────────────
function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// ─── Wire events ─────────────────────────────────────────────────────────────
exportCsvEl.addEventListener('click', exportCSV);
exportJsonEl.addEventListener('click', exportJSON);
init().catch(console.error);

/******/ })()
;
//# sourceMappingURL=popup.js.map