/**
 * service-worker.ts — MV3 background service worker.
 *
 * Two complementary sources feed the same per-tab call list under
 * chrome.storage.local key "qalens_<tabId>":
 *   1. content.ts relays page-level fetch/XHR captures (rich: headers,
 *      bodies, UI trigger context) via API_CALL_CAPTURED messages.
 *   2. chrome.webRequest observes every network request directly at the
 *      browser layer — timing-independent, so it also catches requests
 *      that fire before the page-level interceptor is ready, requests
 *      from contexts the content script can't reach, and network errors
 *      (which the page-level fetch wrapper never sees because a rejected
 *      fetch() never reaches its response-handling code).
 *
 * Both sources upsert into the same array, matched by method+url within a
 * short time window, so a single real request never appears twice — the
 * richer (interceptor) record always wins when both sources observe it.
 */

const CAPTURE_KEY      = 'qalens_capturing';
const MAX_BODY         = 5000;
const MAX_CALLS_PER_TAB = 300; // FIFO cap — oldest evicted first once exceeded
const SETTLE_MS        = 2500;  // quiet-period before marking a tab as "done"
const MERGE_WINDOW_MS  = 4000;  // same method+url within this window = same request

interface CapturedCall {
  method: string;
  url: string;
  responseStatus: number;
  time?: number;
  timestamp: number;
  source: 'interceptor' | 'webRequest';
  requestHeaders?: Record<string, string>;
  requestBody?: unknown;
  responseBody?: unknown;
  responseHeaders?: Record<string, string>;
  triggerAction?: string;
  triggerElement?: string;
  domPath?: string;
  pageUrl?: string;
  activeComponent?: string;
  error?: string;
}

function truncateBody(value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_BODY) return value.slice(0, MAX_BODY) + '…';
  return value;
}

// ─── Redaction ──────────────────────────────────────────────────────────────
// Captured headers/bodies can contain secrets (auth tokens, cookies,
// passwords) from whatever site is being tested. Redact at the single point
// where both capture sources (content.ts relay + chrome.webRequest) land in
// a CapturedCall, so neither source can bypass it.

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization', 'cookie', 'set-cookie', 'proxy-authorization',
  'x-api-key', 'x-auth-token', 'api-key', 'x-csrf-token',
]);

function redactHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return headers;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) ? '[redacted]' : value;
  }
  return out;
}

const SENSITIVE_BODY_KEYS = new Set([
  'password', 'token', 'secret', 'apikey', 'api_key', 'accesstoken',
  'access_token', 'refreshtoken', 'refresh_token', 'authorization',
  'ssn', 'cardnumber', 'card_number', 'cvv',
]);

// Masks the *value* of any sensitive-looking key in a parsed JSON body
// (objects/arrays), leaving the key visible (still useful for API mapping).
// Non-JSON bodies (plain strings) pass through unchanged — we can't safely
// pattern-match secrets inside arbitrary text without a high false-positive
// rate, and the JSON case covers the overwhelming majority of API payloads.
function redactBody(value: unknown, depth = 0): unknown {
  if (depth > 8) return value; // guard against pathological nesting
  if (Array.isArray(value)) return value.map(v => redactBody(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_BODY_KEYS.has(key.toLowerCase()) ? '[redacted]' : redactBody(v, depth + 1);
    }
    return out;
  }
  return value;
}

// ─── Settle detection ─────────────────────────────────────────────────────────
// After SETTLE_MS of no new captured calls (or page fully loaded), the tab is
// marked settled so the popup can show "Done / Recheck" instead of "Pause".

const settledTimers = new Map<number, ReturnType<typeof setTimeout>>();

function scheduleSettled(tabId: number): void {
  const prev = settledTimers.get(tabId);
  if (prev) clearTimeout(prev);
  settledTimers.set(tabId, setTimeout(async () => {
    settledTimers.delete(tabId);
    await chrome.storage.local.set({ [`qalens_settled_${tabId}`]: true });
  }, SETTLE_MS));
}

function cancelSettled(tabId: number): void {
  const t = settledTimers.get(tabId);
  if (t) { clearTimeout(t); settledTimers.delete(tabId); }
  chrome.storage.local.remove([`qalens_settled_${tabId}`]);
}

// ─── Merge a partial call record into the per-tab list ────────────────────────
// Matches an existing entry by method+url within MERGE_WINDOW_MS so the two
// capture sources enrich the same logical request instead of duplicating it.
// A bare webRequest patch never demotes a row that already has rich
// interceptor data (body/headers/trigger context).

