# Sucai Agent API

把素材下载器的真实能力暴露成带 JSON Schema 的工具，供任意 Agent（Tcode、Claude Code、
Codex、任何 MCP 客户端）直接调用。契约见
`personal-agent-hub/docs/AGENT_API_STANDARD.md`，只监听 `127.0.0.1`。

## 启动

```bash
npm run agent:serve        # node agent/server.mjs（默认 8792，被占自动 +1 并写 agent/.endpoint）
npm run agent:mcp          # MCP stdio 桥；服务没起时它会按 agent/launch.json 自己拉起来
```

```
GET  /api/health          健康与版本
GET  /api/agent/tools     工具清单（name / description / input_schema / risk）
GET  /api/agent/manifest  项目元信息 + 工具清单
POST /api/agent/tool      唯一调用入口，body = {tool, input}
```

## 工具

| 工具 | risk | 说明 |
| --- | --- | --- |
| `sucai.sources.list` | read | 列出全部已接入素材源的真实可用性：是否配置密钥、媒体类型、能否按 id 直取、本机搜索缓存条数 |
| `sucai.sources.probe` | read | 对某个源发一次最小搜索，返回是否可用、延迟、样例与失败归类 |
| `sucai.search` | read | 跨源统一搜索（复用项目插件与并发/重试/去重逻辑），结果按源分组，含每个源的状态与失败出路 |
| `sucai.asset.get` | read | 按 `source` + `sourceId` 取详情与直链；支持 id 直取的源现取平台最新数据，其余回读搜索缓存 |
| `sucai.download` | exec | 批量下载并真实写盘，返回每条绝对路径与字节数。**必须显式 `confirm: true`** |
| `sucai.downloads.list` | read | 读本机已下载记录（与界面同一份历史），可按源与关键词过滤，并核对文件是否仍在 |
| `sucai.settings.get` | read | 读应用设置；API Key 只返回是否已配置与长度，**永不回显内容** |

搜索、下载、详情与界面走同一套插件与存储，没有第二份实现。

## 安全边界

实现集中在 `electron/core/local-guard.cjs`（与 frameboost 的 `local-guard.ts` 同一套判据），
`agent/server.mjs` 在每个请求解析 URL 之前先过它：

- **只绑 `127.0.0.1`**：`listenLocal` 拒绝绑定到其他地址，端口被占会如实报原因（不再有空 catch）。
- **Host 逐字回环白名单**：只接受 `127.0.0.1:<本服务端口>` / `localhost:<端口>` / `[::1]:<端口>`；
  其余一律 403 JSON。判据是固定白名单，**绝不拿 Origin 去和请求自己的 Host 比** —— 那正是
  DNS rebinding 的洞（页面把域名解析到 127.0.0.1 后两者自然相等）。
- **Origin / Referer**：没带就放行（curl、node fetch、MCP 桥都不带）；带了就必须落在回环上，
  外来 Origin（含 `null`、`file://`）一律 403。
- **非 GET 需要本机令牌**：请求头 `x-sucai-token: <令牌>`（也接受 `Authorization: Bearer <令牌>`）。
  令牌首次启动时生成到 `<userData>/agent-token`（POSIX 上 chmod 600；Windows 上真实隔离来自
  它位于当前用户的 `%APPDATA%` 里，mode 位只是尽力而为），**不在仓库工作树内**。
  用 `SUCAI_API_TOKEN` 可覆盖；`agent/mcp-server.mjs` 从同一个入口取值，所以桥照旧能直接用。
- **永不发通配 CORS**：响应头里不会出现 `Access-Control-Allow-*`，`OPTIONS` 预检被显式拒绝 ——
  能写盘的接口不欢迎任意网页发跨源 POST。
- **下载目标受管**：直链先解析 DNS，解析结果落在回环 / RFC1918 / 链路本地与云元数据端点 /
  组播 / 保留段就拒绝，重定向的每一跳都重查（`electron/core/ssrf.cjs`）。
- 密钥只报"是否配置"，不出值。
- 唯一写盘工具 `sucai.download` 标 `risk: exec`，缺 `confirm: true` 直接拒绝。

## 调试时绕开守卫（只对本机回环有效）

```bash
set SUCAI_API_TOKEN=<读出来的令牌>      # 或者直接把请求发到 127.0.0.1:8792 并带上 x-sucai-token
```

Host / Origin 两道没有开关：伪造它们就是不该被服务。
