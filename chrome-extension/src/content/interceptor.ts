/**
 * interceptor.ts — runs in the page's MAIN JavaScript world.
 * Declared in manifest.json with "world": "MAIN" and "run_at": "document_start".
 *
 * Patches window.fetch and XMLHttpRequest to intercept every API call.
 * Sends data to the ISOLATED-world content.ts via window.postMessage.
 * Has zero Chrome extension API access — communicates only via postMessage.
 */

const MSG_SOURCE = 'qalens-interceptor';

// Bodies larger than this are never buffered/parsed — only their size is
// recorded. Parsing a multi-MB JSON string on every request is the actual
// CPU/memory cost we're guarding against; real API responses are almost
// always well under this.
const MAX_CAPTURE_BYTES = 1_000_000;

function emit(payload: Record<string, unknown>): void {
  if (typeof payload['url'] === 'string' && payload['url'].startsWith('chrome-extension://')) return;
  window.postMessage({ __src: MSG_SOURCE, type: 'QALENS_CALL', payload }, '*');
}

// ─── Skip patching in cross-origin iframes ────────────────────────────────────
// With all_frames:true, every ad/tracker/widget iframe on the page gets its
// own fetch/XHR patch — on ad-heavy pages that multiplies interception
// overhead many times over for frames the user never cares about. Accessing
// window.top.location throws for cross-origin frames, which conveniently
// doubles as the detection check.
function isThirdPartyFrame(): boolean {
  if (window === window.top) return false;
  try {
    void window.top?.location.href;
    return false; // same-origin iframe — likely part of the app itself
  } catch {
    return true; // cross-origin — skip
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function headersToObj(headers: HeadersInit | null | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((v, k) => { out[k] = v; });
    return out;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers as [string, string][]);
  return { ...(headers as Record<string, string>) };
}

function parseBody(body: unknown): unknown {
  if (body == null) return undefined;
  if (typeof body === 'string' && body.length > 0) {
    try { return JSON.parse(body); } catch { return body; }
  }
  if (body instanceof FormData) return '[FormData]';
  if (body instanceof Blob)     return '[Blob]';
  if (body instanceof ArrayBuffer) return '[ArrayBuffer]';
  return body;
}

function isBinaryContentType(ct: string): boolean {
  return ct.startsWith('image/') ||
         ct.startsWith('audio/') ||
         ct.startsWith('video/') ||
         ct.startsWith('font/')  ||
         ct === 'application/octet-stream' ||
         ct === 'application/pdf' ||
         ct === 'application/zip' ||
         ct.startsWith('application/wasm');
}

function decodeText(raw: string): unknown {
  if (raw.length === 0) return '(empty body)';
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '(empty body)';
  if (raw.length > MAX_CAPTURE_BYTES) {
    // Skip JSON.parse on huge text — that parse is the expensive part, not the
    // slice below. Still surface a preview so the user knows something was there.
    return raw.slice(0, 5000) + `… [truncated — body is ${raw.length.toLocaleString()} bytes]`;
  }
  try { return JSON.parse(trimmed); } catch { /* not JSON */ }
  return raw.length > 5000 ? raw.slice(0, 5000) + '…' : raw;
}

// ─── Patch fetch ──────────────────────────────────────────────────────────────

if (!isThirdPartyFrame()) {

const _fetch = window.fetch.bind(window);

window.fetch = async function (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url =
    input instanceof URL      ? input.href :
    typeof input === 'string' ? input :
    (input as Request).url;

  const method = (
    init?.method
    ?? (typeof input !== 'string' && !(input instanceof URL) ? (input as Request).method : undefined)
    ?? 'GET'
  ).toUpperCase();

  const requestHeaders = headersToObj(
    init?.headers
    ?? (typeof input !== 'string' && !(input instanceof URL) ? (input as Request).headers : undefined),
  );
  const requestBody = parseBody(init?.body);
  const timestamp   = Date.now();

  const response = await _fetch(input, init);

  // ── Body capture ─────────────────────────────────────────────────────────
  // We consume the original response body directly with .text() instead of
  // clone().text() — clone() silently returns '' for certain response types
  // in the MAIN world (opaque, early-body, some cross-origin patterns).
  // After reading, we reconstruct a new Response for the page so it can still
  // call .json() / .text() normally.
  let responseBody: unknown;
  let responseForPage: Response = response;

  try {
    const ct = (response.headers.get('content-type') ?? '').toLowerCase();

    const clHeader = response.headers.get('content-length');
    const contentLength = clHeader ? parseInt(clHeader, 10) : NaN;

    if (isBinaryContentType(ct)) {
      responseBody = `[Binary: ${ct || 'unknown'}]`;
      // Binary: return original response untouched — body unread, page uses it normally
    } else if (!Number.isNaN(contentLength) && contentLength > MAX_CAPTURE_BYTES) {
      // Known-large body: skip reading and reconstructing entirely — that work
      // (buffering + rebuilding a Response) is itself the CPU/memory cost for
      // big payloads. Let the page's original response through untouched.
      responseBody = `[Large body: ${contentLength.toLocaleString()} bytes — not captured]`;
    } else {
      // Consume body from the original response stream
      const rawText = await response.text();
      responseBody  = decodeText(rawText);

      // Reconstruct a Response with the same body for the page.
      // Strip content-encoding (browser already decoded; forwarding it would cause
      // double-decode errors) and content-length (byte count changed after decoding).
      const newHeaders = new Headers(response.headers);
      newHeaders.delete('content-encoding');
      newHeaders.delete('content-length');

      responseForPage = new Response(rawText, {
        status:     response.status,
        statusText: response.statusText,
        headers:    newHeaders,
      });
    }
  } catch (e) {
    responseBody = `(read error: ${e instanceof Error ? e.message : String(e)})`;
    // responseForPage stays as the original — page may still recover
  }

  emit({
    url,
    method,
    requestHeaders,
    requestBody,
    responseStatus:  response.status,
    responseHeaders: headersToObj(response.headers),
    responseBody,
    timestamp,
  });

  return responseForPage;
};

// ─── Patch XMLHttpRequest ─────────────────────────────────────────────────────

const P = '__am_';

const _xhrOpen   = XMLHttpRequest.prototype.open;
const _xhrHeader = XMLHttpRequest.prototype.setRequestHeader;
const _xhrSend   = XMLHttpRequest.prototype.send;

/* eslint-disable @typescript-eslint/no-explicit-any */
XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: unknown[]) {
  (this as any)[P + 'm'] = method.toUpperCase();
  (this as any)[P + 'u'] = typeof url === 'string' ? url : url.href;
  (this as any)[P + 'h'] = {} as Record<string, string>;
  return (_xhrOpen as any).apply(this, [method, url, ...rest]);
};

XMLHttpRequest.prototype.setRequestHeader = function (name: string, value: string) {
  const hdrs = (this as any)[P + 'h'];
  if (hdrs) hdrs[name] = value;
  return _xhrHeader.call(this, name, value);
};

XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
  (this as any)[P + 'b'] = body ?? null;
  (this as any)[P + 't'] = Date.now();

  this.addEventListener('loadend', function (this: any) {
    const xhrUrl = this[P + 'u'];
    if (!xhrUrl) return;

    // ── XHR body capture ───────────────────────────────────────────────────
    let responseBody: unknown;
    try {
      const ct      = (this.getResponseHeader('content-type') ?? '').toLowerCase();
      const rType   = this.responseType as string;

      if (isBinaryContentType(ct)) {
        responseBody = `[Binary: ${ct || 'unknown'}]`;
      } else if (rType === 'json') {
        // When responseType='json' the browser parses it; responseText is empty.
        // The browser already paid the parse cost, but we still cap what we
        // forward/store so a huge parsed object doesn't bloat storage unbounded.
        const cl = parseInt(this.getResponseHeader('content-length') ?? '', 10);
        responseBody = (!Number.isNaN(cl) && cl > MAX_CAPTURE_BYTES)
          ? `[Large body: ${cl.toLocaleString()} bytes — not captured]`
          : (this.response ?? '(empty body)');
      } else if (rType === '' || rType === 'text') {
        responseBody = decodeText(this.responseText ?? '');
      } else if (rType === 'document') {
        // Try to get the outer HTML from the parsed document
        const doc = this.response as Document | null;
        const html = doc?.documentElement?.outerHTML ?? '';
        responseBody = html.length > 0
          ? (html.length > 5000 ? html.slice(0, 5000) + '…' : html)
          : '[HTML/XML Document]';
      } else {
        // 'arraybuffer', 'blob', or unknown — cannot read as text
        responseBody = `[${rType || 'unknown'} response — body not readable]`;
      }
    } catch (e) {
      // Surface errors so the user sees WHY the body is missing, not just null
      responseBody = `(read error: ${e instanceof Error ? e.message : String(e)})`;
    }

    // ── Response headers ───────────────────────────────────────────────────
    const responseHeaders: Record<string, string> = {};
    try {
      for (const line of (this.getAllResponseHeaders() ?? '').trim().split('\r\n')) {
        const sep = line.indexOf(': ');
        if (sep > 0) responseHeaders[line.slice(0, sep).toLowerCase()] = line.slice(sep + 2);
      }
    } catch { /* headers not available — not fatal */ }

    emit({
      url:            xhrUrl,
      method:         this[P + 'm'] ?? 'GET',
      requestHeaders: this[P + 'h'] ?? {},
      requestBody:    parseBody(this[P + 'b']),
      responseStatus: this.status,
      responseHeaders,
      responseBody,
      timestamp:      this[P + 't'] ?? Date.now(),
    });
  });

  return _xhrSend.call(this, body);
};
/* eslint-enable @typescript-eslint/no-explicit-any */

} // end isThirdPartyFrame guard
