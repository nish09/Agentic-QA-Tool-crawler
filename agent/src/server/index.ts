import 'dotenv/config';
import express, { Request, Response } from 'express';
import { join } from 'path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { crawl, CrawledPage } from '../crawler';
import { deduplicateCalls, endpointKey } from '../parser';
import { inferDBMappings } from '../inference';
import { scanLocators, highlightLocatorOnPage } from '../locators';
import type { CapturedAPICall } from '@qalens/shared/types';

const app  = express();
const PORT = Number(process.env['PORT'] ?? 3000);

app.use(express.static(join(__dirname, 'public')));
// DOM snapshots ingested from the Chrome extension can be a couple MB each —
// generous but bounded so a runaway page can't exhaust server memory.
app.use(express.json({ limit: '10mb' }));

// In-memory store for last crawl (for exports)
let lastCrawlCalls: CapturedAPICall[] = [];
let lastCrawlPages: CrawledPage[]     = [];

// ── SSE helper ───────────────────────────────────────────────────────────────
function sseHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
}
function send(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ── 1. API Crawl ─────────────────────────────────────────────────────────────
app.get('/api/crawl', async (req: Request, res: Response) => {
  const targetUrl = req.query['url'] as string | undefined;
  const maxPages  = Number(req.query['maxPages'] ?? 10);

  if (!targetUrl) { res.status(400).json({ error: 'url param required' }); return; }

  sseHeaders(res);
  send(res, 'status', { message: `Starting crawl of ${targetUrl}…` });

  const allCalls: CapturedAPICall[] = [];
  const allPages: CrawledPage[]     = [];

  try {
    const { pagesVisited } = await crawl({
      url: targetUrl,
      maxPages,
      headless: true,
      onPageVisit: (pageUrl, visited, queued) => {
        send(res, 'page', { pageUrl, visited, queued });
      },
      onCall: (call) => {
        allCalls.push(call);
        send(res, 'call', call);
      },
      onPageCaptured: (page) => {
        allPages.push(page);
        send(res, 'dompage', { index: page.index, url: page.url, title: page.title, elementCount: page.elements.length });
      },
      onScreenshot: (b64, pageUrl, pageIndex) => {
        send(res, 'screenshot', { screenshot: b64, pageUrl, pageIndex, maxPages });
      },
    });

    send(res, 'status', { message: `Crawl complete. Running AI inference on ${allCalls.length} calls…` });

    const unique = deduplicateCalls(allCalls);
    const hasAIProvider = Boolean(process.env['ANTHROPIC_API_KEY'] || process.env['OLLAMA_URL']);

    // Infer once per unique endpoint (method+pathname), then broadcast that
    // result to every raw call sharing the endpoint — the UI renders one row
    // per raw call, so without this, any row that wasn't the first occurrence
    // of its endpoint would never receive an 'inference' event and would be
    // stuck showing "analyzing…" forever.
    const tablesByEndpoint = new Map<string, CapturedAPICall['inferredDBTables']>();
    for (const call of unique) {
      call.inferredDBTables = hasAIProvider ? await inferDBMappings(call) : [];
      tablesByEndpoint.set(endpointKey(call), call.inferredDBTables);
    }
    for (const call of allCalls) {
      send(res, 'inference', { id: call.id, tables: tablesByEndpoint.get(endpointKey(call)) ?? [] });
    }

    lastCrawlCalls = unique;
    lastCrawlPages = allPages;

    send(res, 'complete', {
      totalCalls:      allCalls.length,
      uniqueEndpoints: unique.length,
      pagesVisited:    pagesVisited.length,
      domPages:        allPages.length,
    });
  } catch (err: unknown) {
    send(res, 'error', { message: err instanceof Error ? err.message : String(err) });
  }

  res.end();
});

// ── 2. Page Locators ─────────────────────────────────────────────────────────
app.get('/api/locators', async (req: Request, res: Response) => {
  const targetUrl = req.query['url'] as string | undefined;
  if (!targetUrl) { res.status(400).json({ error: 'url param required' }); return; }

  sseHeaders(res);
  send(res, 'status', { message: `Scanning locators on ${targetUrl}…` });

  try {
    const results = await scanLocators(targetUrl);
    for (const r of results) {
      send(res, 'locator', r);
    }
    send(res, 'complete', { total: results.length });
  } catch (err: unknown) {
    send(res, 'error', { message: err instanceof Error ? err.message : String(err) });
  }

  res.end();
});

// ── 2b. Page Locators — hover-to-highlight ───────────────────────────────────
// The dashboard runs headless (often in Docker with no display), so there's
// no live tab to hover over the way the Chrome extension has. Instead, the
// still-open scan session's page is highlighted + screenshotted on demand and
// shown as a live preview image.
app.get('/api/locators/highlight', async (req: Request, res: Response) => {
  const uid = req.query['uid'] as string | undefined;
  if (!uid) { res.status(400).json({ error: 'uid param required' }); return; }

  const screenshot = await highlightLocatorOnPage(uid);
  if (!screenshot) { res.status(404).json({ error: 'Element not found — try re-scanning the page.' }); return; }
  res.json({ screenshot });
});

// ── 3. Export: JSON ──────────────────────────────────────────────────────────
app.get('/api/export/json', (_req: Request, res: Response) => {
  if (lastCrawlCalls.length === 0) { res.status(404).json({ error: 'No data. Run a crawl first.' }); return; }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="qalens-report.json"');
  res.send(JSON.stringify(lastCrawlCalls, null, 2));
});

// ── 4. Export: Excel ─────────────────────────────────────────────────────────
app.get('/api/export/excel', async (_req: Request, res: Response) => {
  if (lastCrawlCalls.length === 0) { res.status(404).json({ error: 'No data. Run a crawl first.' }); return; }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'QALens Agent v2';
  const sheet = wb.addWorksheet('API Map');
  sheet.columns = [
    { header: 'UI Page', key: 'page', width: 45 },
    { header: 'Method', key: 'method', width: 10 },
    { header: 'Endpoint', key: 'endpoint', width: 55 },
    { header: 'Status', key: 'status', width: 10 },
    { header: 'Request Payload', key: 'request', width: 40 },
    { header: 'Response Fields', key: 'fields', width: 50 },
    { header: 'Inferred DB Table', key: 'tables', width: 35 },
    { header: 'Confidence', key: 'confidence', width: 15 },
  ];
  const hdr = sheet.getRow(1);
  hdr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };

  for (const c of lastCrawlCalls) {
    let ep = c.url;
    try { ep = new URL(c.url).pathname; } catch { /* keep full URL */ }
    sheet.addRow({
      page: c.uiContext?.pageUrl ?? '',
      method: c.method,
      endpoint: ep,
      status: c.responseStatus,
      request: c.requestPayload ? JSON.stringify(c.requestPayload).slice(0, 200) : '',
      fields: c.responseSchema?.properties ? Object.keys(c.responseSchema.properties).join(', ') : '',
      tables: c.inferredDBTables?.map(t => t.inferredTable).filter((v,i,a) => a.indexOf(v)===i).join(', ') ?? '',
      confidence: c.inferredDBTables?.[0]?.confidence ?? '',
    });
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="qalens-report.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});

// ── 5. Export: DOM ZIP ───────────────────────────────────────────────────────
app.get('/api/export/zip', async (_req: Request, res: Response) => {
  if (lastCrawlPages.length === 0) { res.status(404).json({ error: 'No DOM data. Run a crawl first.' }); return; }

  const zip     = new JSZip();
  const folder  = zip.folder('pages')!;

  zip.file('manifest.json', JSON.stringify({
    tool: 'QALens Agent v2',
    generatedAt: new Date().toISOString(),
    baseUrl: lastCrawlPages[0]?.url ?? '',
    totalPages: lastCrawlPages.length,
    pages: lastCrawlPages.map(p => ({
      index: p.index, url: p.url, title: p.title,
      htmlFile: `pages/page-${String(p.index).padStart(3,'0')}.html`,
      jsonFile: `pages/page-${String(p.index).padStart(3,'0')}.json`,
      elementCount: p.elements.length,
      linkCount: p.links.length,
      capturedAt: new Date(p.timestamp).toISOString(),
    })),
  }, null, 2));

  for (const p of lastCrawlPages) {
    const pad = String(p.index).padStart(3, '0');
    folder.file(`page-${pad}.html`, p.dom);
    folder.file(`page-${pad}.json`, JSON.stringify({
      url: p.url, title: p.title,
      capturedAt: new Date(p.timestamp).toISOString(),
      elements: p.elements, links: p.links,
    }, null, 2));
  }

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="qalens-dom-${Date.now()}.zip"`);
  res.send(buf);
});

// ── 6. Extension link — manual DOM capture ───────────────────────────────────
// The agent's own crawler is headless and can't be driven by hand. The Chrome
// extension's Crawler tab already supports manual browsing + DOM capture, so
// instead of duplicating that here, the extension can opt in to POSTing each
// page it captures to this endpoint, and any dashboard client with the DOM
// Collector tab open sees it appear live via SSE — same visual flow as an
// automatic crawl's 'dompage' events.

const manualStreamClients = new Set<Response>();

function extensionCorsOrigin(req: Request): string | undefined {
  const origin = req.headers.origin;
  // Scope this to extension origins rather than reflecting any site's origin —
  // a plain web page has no reason to be able to write into the dashboard's
  // captured-pages list.
  return origin?.startsWith('chrome-extension://') ? origin : undefined;
}

app.get('/api/dom/manual-stream', (req: Request, res: Response) => {
  sseHeaders(res);
  manualStreamClients.add(res);
  req.on('close', () => { manualStreamClients.delete(res); });
});

app.post('/api/dom/ingest', (req: Request, res: Response) => {
  const allowOrigin = extensionCorsOrigin(req);
  if (allowOrigin) res.setHeader('Access-Control-Allow-Origin', allowOrigin);

  const page = req.body?.page as Partial<CrawledPage> | undefined;
  if (!page?.url || typeof page.dom !== 'string') {
    res.status(400).json({ error: 'Expected { page: CrawledPage }' });
    return;
  }

  const crawledPage: CrawledPage = {
    index: lastCrawlPages.length + 1,
    url: page.url,
    title: page.title ?? '',
    dom: page.dom,
    links: page.links ?? [],
    elements: page.elements ?? [],
    timestamp: page.timestamp ?? Date.now(),
  };
  lastCrawlPages.push(crawledPage);

  for (const client of manualStreamClients) {
    send(client, 'dompage', {
      index: crawledPage.index,
      url: crawledPage.url,
      title: crawledPage.title,
      elementCount: crawledPage.elements.length,
    });
  }

  res.json({ ok: true, index: crawledPage.index });
});

// Preflight for the ingest POST above — browsers send OPTIONS first for a
// cross-origin request with a JSON body.
app.options('/api/dom/ingest', (req: Request, res: Response) => {
  const allowOrigin = extensionCorsOrigin(req);
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  res.status(204).end();
});

app.listen(PORT, () => {
  console.log('');
  console.log('QALens Dashboard');
  console.log('────────────────────────────');
  console.log(`Open → http://localhost:${PORT}`);
  console.log('────────────────────────────');
  console.log('');
});
