/**
 * service-worker.ts — MV3 background service worker.
 * Receives API_CALL_CAPTURED messages from content.ts and persists them
 * to chrome.storage.local under the key "apimapper_<tabId>".
 * Clears per-tab data when the tab navigates to a new URL.
 */

const CAPTURE_KEY = 'apimapper_capturing';
const MAX_BODY = 5000;

function truncateBody(value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_BODY) return value.slice(0, MAX_BODY) + '…';
  return value;
}

async function storeCapturedCall(tabId: number, payload: Record<string, unknown>): Promise<void> {
  // Respect pause state
  const flags = await chrome.storage.local.get(CAPTURE_KEY) as Record<string, unknown>;
  if (flags[CAPTURE_KEY] === false) return;

  const key = `apimapper_${tabId}`;
  const existing = await chrome.storage.local.get(key) as Record<string, unknown[]>;
  const calls: unknown[] = Array.isArray(existing[key]) ? existing[key] : [];

  const entry = {
    ...payload,
    responseBody: truncateBody(payload['responseBody']),
    requestBody:  truncateBody(payload['requestBody']),
  };

  calls.push(entry);
  await chrome.storage.local.set({ [key]: calls });
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'API_CALL_CAPTURED') {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      storeCapturedCall(tabId, message.payload as Record<string, unknown>)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true; // async response
    }
  }

  // Legacy relay for UI_CONTEXT_UPDATE (no longer strictly needed but harmless)
  if (message.type === 'UI_CONTEXT_UPDATE') {
    sendResponse({ received: true });
  }

  return false;
});

// ─── Independent network counter (chrome.webRequest) ─────────────────────────
// Counts ALL xmlhttprequest completions at the Chrome network layer,
// including service-worker-initiated fetches that interceptor.ts cannot see.
// Storage key: apimapper_detected_<tabId> (plain number).

chrome.webRequest.onCompleted.addListener(
  async (details) => {
    if (details.tabId < 0) return;
    if (details.url.startsWith('chrome-extension://')) return;

    const flags = await chrome.storage.local.get(CAPTURE_KEY) as Record<string, unknown>;
    if (flags[CAPTURE_KEY] === false) return;

    const key = `apimapper_detected_${details.tabId}`;
    const existing = await chrome.storage.local.get(key) as Record<string, unknown>;
    const count = typeof existing[key] === 'number' ? (existing[key] as number) : 0;
    await chrome.storage.local.set({ [key]: count + 1 });
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest'] },
);

// ─── Clear data on tab navigation ────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    chrome.storage.local.remove([
      `apimapper_${tabId}`,
      `apimapper_detected_${tabId}`,
    ]);
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ [CAPTURE_KEY]: true });
  // Open the side panel (instead of popup) when the toolbar icon is clicked
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
