/**
 * panel.ts
 * Main DevTools panel logic.
 *
 * Capture strategy (three layers):
 *   1. getHAR()             — backfills all requests that fired before the panel opened
 *   2. onRequestFinished    — live-captures new requests going forward
 *   3. onNavigated          — clears + re-runs getHAR() when the page navigates
 *
 * UIContext pipeline:
 *   content.ts → service-worker relay → chrome.runtime.onMessage → lastUIContext
 *   lastUIContext is attached to the next captured request via buildCapturedCall()
 */

import type { CapturedAPICall, HTTPMethod, UIContext } from '../../../shared/types';
import { generateId, extractSchema, formatBytes, formatStatus } from '../../../shared/utils';

// ─── State ────────────────────────────────────────────────────────────────────

let capturedCalls: CapturedAPICall[] = [];
let isCapturing = true;
let filterText = '';
let lastUIContext: UIContext | null = null;
let hideProgressTimer: ReturnType<typeof setTimeout> | null = null;
let storageWriteTimer: ReturnType<typeof setTimeout> | null = null;

// ─── DOM References ───────────────────────────────────────────────────────────

const tableBody     = document.getElementById('api-table-body')  as HTMLTableSectionElement;
const filterInput   = document.getElementById('filter-input')    as HTMLInputElement;
const captureToggle = document.getElementById('capture-toggle')  as HTMLButtonElement;
const clearBtn      = document.getElementById('clear-btn')       as HTMLButtonElement;
const exportCsvBtn  = document.getElementById('export-csv')      as HTMLButtonElement;
const exportJsonBtn = document.getElementById('export-json')     as HTMLButtonElement;
const countBadge    = document.getElementById('count-badge')     as HTMLSpanElement;
const detailPanel   = document.getElementById('detail-panel')    as HTMLDivElement;
const urlInput      = document.getElementById('url-input')       as HTMLInputElement;
const urlGoBtn      = document.getElementById('url-go-btn')      as HTMLButtonElement;
const progressBar   = document.getElementById('progress-bar')    as HTMLDivElement;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function headersArrayToRecord(
  headers: Array<{ name: string; value: string }>
): Record<string, string> {
  return headers.reduce((acc, h) => {
    acc[h.name] = h.value;
    return acc;
  }, {} as Record<string, string>);
}

function tryParseJSON(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

function truncateUrl(url: string, max = 80): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    return path.length > max ? path.substring(0, max) + '...' : path;
  } catch {
    return url.length > max ? url.substring(0, max) + '...' : url;
  }
}

function updateCount(): void {
  countBadge.textContent = String(capturedCalls.length);
}

// ─── Progress Bar ─────────────────────────────────────────────────────────────

function showProgress(): void {
  if (hideProgressTimer) { clearTimeout(hideProgressTimer); hideProgressTimer = null; }
  progressBar.classList.remove('hidden');
}

/** Hides the progress bar after a 1.5s idle window (resets on each new request). */
function scheduleHideProgress(): void {
  if (hideProgressTimer) clearTimeout(hideProgressTimer);
  hideProgressTimer = setTimeout(() => {
    progressBar.classList.add('hidden');
    hideProgressTimer = null;
  }, 1500);
}

// ─── Storage (popup data sharing) ────────────────────────────────────────────

function saveToStorage(): void {
  const tabId = chrome.devtools.inspectedWindow.tabId;
  const summary = capturedCalls.map(c => ({
    method: c.method,
    url: c.url,
    responseStatus: c.responseStatus,
    triggerAction: c.uiContext?.triggerAction ?? 'unknown',
    timestamp: c.timestamp,
  }));
  chrome.storage.local.set({
    [`apimapper_${tabId}`]: { tabId, calls: summary, isCapturing, capturedAt: Date.now() },
  }).catch((err: unknown) => console.warn('[API Mapper] Storage write failed:', err));
}

function scheduleSaveToStorage(): void {
  if (storageWriteTimer) clearTimeout(storageWriteTimer);
  storageWriteTimer = setTimeout(saveToStorage, 400);
}

function matchesFilter(call: CapturedAPICall): boolean {
  if (!filterText) return true;
  const q = filterText.toLowerCase();
  return (
    call.url.toLowerCase().includes(q) ||
    call.method.toLowerCase().includes(q) ||
    String(call.responseStatus).includes(q)
  );
}

