/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/*!******************************************!*\
  !*** ./src/background/service-worker.ts ***!
  \******************************************/

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
const CAPTURE_KEY = 'qalens_capturing';
const MAX_BODY = 5000;
const SETTLE_MS = 2500; // quiet-period before marking a tab as "done"
const MERGE_WINDOW_MS = 4000; // same method+url within this window = same request
function truncateBody(value) {
    if (typeof value === 'string' && value.length > MAX_BODY)
        return value.slice(0, MAX_BODY) + '…';
    return value;
}
// ─── Settle detection ─────────────────────────────────────────────────────────
// After SETTLE_MS of no new captured calls (or page fully loaded), the tab is
// marked settled so the popup can show "Done / Recheck" instead of "Pause".
const settledTimers = new Map();
function scheduleSettled(tabId) {
    const prev = settledTimers.get(tabId);
    if (prev)
        clearTimeout(prev);
    settledTimers.set(tabId, setTimeout(async () => {
        settledTimers.delete(tabId);
        await chrome.storage.local.set({ [`qalens_settled_${tabId}`]: true });
    }, SETTLE_MS));
}
function cancelSettled(tabId) {
    const t = settledTimers.get(tabId);
    if (t) {
        clearTimeout(t);
        settledTimers.delete(tabId);
    }
    chrome.storage.local.remove([`qalens_settled_${tabId}`]);
}
// ─── Merge a partial call record into the per-tab list ────────────────────────
// Matches an existing entry by method+url within MERGE_WINDOW_MS so the two
// capture sources enrich the same logical request instead of duplicating it.
// A bare webRequest patch never demotes a row that already has rich
// interceptor data (body/headers/trigger context).
async function upsertCall(tabId, patch) {
    const flags = await chrome.storage.local.get(CAPTURE_KEY);
    if (flags[CAPTURE_KEY] === false)
        return;
    cancelSettled(tabId);
    const key = `qalens_${tabId}`;
    const existing = await chrome.storage.local.get(key);
    const calls = Array.isArray(existing[key]) ? existing[key] : [];
    const idx = calls.findIndex(c => c.method === patch.method &&
        c.url === patch.url &&
        Math.abs(c.timestamp - patch.timestamp) < MERGE_WINDOW_MS);
    if (idx === -1) {
        calls.push(patch);
    }
    else {
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
    await chrome.storage.local.set({ [key]: calls });
    scheduleSettled(tabId);
}
// ─── Source 1: content.ts relay (page-level fetch/XHR capture) ────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'API_CALL_CAPTURED') {
        const tabId = sender.tab?.id;
        if (tabId !== undefined) {
            const payload = message.payload;
            upsertCall(tabId, {
                method: String(payload['method'] ?? 'GET').toUpperCase(),
                url: String(payload['url'] ?? ''),
                responseStatus: typeof payload['responseStatus'] === 'number' ? payload['responseStatus'] : 0,
                timestamp: typeof payload['timestamp'] === 'number' ? payload['timestamp'] : Date.now(),
                source: 'interceptor',
                requestHeaders: payload['requestHeaders'],
                requestBody: truncateBody(payload['requestBody']),
                responseBody: truncateBody(payload['responseBody']),
                responseHeaders: payload['responseHeaders'],
                triggerAction: payload['triggerAction'],
                triggerElement: payload['triggerElement'],
                domPath: payload['domPath'],
                pageUrl: payload['pageUrl'],
                activeComponent: payload['activeComponent'],
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
        const tabId = message.tabId;
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
const pending = new Map();
chrome.webRequest.onBeforeRequest.addListener((details) => {
    if (details.tabId < 0)
        return;
    pending.set(details.requestId, { tabId: details.tabId, startTime: details.timeStamp });
}, { urls: ['<all_urls>'], types: ['xmlhttprequest'] });
chrome.webRequest.onBeforeSendHeaders.addListener((details) => {
    const entry = pending.get(details.requestId);
    if (!entry || !details.requestHeaders)
        return;
    entry.requestHeaders = Object.fromEntries(details.requestHeaders.map(h => [h.name, h.value ?? '']));
}, { urls: ['<all_urls>'], types: ['xmlhttprequest'] }, ['requestHeaders']);
function recordWebRequestCompletion(tabId, requestId, method, url, timeStamp, status, error) {
    if (tabId < 0 || url.startsWith('chrome-extension://'))
        return;
    const entry = pending.get(requestId);
    pending.delete(requestId);
    const startTime = entry?.startTime ?? timeStamp;
    // Use the request's *start* time (not completion time) as the merge-key
    // timestamp — interceptor.ts reports start time too, so both sources land
    // on (nearly) the same value, keeping the merge window tight and reliable
    // even for slow requests.
    const patch = {
        method,
        url,
        responseStatus: status,
        time: Math.max(0, Math.round(timeStamp - startTime)),
        timestamp: startTime,
        source: 'webRequest',
        requestHeaders: entry?.requestHeaders,
    };
    if (error)
        patch.error = error;
    upsertCall(tabId, patch).catch(() => { });
}
chrome.webRequest.onCompleted.addListener((details) => recordWebRequestCompletion(details.tabId, details.requestId, details.method, details.url, details.timeStamp, details.statusCode), { urls: ['<all_urls>'], types: ['xmlhttprequest'] });
chrome.webRequest.onErrorOccurred.addListener((details) => recordWebRequestCompletion(details.tabId, details.requestId, details.method, details.url, details.timeStamp, 0, details.error), { urls: ['<all_urls>'], types: ['xmlhttprequest'] });
// ─── Clear data on tab navigation ────────────────────────────────────────────
// webNavigation.onBeforeNavigate fires exactly once per main-frame navigation
// (including reloads) and ignores iframe loads — unlike tabs.onUpdated which
// re-fires with status:'loading' whenever any iframe inside the tab loads,
// which would wipe captured calls mid-session.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
    if (details.frameId !== 0)
        return; // main frame only
    cancelSettled(details.tabId);
    chrome.storage.local.remove([
        `qalens_${details.tabId}`,
        `qalens_settled_${details.tabId}`,
    ]);
    for (const [id, p] of pending) {
        if (p.tabId === details.tabId)
            pending.delete(id);
    }
});
// Page fully loaded — start quiet-period timer (captures lazy-loaded API calls too)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete') {
        scheduleSettled(tabId);
    }
});
// ─── Side panel — tab-specific ───────────────────────────────────────────────
// openPanelOnActionClick: false → Chrome does NOT auto-open the panel globally,
// so action.onClicked fires. We then open it only for the clicked tab.
chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch(() => { });
chrome.action.onClicked.addListener((tab) => {
    if (!tab.id)
        return;
    chrome.sidePanel.open({ tabId: tab.id }).catch(console.error);
});
// ─── Init ─────────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.set({ [CAPTURE_KEY]: true });
    chrome.sidePanel
        .setPanelBehavior({ openPanelOnActionClick: false })
        .catch(() => { });
});

/******/ })()
;
//# sourceMappingURL=background.js.map