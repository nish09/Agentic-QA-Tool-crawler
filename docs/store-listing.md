# Chrome Web Store listing copy (draft)

Reference content for the Developer Dashboard submission form. Review/edit
before pasting in — nothing here is published automatically.

---

## Short description (max 132 characters)

> Discover every API call a web app makes, map it to the UI, and generate
> Playwright/Selenium locators — built for QA, no DevTools needed.

(131 chars)

---

## Detailed description

```
QALens helps QA Engineers and Business Analysts understand what APIs a web
application actually uses — without needing to read code or operate
DevTools, Burp Suite, or Postman.

WHAT IT DOES
• Captures every API call (fetch/XHR) made by the page you're testing:
  method, full URL, status code, response time, headers, and bodies.
• Generates ready-to-use Playwright and Selenium element locators for any
  interactive element on the page, so you can drop them straight into your
  test scripts.
• Exports captured endpoints as CSV or JSON — handy for building a data
  mapping document or sharing findings with developers.

PRIVACY, BY DESIGN
• 100% local. QALens has no backend — nothing it captures is ever sent
  anywhere. Everything lives in your browser's local storage.
• Sensitive values (Authorization/Cookie headers, password/token-like body
  fields) are automatically redacted before they're ever stored.
• Pause anytime, clear data anytime, and data auto-clears when you navigate
  away or close the tab.

WHO IT'S FOR
QA Engineers, Business Analysts, and anyone who needs to map an application's
API surface but isn't comfortable with developer tooling.
```

---

## Permission justifications

Paste into the corresponding field for each permission in the Developer
Dashboard's "Privacy practices" / permissions justification section.

**Host permission — all sites (`<all_urls>`)**
> QALens's core function is mapping the API calls made by whatever web
> application the user is actively testing. Since that can be any site, on
> any domain, chosen by the user at the time they're testing it, the
> extension needs the ability to observe network activity on whatever page
> the user opens it on. It does not run any logic on a page until the user
> opens the QALens side panel for that tab. See the privacy policy for the
> redaction and retention safeguards applied to anything captured.

**webRequest**
> Used in observe-only mode (never blocking/modifying requests) as a second,
> timing-independent capture path alongside our page-level fetch/XHR
> instrumentation. This catches requests that fire before our page-level
> code attaches (common during initial page load) and network errors that
> a page-level fetch wrapper can never observe directly.

**tabs / activeTab**
> Used only to determine which browser tab the currently open QALens side
> panel should display captured data for, and to know when the user switches
> tabs so the panel can update accordingly. QALens does not read tab
> titles/URLs outside of this purpose.

**storage**
> Used to persist captured API call data locally in the browser
> (chrome.storage.local) so it survives the side panel being closed and
> reopened. Never synced or transmitted anywhere.

**sidePanel**
> The UI surface QALens uses to display captured calls and generated
> locators.

**webNavigation**
> Used to detect when the user navigates to a new page so that tab's
> previously captured call data can be cleared, keeping each tab's panel
> scoped to its current page.

---

## Screenshots needed (not yet captured)

1. Side panel open on a real site, showing several captured endpoints with
   method badges, status, and timing.
2. The detail/expand view for a single endpoint (query params + headers).
3. Page Locators tab showing generated Playwright/Selenium locators for a
   page's interactive elements.
4. (Optional) The Copy CSV/JSON export buttons with the "Copied" confirmation
   state.

Recommended size: 1280x800 or 640x400, PNG/JPEG.
