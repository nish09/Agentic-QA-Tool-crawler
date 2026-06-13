/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	// The require scope
/******/ 	var __webpack_require__ = {};
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/make namespace object */
/******/ 	(() => {
/******/ 		// define __esModule on exports
/******/ 		__webpack_require__.r = (exports) => {
/******/ 			if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
/******/ 				Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 			}
/******/ 			Object.defineProperty(exports, '__esModule', { value: true });
/******/ 		};
/******/ 	})();
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};
/*!********************************!*\
  !*** ./src/content/content.ts ***!
  \********************************/
__webpack_require__.r(__webpack_exports__);
/**
 * content.ts — ISOLATED world content script.
 * 1. Tracks DOM interactions (click, input, scroll, load) for UIContext.
 * 2. Bridges postMessage from the MAIN-world interceptor.ts → service worker.
 */
let lastUIContext = {
    pageUrl: window.location.href,
    triggerAction: 'load',
};
function sendUIContext(context) {
    chrome.runtime.sendMessage({
        type: 'UI_CONTEXT_UPDATE',
        payload: context,
    }).catch(() => { });
}
function getDOMPath(el) {
    const parts = [];
    let current = el;
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
    const target = e.target;
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
    const target = e.target;
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
    if (event.source !== window)
        return;
    if (event.data?.__src !== 'api-mapper-interceptor')
        return;
    if (event.data?.type !== 'API_MAPPER_CALL')
        return;
    const raw = event.data.payload;
    chrome.runtime.sendMessage({
        type: 'API_CALL_CAPTURED',
        payload: {
            ...raw,
            pageUrl: window.location.href,
            pageTitle: document.title,
            triggerAction: lastUIContext.triggerAction ?? 'unknown',
            triggerElement: lastUIContext.triggerElement,
            domPath: lastUIContext.domPath,
            activeComponent: lastUIContext.activeComponent,
        },
    }).catch(() => { });
});


/******/ })()
;
//# sourceMappingURL=content.js.map