async function upsertCall(
  tabId: number,
  rawPatch: Partial<CapturedCall> & { method: string; url: string; timestamp: number; source: CapturedCall['source'] },
): Promise<void> {
  const flags = await chrome.storage.local.get(CAPTURE_KEY) as Record<string, unknown>;
  if (flags[CAPTURE_KEY] === false) return;

  cancelSettled(tabId);

  // Redact before this patch ever touches storage — covers both capture
  // sources (interceptor relay and chrome.webRequest) from this one place.
  const patch = {
    ...rawPatch,
    requestHeaders:  redactHeaders(rawPatch.requestHeaders),
    responseHeaders: redactHeaders(rawPatch.responseHeaders),
    requestBody:     truncateBody(redactBody(rawPatch.requestBody)),
    responseBody:    truncateBody(redactBody(rawPatch.responseBody)),
  };

  const key = `qalens_${tabId}`;
  const existing = await chrome.storage.local.get(key) as Record<string, CapturedCall[]>;
  let calls: CapturedCall[] = Array.isArray(existing[key]) ? existing[key] : [];

  const idx = calls.findIndex(c =>
    c.method === patch.method &&
    c.url === patch.url &&
    Math.abs(c.timestamp - patch.timestamp) < MERGE_WINDOW_MS,
  );

  if (idx === -1) {
    calls.push(patch as CapturedCall);
  } else {
    const prev = calls[idx];
    // Whichever side is the interceptor record has the richer (JS-level)
    // request headers — never let a later, bare webRequest patch replace them.
    calls[idx] = {
      ...prev,
      ...patch,
      requestHeaders: prev.source === 'interceptor'
        ? (prev.requestHeaders ?? patch.requestHeaders)
        : (patch.requestHeaders ?? prev.requestHeaders),
      source: prev.source === 'interceptor' ? 'interceptor' : patch.source,
    };
  }

  // Retention cap — drop oldest entries first so a long/chatty session never
  // grows storage unbounded.
  if (calls.length > MAX_CALLS_PER_TAB) {
    calls = calls.slice(calls.length - MAX_CALLS_PER_TAB);
  }

  await chrome.storage.local.set({ [key]: calls });
  scheduleSettled(tabId);
}

// ─── Source 1: content.ts relay (page-level fetch/XHR capture) ────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'API_CALL_CAPTURED') {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      const payload = message.payload as Record<string, unknown>;
      upsertCall(tabId, {
        method: String(payload['method'] ?? 'GET').toUpperCase(),
        url: String(payload['url'] ?? ''),
        responseStatus: typeof payload['responseStatus'] === 'number' ? payload['responseStatus'] as number : 0,
        timestamp: typeof payload['timestamp'] === 'number' ? payload['timestamp'] as number : Date.now(),
        source: 'interceptor',
        requestHeaders: payload['requestHeaders'] as Record<string, string> | undefined,
        requestBody: payload['requestBody'],
        responseBody: payload['responseBody'],
        responseHeaders: payload['responseHeaders'] as Record<string, string> | undefined,
        triggerAction: payload['triggerAction'] as string | undefined,
        triggerElement: payload['triggerElement'] as string | undefined,
        domPath: payload['domPath'] as string | undefined,
        pageUrl: payload['pageUrl'] as string | undefined,
        activeComponent: payload['activeComponent'] as string | undefined,
      })
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true; // async response
    }
  }

  // Legacy relay for UI_CONTEXT_UPDATE (no longer strictly needed but harmless)
  if (message.type === 'UI_CONTEXT_UPDATE') {
    sendResponse({ received: true });
  }

  // Popup clicked "Recheck" — reset the settle timer for the given tab
  if (message.type === 'RECHECK_SETTLE') {
    const tabId = message.tabId as number | undefined;
    if (tabId !== undefined) {
      cancelSettled(tabId);
      scheduleSettled(tabId);
    }
    sendResponse({ ok: true });
  }

  return false;
});

// ─── Source 2: chrome.webRequest (network-layer capture) ──────────────────────
// Tracks start time + request headers per requestId so onCompleted/
// onErrorOccurred can report full endpoint details even for requests the
// page-level interceptor never saw at all.

const pending = new Map<string, { tabId: number; startTime: number; requestHeaders?: Record<string, string> }>();

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    pending.set(details.requestId, { tabId: details.tabId, startTime: details.timeStamp });
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest'] },
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const entry = pending.get(details.requestId);
    if (!entry || !details.requestHeaders) return;
    entry.requestHeaders = Object.fromEntries(details.requestHeaders.map(h => [h.name, h.value ?? '']));
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest'] },
  ['requestHeaders'],
);

