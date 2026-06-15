/**
 * devtools.ts
 * Registers the QALens panel inside Chrome DevTools.
 * This runs in the DevTools context, not the page context.
 */

chrome.devtools.panels.create(
  'QALens',        // Panel title shown in DevTools tab
  'icons/icon16.png',  // Panel icon
  'panel.html',        // Panel UI entry point
  (panel) => {
    console.log('[QALens] DevTools panel registered', panel);
  }
);
