/**
 * interceptor.ts — runs in the page's MAIN JavaScript world.
 * Declared in manifest.json with "world": "MAIN" and "run_at": "document_start".
 *
 * Patches window.fetch and XMLHttpRequest to intercept every API call.
 * Sends data to the ISOLATED-world content.ts via window.postMessage.
 * Has zero Chrome extension API access — communicates only via postMessage.
 */

const MSG_SOURCE = 'api-mapper-interceptor';

function emit(payload: Record<string, unknown>): void {
  // Skip extension-internal requests to avoid infinite loops
  if (typeof payload['url'] === 'string' && payload['url'].startsWith('chrome-extension://')) return;
  window.postMessage({ __src: MSG_SOURCE, type: 'API_MAPPER_CALL', payload }, '*');
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

// ─── Patch fetch ──────────────────────────────────────────────────────────────

const _fetch = window.fetch.bind(window);

window.fetch = async function (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url =
    input instanceof URL    ? input.href :
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
  const timestamp = Date.now();

  const response = await _fetch(input, init);

  // Clone before reading so the original stream is untouched
  const clone = response.clone();
  let responseBody: unknown = null;
  try {
    const ct = (response.headers.get('content-type') ?? '').toLowerCase();
    const isBinary = ct.startsWith('image/') || ct.startsWith('audio/') ||
                     ct.startsWith('video/') || ct.startsWith('font/');
    if (!isBinary) {
      const text = await clone.text();
      if (text) {
        try { responseBody = JSON.parse(text); } catch { responseBody = text.slice(0, 5000); }
      }
    }
  } catch { /* ignore read errors */ }

  emit({
    url,
    method,
    requestHeaders,
    requestBody,
    responseStatus: response.status,
    responseHeaders: headersToObj(response.headers),
    responseBody,
    timestamp,
  });

  return response;
};

// ─── Patch XMLHttpRequest ─────────────────────────────────────────────────────

// Use unique string keys prefixed with a rare string to avoid property clashes
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

    let responseBody: unknown = null;
    try {
      const ct = (this.getResponseHeader('content-type') ?? '').toLowerCase();
      const isBinary = ct.startsWith('image/') || ct.startsWith('audio/') ||
                       ct.startsWith('video/') || ct.startsWith('font/');
      if (!isBinary && (this.responseType === '' || this.responseType === 'text')) {
        const text = this.responseText ?? '';
        if (text) {
          try { responseBody = JSON.parse(text); }
          catch { responseBody = text.slice(0, 5000); }
        }
      }
    } catch { /* ignore */ }

    const responseHeaders: Record<string, string> = {};
    try {
      for (const line of (this.getAllResponseHeaders() ?? '').trim().split('\r\n')) {
        const sep = line.indexOf(': ');
        if (sep > 0) responseHeaders[line.slice(0, sep).toLowerCase()] = line.slice(sep + 2);
      }
    } catch { /* ignore */ }

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
