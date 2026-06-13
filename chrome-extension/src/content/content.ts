/**
 * content.ts — ISOLATED world content script.
 * 1. Tracks DOM interactions (click, input, scroll, load) for UIContext.
 * 2. Bridges postMessage from the MAIN-world interceptor.ts → service worker.
 */

import type { UIContext, TriggerAction } from '../../../shared/types';

let lastUIContext: UIContext = {
  pageUrl: window.location.href,
  triggerAction: 'load',
};

function sendUIContext(context: UIContext): void {
  chrome.runtime.sendMessage({
    type: 'UI_CONTEXT_UPDATE',
    payload: context,
  }).catch(() => {});
}

function getDOMPath(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
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
  const target = e.target as Element;
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
  const target = e.target as Element;
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
  if (event.source !== window) return;
  if (event.data?.__src !== 'api-mapper-interceptor') return;
  if (event.data?.type !== 'API_MAPPER_CALL') return;

  const raw = event.data.payload as Record<string, unknown>;

  chrome.runtime.sendMessage({
    type: 'API_CALL_CAPTURED',
    payload: {
      ...raw,
      pageUrl:       window.location.href,
      pageTitle:     document.title,
      triggerAction: lastUIContext.triggerAction ?? 'unknown',
      triggerElement: lastUIContext.triggerElement,
      domPath:       (lastUIContext as UIContext & { domPath?: string }).domPath,
      activeComponent: lastUIContext.activeComponent,
    },
  }).catch(() => {});
});