function getRowClass(status: number): string {
  if (status >= 500) return 'row-error';
  if (status >= 400) return 'row-warning';
  if (status >= 200 && status < 300) return 'row-success';
  return '';
}

/** Returns a colored badge HTML string for the given trigger action. */
function renderTriggerBadge(action: string): string {
  const known = ['load', 'click', 'input', 'scroll', 'hover', 'unknown'];
  const safe = known.includes(action) ? action : 'unknown';
  return `<span class="trigger-badge trigger-${safe}">${safe}</span>`;
}

/** Returns HTML for the Context tab in the detail panel. */
function renderUIContextDetail(ctx: UIContext | undefined): string {
  if (!ctx) {
    return '<p class="db-hint">No UI context captured for this request.</p>';
  }
  const row = (label: string, value: string, mono = false) =>
    `<tr>
      <td class="ctx-label">${label}</td>
      <td class="${mono ? 'ctx-mono' : ''}">${value}</td>
    </tr>`;

  return `<table class="context-table">
    ${row('Trigger', renderTriggerBadge(ctx.triggerAction ?? 'unknown'))}
    ${ctx.pageUrl     ? row('Page URL',   ctx.pageUrl,           true) : ''}
    ${ctx.pageTitle   ? row('Page Title', ctx.pageTitle)               : ''}
    ${ctx.triggerElement ? row('Element', `&lt;${ctx.triggerElement}&gt;`, true) : ''}
    ${ctx.domPath     ? row('DOM Path',   ctx.domPath,           true) : ''}
    ${ctx.activeComponent ? row('Component', ctx.activeComponent, true) : ''}
  </table>`;
}

/**
 * Returns true if a HAR entry is already in capturedCalls (same URL ± 1 second).
 * Prevents duplicates when getHAR() and onRequestFinished both see the same request.
 */
function isAlreadyCaptured(entry: chrome.devtools.network.HAREntry): boolean {
  const entryTime = new Date(entry.startedDateTime).getTime();
  return capturedCalls.some(
    (c) => c.url === entry.request.url && Math.abs(c.timestamp - entryTime) < 1000
  );
}

/** Extracts and parses the response body from a HAR entry. */
function tryParseResponseContent(entry: chrome.devtools.network.HAREntry): unknown {
  const text = entry.response.content?.text;
  if (!text) return null;
  const encoding = entry.response.content?.encoding;
  try {
    const decoded = encoding === 'base64' ? atob(text) : text;
    return JSON.parse(decoded);
  } catch {
    return text;
  }
}

// ─── Network Interception ─────────────────────────────────────────────────────

/**
 * Builds a CapturedAPICall from a live chrome.devtools.network.Request.
 * Uses lastUIContext to record which DOM interaction triggered this request.
 */
function buildCapturedCall(
  request: chrome.devtools.network.Request,
  responseBody: unknown
): CapturedAPICall {
  const entry = request as unknown as chrome.devtools.network.HAREntry;

  return {
    id: generateId(),
    timestamp: Date.now(),
    url: entry.request.url,
    method: entry.request.method as HTTPMethod,
    requestHeaders: headersArrayToRecord(entry.request.headers),
    requestPayload: entry.request.postData?.text
      ? tryParseJSON(entry.request.postData.text)
      : undefined,
    responseStatus: entry.response.status,
    responseHeaders: headersArrayToRecord(entry.response.headers),
    responseBody,
    responseSchema: responseBody ? extractSchema(responseBody) : undefined,
    uiContext: lastUIContext ?? {
      pageUrl: entry.request.url,
      triggerAction: 'unknown',
    },
  };
}

/**
 * Builds a CapturedAPICall from a HAR entry (getHAR() results).
 * These requests fired at page load, so triggerAction is always 'load'.
 */
function buildCapturedCallFromHAR(
  entry: chrome.devtools.network.HAREntry,
  responseBody: unknown
): CapturedAPICall {
  return {
    id: generateId(),
    timestamp: new Date(entry.startedDateTime).getTime(),
    url: entry.request.url,
    method: entry.request.method as HTTPMethod,
    requestHeaders: headersArrayToRecord(entry.request.headers),
    requestPayload: entry.request.postData?.text
      ? tryParseJSON(entry.request.postData.text)
      : undefined,
    responseStatus: entry.response.status,
    responseHeaders: headersArrayToRecord(entry.response.headers),
    responseBody,
    responseSchema: responseBody ? extractSchema(responseBody) : undefined,
    uiContext: {
      pageUrl: entry.request.url,
      triggerAction: 'load',
    },
  };
}

