# API Mapper Tool — Claude Code Project Context

## 🧠 What This Project Is
A tool that automatically discovers all APIs used by any web application,
maps UI components to their API calls, infers likely database schema from
response payloads, and generates a professional data mapping document.

## 🎯 Target User
QA Engineers and Business Analysts who are non-technical and cannot use
DevTools, Burp Suite, or Postman manually. They need to understand what
APIs exist in a product they are testing — without asking a developer.

---

## 🗺 Product Roadmap

### ✅ Phase 1 — Chrome Extension (CURRENT PHASE — BUILD THIS FIRST)
A DevTools Chrome Extension that:
- Intercepts all XHR / Fetch / WebSocket calls on any page the user visits
- Displays a clean panel inside Chrome DevTools:
  Endpoint | Method | Status | Request Payload | Response Preview
- Lets the user filter, search, and tag API calls
- Exports a CSV / JSON report of all discovered APIs
- Maps which DOM section / UI element triggered each API call
- 100% local — no data sent to any server

### 🔜 Phase 2 — Internal Agent (Docker)
An autonomous Playwright agent that:
- Accepts a URL as input (including internal/private URLs)
- Crawls the app headlessly, clicks through all UI interactions
- Intercepts and captures all network calls automatically
- Runs entirely inside a Docker container (company private network safe)
- Uses Claude API for intelligent schema inference
- Falls back to Ollama + Llama 3 for fully air-gapped deployments

### 🔜 Phase 3 — Document Generation
Generates professional output:
- Excel data mapping sheet: UI Section → API → Response Fields → DB Table
- PDF report for stakeholders
- Interactive web dashboard to browse and filter the full API map

### 🔜 Phase 4 — SaaS Web Tool
- Public web app where users paste a URL and get a full report
- Freemium pricing model
- Team collaboration features

---

## 🏗 Architecture Overview

### Chrome Extension (Phase 1)
```
chrome.devtools.network API    → captures all network requests
chrome.devtools.panels API     → adds panel inside DevTools
DOM MutationObserver           → tracks which UI element was active
chrome.storage.local           → stores captured data locally
TypeScript + Webpack           → build system
```

### Internal Agent (Phase 2)
```
Playwright (TypeScript)        → headless browser automation
page.on('request/response')    → network interception
Claude API (claude-sonnet-4-6) → schema inference + DB mapping
Docker                         → internal/private deployment
Ollama + Llama 3               → air-gapped fallback
exceljs                        → Excel output
pdfkit                         → PDF output
FastAPI (Python) or Express    → optional REST API wrapper
SQLite → PostgreSQL            → data storage
```

---

## ⚙️ Tech Stack

| Layer              | Technology                        |
|--------------------|-----------------------------------|
| Language           | TypeScript (strict mode)          |
| Extension Build    | Webpack + ts-loader               |
| Browser Automation | Playwright                        |
| AI Inference       | Claude API (claude-sonnet-4-6)    |
| Local LLM Fallback | Ollama + Llama 3                  |
| Excel Output       | exceljs                           |
| PDF Output         | pdfkit                            |
| Containerization   | Docker + Docker Compose           |
| Storage (MVP)      | SQLite                            |
| Storage (Prod)     | PostgreSQL                        |
| Frontend Dashboard | React + TypeScript + Tailwind     |
| Hosting            | Vercel (frontend) + Railway (API) |

---

## 📁 Folder Structure

```
api-mapper-tool/
├── chrome-extension/           ← Phase 1 (BUILD FIRST)
│   ├── src/
│   │   ├── devtools/           ← DevTools panel UI + logic
│   │   ├── background/         ← Service worker / background script
│   │   ├── content/            ← Content scripts injected into pages
│   │   └── popup/              ← Extension popup UI
│   ├── public/
│   │   ├── manifest.json       ← Chrome extension manifest (v3)
│   │   └── devtools.html       ← DevTools panel entry HTML
│   ├── webpack.config.ts
│   ├── tsconfig.json
│   └── package.json
│
├── agent/                      ← Phase 2 (build in parallel)
│   ├── src/
│   │   ├── crawler/            ← Playwright crawling logic
│   │   ├── parser/             ← API response parsing + schema extraction
│   │   ├── inference/          ← Claude API / Ollama AI inference
│   │   └── output/             ← Excel, PDF, JSON document generation
│   ├── docker/
│   │   ├── Dockerfile
│   │   └── docker-compose.yml
│   ├── tsconfig.json
│   └── package.json
│
├── shared/                     ← Types and utils shared across phases
│   ├── types/
│   │   └── index.ts            ← Shared TypeScript interfaces
│   └── utils/
│       └── index.ts            ← Shared utility functions
│
├── docs/                       ← Documentation
│   └── architecture.md
│
├── CLAUDE.md                   ← YOU ARE HERE
└── README.md
```

---

## 🧩 Shared TypeScript Types (Key Interfaces)

```typescript
// All phases use these core types
interface CapturedAPICall {
  id: string;
  timestamp: number;
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
  requestHeaders: Record<string, string>;
  requestPayload?: unknown;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody?: unknown;
  responseSchema?: JSONSchema;
  uiContext?: UIContext;
  inferredDBTables?: DBTableMapping[];
}

interface UIContext {
  pageUrl: string;
  activeComponent?: string;
  triggerElement?: string;
  triggerAction?: 'click' | 'scroll' | 'load' | 'input' | 'unknown';
}

interface DBTableMapping {
  fieldPath: string;
  inferredTable: string;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

interface JSONSchema {
  type: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
}
```

---

## 🤖 AI Inference Instructions (for Claude API calls)

When calling Claude API for schema inference, always use this system prompt pattern:

```
You are a database schema inference expert.
Given an API endpoint URL and its JSON response body,
infer the likely database tables and fields this data comes from.
Return JSON only. No explanation. No markdown.
Confidence levels: high (obvious naming), medium (reasonable guess), low (speculative).
```

---

## 📋 Coding Standards

- **TypeScript strict mode** — always (`"strict": true` in tsconfig)
- **Async/await** — never raw Promises
- **Error handling** — try/catch on ALL async operations
- **Comments** — JSDoc on all exported functions
- **No any** — use `unknown` and type guards instead
- **Modular** — one responsibility per file
- **Naming** — camelCase for variables, PascalCase for types/interfaces

---

## 🚀 Current Task

**Build Phase 1: Chrome Extension MVP**

Start with:
1. `chrome-extension/public/manifest.json` — Chrome Manifest V3
2. `chrome-extension/src/devtools/panel.ts` — Main DevTools panel
3. `chrome-extension/src/background/service-worker.ts` — Background script
4. `chrome-extension/webpack.config.ts` — Build config
5. `chrome-extension/package.json` — Dependencies

---

## 🔗 Key References

- Chrome Extensions Manifest V3: https://developer.chrome.com/docs/extensions/mv3
- chrome.devtools.network API: https://developer.chrome.com/docs/extensions/reference/devtools_network
- Playwright Docs: https://playwright.dev/docs/intro
- Claude API Docs: https://docs.anthropic.com/en/api/overview
- exceljs: https://github.com/exceljs/exceljs
