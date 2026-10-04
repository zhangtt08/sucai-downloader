# sucai — Stock Asset Search & Downloader

One search box for **8** free stock sources — Unsplash, Pexels, Pixabay, Giphy, Flickr, Wikimedia Commons, the Met Museum and the Art Institute of Chicago — with previews and batch download, in a single Windows desktop app.
一个界面聚合搜索 **8** 个免费素材源，缩略图预览、大图预览、批量下载到本地（Windows 桌面应用）。

Hunting for free images and GIFs usually means opening five tabs, searching each site separately, and downloading one file at a time. **sucai** puts all the sources behind a single search bar in an Electron app: one query fans out to every configured source in parallel, results land in one thumbnail grid, and you batch-download whatever you pick.

[中文说明](README.zh-CN.md)

![License](https://img.shields.io/badge/license-MIT-green)
![Platform](https://img.shields.io/badge/platform-Windows-blueviolet)
![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)

## 🗂️ Sources

The table below is the registry itself: `electron/plugins/registry.js` registers exactly these eight plugins, and `npm run verify-docs` fails if this list or the count above drifts from it.

| source | what you get | media | key |
|---|---|---|---|
| `unsplash` | Unsplash photography | image | free API key |
| `pexels` | Pexels photos + videos | image, video | free API key |
| `pixabay` | Pixabay photos + videos | image, video | free API key |
| `giphy` | Giphy GIFs (saved as `.gif`) | image | free API key |
| `flickr` | Flickr photos (mixed licences) | image | free API key |
| `wikimedia` | Wikimedia Commons | image | none |
| `met` | Met Museum — the Metropolitan Museum of Art open-access collection | image | none |
| `artic` | Art Institute of Chicago — public-domain IIIF images | image | none |

No `vimeo` plugin is registered. Vimeo-hosted clips are **not** a source of their own: they arrive as ordinary `pixabay` results, because Pixabay's video API returns Vimeo-hosted files (the only Vimeo string in the codebase is the `i.vimeocdn.com` thumbnail URL in `electron/plugins/pixabay.js`).

## ✨ Features

- **One query, eight sources** — parallel search with an automatic retry on transient network failures; a failing source is reported without sinking the whole search
- **Three sources need zero setup** — Wikimedia Commons, the Met (`met`) and the Art Institute of Chicago (`artic`) work out of the box; the other five take a free API key pasted into the in-app settings dialog
- **Preview before you commit** — thumbnail grid plus a full-size preview panel
- **Batch download** — pick multiple assets, watch per-task progress, pause / resume / cancel (in-flight transfers included), save to any local folder
- **Local-only secrets** — API keys are stored in app-local settings (`%APPDATA%\sucai\settings.json`), never synced or committed; the UI only ever sees "configured / length"
- **Plugin architecture** — every source is a small module in `electron/plugins/`, so adding a source is a single file
- **Local agent API** — a loopback-only HTTP interface (`npm run agent:serve`) exposes the same search/download capability to agents and MCP clients

## 🚀 Quick Start

Prerequisites: **Node.js 20.19+** (see `engines` in `package.json`) and Windows.

```powershell
git clone https://github.com/zhangtt08/sucai.git
cd sucai
npm install
npm run electron:dev   # dev mode (Vite + Electron, renderer on http://localhost:5188)
npm run package        # builds dist/ then emits a portable .exe into release/
```

`npm run package` runs `electron-builder --win`, and `electron-builder.yml` targets `portable`: the result is a single self-contained `素材下载器-<version>.exe` in `release/`, not an installer — there is no setup wizard, no start-menu entry and no uninstaller.

After launching, open the in-app Settings dialog and paste free API keys for Unsplash / Pexels / Pixabay / Giphy / Flickr (get them from each platform's developer portal). Wikimedia Commons, the Met and the Art Institute of Chicago need no key.

Other scripts: `npm run typecheck` (TS only), `npm test` (node:test suite, offline — it uses a local HTTP fixture, never the real stock sites), `npm run verify-docs` (README ↔ registry honesty gate), `npm run verify` (all of the above plus the build).

## 🏗️ Architecture

```
src/            React UI (TypeScript) — search bar, thumbnail grid, preview, download panel, settings
electron/       Main process, preload bridge, core modules (core/*.cjs) and per-source plugins (plugins/*.js)
agent/          Loopback HTTP agent API (server.mjs) + tools.mjs + MCP stdio bridge
resources/      App icons
```

Pipeline: renderer → IPC (`search` / `download`) → plugin registry → every configured plugin queried in parallel (`Promise.allSettled`, one automatic retry) → merged thumbnail grid. Downloads stream through the main process and report progress events back to the UI.

Security boundaries worth knowing before you wire this into an agent:

- Download targets are resolved and refused when DNS points at loopback, RFC1918, link-local/metadata (169.254.169.254) or multicast addresses — re-checked on every redirect hop (`electron/core/ssrf.cjs`).
- Saved paths are contained: the resolved file must stay inside the download directory, and the length check runs after the " (2)" uniquifier (`electron/core/downloads.cjs`).
- The agent API binds `127.0.0.1` only, requires a literal loopback `Host`, rejects foreign `Origin`/`Referer`, and needs a per-user token for every non-GET call (`electron/core/local-guard.cjs`).

## 🤖 Agent API

A local HTTP API lets external agents use Sucai as a tool — standalone, no GUI needed:

```bash
npm run agent:serve      # node agent/server.mjs → http://127.0.0.1:8792
npm run agent:mcp        # MCP stdio bridge (starts the server itself if it is down)
```

The GUI is not required; the server reuses the API keys saved by the Settings dialog. If port 8792 is taken it walks upward and writes the real address to `agent/.endpoint`.

| Endpoint | Method | Body | Result |
|---|---|---|---|
| `/api/health` | GET | — | `{ok, data: {project, version, agent_api, tools, uptime_ms}}` |
| `/api/agent/tools` | GET | — | tool list (`name`, `description`, `input_schema`, `risk`) |
| `/api/agent/manifest` | GET | — | project metadata + tool list |
| `/api/agent/tool` | POST | `{tool, input}` | `{ok, tool, ms, data}` — the single call entry point |

Seven tools are registered (`sucai.sources.list`, `sucai.sources.probe`, `sucai.search`, `sucai.asset.get`, `sucai.download`, `sucai.downloads.list`, `sucai.settings.get`) — see [`agent/README.md`](agent/README.md). Non-GET calls must carry the token header `x-sucai-token: <SUCAI_API_TOKEN>`; the token is generated on first start into `<userData>/agent-token` (chmod 0600, outside the repo) and `npm run agent:mcp` reads it for you. Port override: `AGENT_PORT`.

## 📄 License

[MIT](LICENSE)