/** Extracts response body from a live network request. */
async function getResponseBody(
  request: chrome.devtools.network.Request
): Promise<unknown> {
  return new Promise((resolve) => {
    request.getContent((content, encoding) => {
      if (!content) return resolve(null);
      try {
        const decoded = encoding === 'base64' ? atob(content) : content;
        resolve(JSON.parse(decoded));
      } catch {
        resolve(content);
      }
    });
  });
}

/**
 * Loads all API calls that already fired on the page (before the panel opened).
 * Filters to XHR/Fetch only and skips entries already captured by onRequestFinished.
 * Returns a Promise that resolves once the HAR log has been processed.
 */
function loadHAREntries(): Promise<void> {
  return new Promise((resolve) => {
    chrome.devtools.network.getHAR((harLog) => {
      if (!harLog?.entries?.length) return resolve();

      let added = 0;
      for (const entry of harLog.entries) {
        const resourceType = (entry as unknown as Record<string, string>)['_resourceType'];
        if (!['xhr', 'fetch'].includes(resourceType ?? '')) continue;
        if (isAlreadyCaptured(entry)) continue;

        try {
          const body = tryParseResponseContent(entry);
          const call = buildCapturedCallFromHAR(entry, body);
          capturedCalls.push(call);
          renderRow(call);
          added++;
        } catch (err) {
          console.warn('[API Mapper] HAR entry parse failed:', err);
        }
      }

      if (added > 0) { updateCount(); scheduleSaveToStorage(); }
      resolve();
    });
  });
}

/**
 * Starts intercepting live network calls via the chrome.devtools.network API.
 */
function startInterception(): void {
  chrome.devtools.network.onRequestFinished.addListener(
    async (request: chrome.devtools.network.Request) => {
      if (!isCapturing) return;

      const resourceType = request._resourceType;
      if (!['xhr', 'fetch'].includes(resourceType ?? '')) return;

      try {
        const responseBody = await getResponseBody(request);
        const call = buildCapturedCall(request, responseBody);
        capturedCalls.push(call);
        renderRow(call);
        updateCount();
        scheduleHideProgress();
        scheduleSaveToStorage();
      } catch (err) {
        console.warn('[API Mapper] Failed to capture request:', err);
      }
    }
  );
}

/**
 * Listens for UIContext messages relayed by the service worker from content.ts.
 * Stores the latest context so buildCapturedCall() can attach it to the next request.
 */
function startUIContextListener(): void {
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      (message as Record<string, unknown>)['type'] === 'UI_CONTEXT_UPDATE'
    ) {
      const payload = (message as Record<string, unknown>)['payload'];
      if (payload) lastUIContext = payload as UIContext;
    }
  });
}

/**
 * Clears all captured calls when the inspected page navigates,
 * then re-runs getHAR() after a short delay to capture the new page's load requests.
 */
function startNavigationListener(): void {
  chrome.devtools.network.onNavigated.addListener(() => {
    clearCaptures();
    showProgress();
    setTimeout(() => {
      loadHAREntries().then(() => scheduleHideProgress());
    }, 600);
  });
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderRow(call: CapturedAPICall): void {
  if (!matchesFilter(call)) return;

  const row = document.createElement('tr');
  row.dataset.id = call.id;
  row.className = getRowClass(call.responseStatus);

  row.innerHTML = `
    <td class="method-cell method-${call.method.toLowerCase()}">${call.method}</td>
    <td class="url-cell" title="${call.url}">${truncateUrl(call.url)}</td>
    <td class="status-cell">${formatStatus(call.responseStatus)}</td>
    <td class="time-cell">${new Date(call.timestamp).toLocaleTimeString()}</td>
    <td class="trigger-cell">${renderTriggerBadge(call.uiContext?.triggerAction ?? 'unknown')}</td>
    <td class="actions-cell">
      <button class="view-btn" data-id="${call.id}">View</button>
    </td>
  `;

  row.querySelector('.view-btn')?.addEventListener('click', () => showDetail(call));
  tableBody.appendChild(row);
}

function showDetail(call: CapturedAPICall): void {
  detailPanel.innerHTML = `
    <div class="detail-header">
      <span class="method-badge method-${call.method.toLowerCase()}">${call.method}</span>
      <span class="detail-url">${call.url}</span>
    </div>
    <div class="detail-tabs">
      <button class="tab-btn active" data-tab="response">Response</button>
      <button class="tab-btn" data-tab="request">Request</button>
      <button class="tab-btn" data-tab="schema">Schema</button>
      <button class="tab-btn" data-tab="context">Context</button>
      <button class="tab-btn" data-tab="db">DB Inference</button>
    </div>
    <div class="tab-content" id="tab-response">
      <pre>${JSON.stringify(call.responseBody, null, 2)}</pre>
    </div>
    <div class="tab-content hidden" id="tab-request">
      <pre>${JSON.stringify(call.requestPayload ?? 'No payload', null, 2)}</pre>
    </div>
    <div class="tab-content hidden" id="tab-schema">
      <pre>${JSON.stringify(call.responseSchema ?? 'Schema not available', null, 2)}</pre>
    </div>
    <div class="tab-content hidden" id="tab-context">
      ${renderUIContextDetail(call.uiContext)}
    </div>
    <div class="tab-content hidden" id="tab-db">
      <p class="db-hint">DB inference available in Phase 2 with AI agent.</p>
    </div>
  `;

  detailPanel.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLButtonElement;
      const tab = target.dataset.tab!;
      detailPanel.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      detailPanel.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
      target.classList.add('active');
      detailPanel.querySelector(`#tab-${tab}`)?.classList.remove('hidden');
    });
  });

  detailPanel.classList.remove('hidden');
}

