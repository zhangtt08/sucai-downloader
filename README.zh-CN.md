# 素材下载器 (sucai)

[English](README.md)

Windows 桌面素材搜索下载工具（Electron + React + TypeScript）：一个界面聚合搜索 **8** 个免费素材源，缩略图预览、大图预览、批量下载到本地。

## 聚合的素材源

下表就是注册表本身：`electron/plugins/registry.js` 只注册这八个插件，`npm run verify-docs` 会在名单或数量与实际注册情况不一致时直接失败。

| source | 名称 | 类型 | 需要密钥 |
|---|---|---|---|
| `unsplash` | Unsplash | 高质量图片 | 免费 API Key |
| `pexels` | Pexels | 图片 + 视频 | 免费 API Key |
| `pixabay` | Pixabay | 图片 + 视频 | 免费 API Key |
| `giphy` | Giphy（下载得到 .gif） | GIF | 免费 API Key |
| `flickr` | Flickr（授权逐张不同） | 图片 | 免费 API Key |
| `wikimedia` | Wikimedia Commons | 图片 | 免 key |
| `met` | 大都会艺术馆（Met Museum 开放藏品） | 图片 | 免 key |
| `artic` | 芝加哥艺术馆（公共领域 IIIF 直链） | 图片 | 免 key |

没有注册 `vimeo` 插件：Vimeo 不是独立素材源，它只是 `pixabay` 视频接口返回的 Vimeo 托管文件（代码里唯一的 Vimeo 字样是 `electron/plugins/pixabay.js` 中的 `i.vimeocdn.com` 缩略图地址）。

## 功能特性

- **一次搜索，八源并发**：并行请求所有已启用素材源，网络偶发超时自动重试一次；单个来源失败不影响整体结果，只提示告警
- **三个来源免配置**：Wikimedia Commons、大都会艺术馆（`met`）、芝加哥艺术馆（`artic`）开箱即用；其余五个在应用内设置面板（SettingsDialog）粘贴免费 API key 即可
- **先预览再下载**：缩略图网格 + 大图预览
- **批量下载**：多选素材、逐任务进度、暂停/继续/取消（含在途传输）、保存到任意本地文件夹
- **密钥仅存本地**：API key 保存在本地设置（`%APPDATA%\sucai\settings.json`），不入库、不同步；界面侧只拿得到"是否已配置 + 长度"
- **插件化架构**：每个素材源是 `electron/plugins/` 下的一个独立模块
- **本机 Agent 接口**：只监听 127.0.0.1 的 HTTP 接口（`npm run agent:serve`），让 agent / MCP 客户端直接调用搜索与下载

## 运行

前置要求：Node.js 20.19+（见 `package.json` 的 `engines`），Windows。

```powershell
npm install
npm run electron:dev      # 开发模式（Vite + Electron，渲染层在 http://localhost:5188）
npm run package           # 打包产物写入 release/
npm run verify            # typecheck + 单测 + build + README 与注册表一致性检查
```

`npm run package` 走 `electron-builder --win`，而 `electron-builder.yml` 的 target 是 `portable`：`release/` 里得到的是单个自包含 exe（`${productName}-${version}.exe`），双击即运行 —— 不是安装向导，不写开始菜单，也没有卸载入口。

各素材源的 API key 在应用内设置面板（SettingsDialog）配置，密钥保存在本地，不入库。

## 安全边界

- **下载目标受管**：先解析 DNS，再按解析结果拒绝回环、RFC1918、链路本地/元数据（169.254.169.254）与组播地址，每一个重定向跳都重查一次（`electron/core/ssrf.cjs`）
- **落盘路径受管**：最终文件必须留在下载目录内，长度体检在 `uniquePath` 追加 " (2)" 之后再做一次（`electron/core/downloads.cjs`）
- **本机接口受管**：只绑 127.0.0.1、`Host` 逐字回环白名单、外来 `Origin`/`Referer` 一律 403 JSON、非 GET 需要本机令牌、永不发 `Access-Control-Allow-Origin: *`（`electron/core/local-guard.cjs`）

## 项目结构

```
src/            React 界面（搜索栏 / 缩略图网格 / 预览 / 下载面板 / 设置）
electron/       主进程、预加载脚本、核心模块（core/*.cjs）与各素材源插件（plugins/*.js）
agent/          本机 Agent HTTP 接口（server.mjs）、工具实现（tools.mjs）与 MCP stdio 桥
resources/      应用图标
```

## 测试

`npm test` 用 node:test 跑 `scripts/` 与 `tests/` 下的用例，全部离线：联网相关的用例只打本机 `http.Server` 夹具（见 `scripts/check-downloads.cjs`），不会去访问任何素材平台。

## 🤖 Agent API

内置本地 HTTP 接口，可让你的 agent 把素材搜索/下载当 tool 调用——无需打开界面：

```bash
npm run agent:serve        # node agent/server.mjs → http://127.0.0.1:8792
npm run agent:mcp          # MCP stdio 桥；服务没起时它自己按 agent/launch.json 拉起来
```

不依赖界面进程，key 复用设置面板保存的那一份。8792 被占用时自动向上加一并把真实地址写进 `agent/.endpoint`。

| 路由 | 方法 | 请求体 | 返回 |
|---|---|---|---|
| `/api/health` | GET | — | `{ok, data: {project, version, agent_api, tools, uptime_ms}}` |
| `/api/agent/tools` | GET | — | 工具清单（name / description / input_schema / risk） |
| `/api/agent/manifest` | GET | — | 项目元信息 + 工具清单 |
| `/api/agent/tool` | POST | `{tool, input}` | `{ok, tool, ms, data}` —— 唯一调用入口 |

已注册 7 个工具（`sucai.sources.list`、`sucai.sources.probe`、`sucai.search`、`sucai.asset.get`、`sucai.download`、`sucai.downloads.list`、`sucai.settings.get`），详见 [`agent/README.md`](agent/README.md)。非 GET 请求必须带 `x-sucai-token: <SUCAI_API_TOKEN>`；令牌首次启动时生成到 `<userData>/agent-token`（0600，在仓库之外），`npm run agent:mcp` 会自己读取。端口覆盖：`AGENT_PORT`。

## 许可证

[MIT](LICENSE)
