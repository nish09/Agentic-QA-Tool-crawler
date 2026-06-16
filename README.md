# 🗺 API Mapper Tool

> Automatically discover all APIs used by any web application, map UI components to API calls, infer database schema, and generate professional data mapping documents.

Built for **QA Engineers** and **Business Analysts** who need to understand what APIs exist in a product they're testing — without asking a developer.

---

## 🚀 Product Roadmap

| Phase | What | Status |
|-------|------|--------|
| **Phase 1** | Chrome Extension — intercept & display APIs | 🔨 In Progress |
| **Phase 2** | Internal Docker Agent — autonomous crawling | 📋 Planned |
| **Phase 3** | Document Generation — Excel, PDF, Dashboard | 📋 Planned |
| **Phase 4** | SaaS Web Tool — freemium public product | 📋 Planned |

---

## 📁 Project Structure

```
api-mapper-tool/
├── chrome-extension/    ← Phase 1 MVP (build this first)
├── agent/               ← Phase 2 (Playwright + Claude AI)
├── shared/              ← Shared TypeScript types + utils
└── docs/                ← Architecture + documentation
```

---

## 🛠 Tech Stack

- **TypeScript** (strict mode)
- **Playwright** — headless browser automation
- **Claude API** — AI-powered schema inference
- **Chrome Extensions Manifest V3**
- **Docker** — internal/private deployment
- **exceljs** + **pdfkit** — document generation

---

## ⚡ Getting Started — Phase 1 Chrome Extension

```bash
cd chrome-extension
npm install
npm run build
```

Then load the `dist/` folder as an unpacked extension in Chrome:
1. Open `chrome://extensions`
2. Enable **Developer Mode**
3. Click **Load unpacked**
4. Select the `chrome-extension/dist/` folder
5. Open DevTools on any website → click the **API Mapper** tab

---

## 🤖 Claude Code Integration

This project is designed to be built with **Claude Code CLI**.

```bash
# Install Claude Code
npm install -g @anthropic-ai/claude-code

# Open your project
cd api-mapper-tool
code .

# In VSCode terminal, start Claude Code
claude
```

The `CLAUDE.md` file at the root gives Claude full context of the project architecture, tech stack, coding standards, and current phase.

---

## 📄 License

MIT — free to use, modify, and distribute.