function reRenderTable(): void {
  tableBody.innerHTML = '';
  capturedCalls.filter(matchesFilter).forEach(renderRow);
}

// ─── State Management ─────────────────────────────────────────────────────────

function clearCaptures(): void {
  capturedCalls = [];
  tableBody.innerHTML = '';
  detailPanel.classList.add('hidden');
  lastUIContext = null;
  updateCount();
  scheduleSaveToStorage();
}

// ─── Export ───────────────────────────────────────────────────────────────────

function exportCSV(): void {
  const headers = [
    'Method', 'URL', 'Status', 'Timestamp',
    'Trigger', 'Element', 'DOM Path',
    'Has Payload', 'Response Fields',
  ];
  const rows = capturedCalls.map(call => [
    call.method,
    call.url,
    call.responseStatus,
    new Date(call.timestamp).toISOString(),
    call.uiContext?.triggerAction ?? 'unknown',
    call.uiContext?.triggerElement ?? '',
    call.uiContext?.domPath ?? '',
    call.requestPayload ? 'Yes' : 'No',
    call.responseSchema
      ? Object.keys(call.responseSchema.properties ?? {}).join(' | ')
      : '',
  ]);

  const csv = [headers, ...rows]
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');

  downloadFile(csv, 'api-mapper-export.csv', 'text/csv');
}

function exportJSON(): void {
  downloadFile(JSON.stringify(capturedCalls, null, 2), 'api-mapper-export.json', 'application/json');
}

function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── URL Navigation ───────────────────────────────────────────────────────────

function navigateToUrl(): void {
  const raw = urlInput.value.trim();
  if (!raw) return;
  const url = raw.startsWith('http://') || raw.startsWith('https://')
    ? raw
    : 'https://' + raw;

  clearCaptures();
  chrome.tabs.update(chrome.devtools.inspectedWindow.tabId, { url });
}

// ─── Event Listeners ──────────────────────────────────────────────────────────

filterInput.addEventListener('input', (e) => {
  filterText = (e.target as HTMLInputElement).value;
  reRenderTable();
});

captureToggle.addEventListener('click', () => {
  isCapturing = !isCapturing;
  captureToggle.textContent = isCapturing ? '⏸ Pause' : '▶ Resume';
  captureToggle.classList.toggle('paused', !isCapturing);
});

clearBtn.addEventListener('click', clearCaptures);

exportCsvBtn.addEventListener('click', exportCSV);
exportJsonBtn.addEventListener('click', exportJSON);

urlGoBtn.addEventListener('click', navigateToUrl);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') navigateToUrl();
});

// ─── Init ─────────────────────────────────────────────────────────────────────

startUIContextListener();   // 1. listen for UI events from content script relay
startNavigationListener();  // 2. re-capture on page navigation
startInterception();        // 3. live-capture new requests

showProgress();
loadHAREntries().then(() => scheduleHideProgress()); // 4. backfill + show progress

console.log('[API Mapper] Panel initialized');
