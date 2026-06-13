/**
 * devtools.ts
 * Registers the API Mapper panel inside Chrome DevTools.
 * This runs in the DevTools context, not the page context.
 */

chrome.devtools.panels.create(
  'API Mapper',        // Panel title shown in DevTools tab
  'icons/icon16.png',  // Panel icon
  'panel.html',        // Panel UI entry point
  (panel) => {
    console.log('[API Mapper] DevTools panel registered', panel);
  }
);
