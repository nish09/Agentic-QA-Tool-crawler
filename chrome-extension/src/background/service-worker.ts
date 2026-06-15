/**
 * service-worker.ts — MV3 background service worker.
 * Receives API_CALL_CAPTURED messages from content.ts and persists them
 * to chrome.storage.local under the key "qalens_<tabId>".
 * Clears per-tab data when the tab navigates to a new URL.
 */

const CAPTURE_KEY = 'qalens_capturing';
const MAX_BODY    = 5000;
const SETTLE_MS   = 2500; // quiet-period before marking a tab as "done"

function truncateBody(value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_BODY) return value.slice(0, MAX_BODY) + '…';
  return value;
}

// ─── Settle detection ─────────────────────────────────────────────────────────
// After SETTLE_MS of no new captured calls (or page fully loaded), the tab is
// marked settled so the popup can show "Done / Recheck" instead of "Pause".
// setTimeout is reliable here because the service worker is kept alive by the
// open side-panel port while the user is watching the panel.

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
  // Remove any previously persisted settled flag so the popup reverts to "Live"
  chrome.storage.local.remove([`qalens_settled_${tabId}`]);
}

async function storeCapturedCall(tabId: number, payload: Record<string, unknown>): Promise<void> {
  // Respect pause state
  const flags = await chrome.storage.local.get(CAPTURE_KEY) as Record<string, unknown>;
  if (flags[CAPTURE_KEY] === false) return;

  cancelSettled(tabId); // new call arriving — not settled yet

  const key = `qalens_${tabId}`;
  const existing = await chrome.storage.local.get(key) as Record<string, unknown[]>;
  const calls: unknown[] = Array.isArray(existing[key]) ? existing[key] : [];

  const entry = {
    ...payload,
    responseBody: truncateBody(payload['responseBody']),
    requestBody:  truncateBody(payload['requestBody']),
  };

  calls.push(entry);
  await chrome.storage.local.set({ [key]: calls });

  scheduleSettled(tabId); // restart quiet-period timer after storing
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

// ─── Independent network counter (chrome.webRequest) ─────────────────────────
// Counts ALL xmlhttprequest completions at the Chrome network layer,
// including service-worker-initiated fetches that interceptor.ts cannot see.
// Storage key: qalens_detected_<tabId> (plain number).

chrome.webRequest.onCompleted.addListener(
  async (details) => {
    if (details.tabId < 0) return;
    if (details.url.startsWith('chrome-extension://')) return;

    const flags = await chrome.storage.local.get(CAPTURE_KEY) as Record<string, unknown>;
    if (flags[CAPTURE_KEY] === false) return;

    const key = `qalens_detected_${details.tabId}`;
    const existing = await chrome.storage.local.get(key) as Record<string, unknown>;
    const count = typeof existing[key] === 'number' ? (existing[key] as number) : 0;
    await chrome.storage.local.set({ [key]: count + 1 });
  },
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
    `qalens_detected_${details.tabId}`,
    `qalens_settled_${details.tabId}`,
  ]);
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
});