function recordWebRequestCompletion(
  tabId: number,
  requestId: string,
  method: string,
  url: string,
  timeStamp: number,
  status: number,
  error?: string,
): void {
  if (tabId < 0 || url.startsWith('chrome-extension://')) return;

  const entry = pending.get(requestId);
  pending.delete(requestId);
  const startTime = entry?.startTime ?? timeStamp;

  // Use the request's *start* time (not completion time) as the merge-key
  // timestamp — interceptor.ts reports start time too, so both sources land
  // on (nearly) the same value, keeping the merge window tight and reliable
  // even for slow requests.
  const patch: Partial<CapturedCall> & { method: string; url: string; timestamp: number; source: 'webRequest' } = {
    method,
    url,
    responseStatus: status,
    time: Math.max(0, Math.round(timeStamp - startTime)),
    timestamp: startTime,
    source: 'webRequest',
    requestHeaders: entry?.requestHeaders,
  };
  if (error) patch.error = error;

  upsertCall(tabId, patch).catch(() => {});
}

chrome.webRequest.onCompleted.addListener(
  (details) => recordWebRequestCompletion(details.tabId, details.requestId, details.method, details.url, details.timeStamp, details.statusCode),
  { urls: ['<all_urls>'], types: ['xmlhttprequest'] },
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => recordWebRequestCompletion(details.tabId, details.requestId, details.method, details.url, details.timeStamp, 0, details.error),
  { urls: ['<all_urls>'], types: ['xmlhttprequest'] },
);

// ─── Clear data on tab navigation ────────────────────────────────────────────
// webNavigation.onBeforeNavigate fires exactly once per main-frame navigation
// (including reloads) and ignores iframe loads — unlike tabs.onUpdated which
// re-fires with status:'loading' whenever any iframe inside the tab loads,
// which would wipe captured calls mid-session.

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return; // main frame only
  cancelSettled(details.tabId);
  chrome.storage.local.remove([
    `qalens_${details.tabId}`,
    `qalens_settled_${details.tabId}`,
  ]);
  for (const [id, p] of pending) {
    if (p.tabId === details.tabId) pending.delete(id);
  }
});

// Page fully loaded — start quiet-period timer (captures lazy-loaded API calls too)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    scheduleSettled(tabId);
  }
});

// ─── Clear data on tab close ─────────────────────────────────────────────────
// Without this, a closed tab's captured calls sit in chrome.storage.local
// forever (onBeforeNavigate above only fires on navigation, not closure).

chrome.tabs.onRemoved.addListener((tabId) => {
  cancelSettled(tabId);
  chrome.storage.local.remove([
    `qalens_${tabId}`,
    `qalens_settled_${tabId}`,
  ]);
  for (const [id, p] of pending) {
    if (p.tabId === tabId) pending.delete(id);
  }
});

// One-time sweep for data orphaned by *previous* installs of this extension
// (before this listener existed) — removes qalens_<tabId>/qalens_settled_<tabId>
// keys, and legacy pre-rename apimapper_* keys, whose tab no longer exists.
async function sweepStaleTabData(): Promise<void> {
  const [all, openTabs] = await Promise.all([
    chrome.storage.local.get(null) as Promise<Record<string, unknown>>,
    chrome.tabs.query({}),
  ]);
  const openIds = new Set(openTabs.map(t => t.id));
  const stale = Object.keys(all).filter((k) => {
    const m = /^(?:qalens|qalens_settled|apimapper|apimapper_settled|apimapper_detected|qalens_detected)_(\d+)$/.exec(k);
    return m !== null && !openIds.has(Number(m[1]));
  });
  if (stale.length > 0) await chrome.storage.local.remove(stale);
}

// ─── Broadcast capture pause/resume to every tab ─────────────────────────────
// upsertCall() only gates the storage WRITE — without this, "Pause" would
// still let interceptor.ts/content.ts capture and relay data, just silently
// drop it here. Broadcasting SET_CAPTURING lets content.ts stop relaying at
// the source, so nothing leaves the page while paused.

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[CAPTURE_KEY]) return;
  const capturing = changes[CAPTURE_KEY].newValue !== false;
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      chrome.tabs.sendMessage(tab.id, { type: 'SET_CAPTURING', capturing }).catch(() => {});
    }
  });
});

// ─── Side panel — tab-specific ───────────────────────────────────────────────
// openPanelOnActionClick: false → Chrome does NOT auto-open the panel globally,
// so action.onClicked fires. We then open it only for the clicked tab.

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: false })
  .catch(() => {});

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.sidePanel.open({ tabId: tab.id }).catch(console.error);
});

// ─── Init ─────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ [CAPTURE_KEY]: true });
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch(() => {});
  sweepStaleTabData().catch(() => {});
});
