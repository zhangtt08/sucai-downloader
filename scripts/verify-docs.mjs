#!/usr/bin/env node
// 文档诚实性闸门 —— 用户定的第一条规矩：代码不支持的数字不许写进文档。
// 只读、不改任何东西：README 里声称的素材源数量/名单必须等于
// electron/plugins/registry.js 实际注册的结果，否则退出码 1 并说清差在哪一条。
// 顺带守同类漂移：npm run 脚本是否存在、打包 target 与文案、Agent 端口/路由/工具数量、Node 版本要求。
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const failures = [];
const measured = [];
const fail = (check, detail) => failures.push(`${check}: ${detail}`);
const ok = (check, detail) => measured.push(`${check}: ${detail}`);

async function loadModule(relativeFromRoot) {
  try {
    return await import(pathToFileURL(path.join(ROOT, relativeFromRoot)).href);
  } catch (error) {
    fail('module-read', `读不了 ${relativeFromRoot}：${error.message}`);
    return null;
  }
}

// 中文/英文数词 → 数字（README 会写 "eight sources"、"八源并发" 这种形式）
const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function toNumber(token) {
  if (/^\d+$/.test(token)) return Number(token);
  const lower = String(token).toLowerCase();
  if (WORD_NUMBERS[lower] !== undefined) return WORD_NUMBERS[lower];
  const match = /^(十|[一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(token);
  if (match) {
    const tens = match[1] ? WORD_NUMBERS[match[1]] || 1 : 1;
    const ones = match[2] ? WORD_NUMBERS[match[2]] : 0;
    return tens * 10 + ones;
  }
  return null;
}

function readDoc(name) {
  const file = path.join(ROOT, name);
  if (!fs.existsSync(file)) {
    fail('doc-missing', `${name} 不存在`);
    return '';
  }
  return fs.readFileSync(file, 'utf-8');
}

// 「免配置的源有几张」是一句独立声明（真实数字 = needsKey=false 的注册数），
// 必须先单独识别，否则会被"总数"那条模式误吞成数量造假。
const KEYLESS_PATTERNS = [
  /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:free\s+)?sources?\s+(?:need|with|of)\s+zero\s+setup\b/gi,
  /(\d{1,2}|[一二三四五六七八九十]+)\s*个?来源免配置/g,
];

// 「一共有几个源」的声明（英中两套写法）
const COUNT_PATTERNS = [
  /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:free\s+)?(?:stock\s+)?sources?\b/gi,
  /(\d{1,2}|[一二三四五六七八九十])\s*(?:大|个)?\s*免费素材源/g,
  /(\d{1,2}|[一二三四五六七八九十])\s*源并发/g,
  /聚合\s*(\d{1,2}|[一二三四五六七八九十])\s*个?素材源/g,
];

function keylessClaims(text) {
  const claims = [];
  for (const pattern of KEYLESS_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = toNumber(match[1]);
      if (value !== null) claims.push({ value, raw: match[0], text: match[0].trim(), index: match.index });
    }
  }
  return claims;
}

// 把已经归给「免配置」的句子挖空，剩下的才是"总数"声明
function maskRanges(text, claims) {
  let masked = text;
  for (const claim of claims) {
    const from = claim.index;
    const to = from + claim.raw.length;
    masked = `${masked.slice(0, from)}${' '.repeat(claim.raw.length)}${masked.slice(to)}`;
  }
  return masked;
}

function countClaims(text) {
  const claims = [];
  for (const pattern of COUNT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = toNumber(match[1]);
      if (value !== null) claims.push({ value, text: match[0].trim() });
    }
  }
  return claims;
}

// 解析素材源清单表：`## Sources` / `## 聚合的素材源` 之后第一张表的数据行
function sourceTableRows(text) {
  const heading = text.search(/^#{1,3}\s.*(Sources|聚合的素材源).*$/im);
  if (heading < 0) return null;
  const lines = text.slice(heading).split(/\r?\n/);
  const rows = [];
  let pastHeader = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      if (pastHeader) break;
      continue;
    }
    const cells = trimmed.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2) continue;
    if (/^:?-{2,}:?$/.test(cells[0].replace(/`/g, ''))) {
      pastHeader = true;
      continue;
    }
    if (pastHeader) rows.push(cells);
  }
  return rows.length ? rows : null;
}

function linesMentioning(text, word) {
  return text.split(/\r?\n/).filter((line) => new RegExp(word, 'i').test(line));
}

async function main() {
  const registry = require(path.join(ROOT, 'electron/plugins/registry.js'));
  registry.initPluginRegistry({});
  const sources = registry.describeSources();
  const registeredNames = sources.map((source) => source.name);
  ok('registry', `已注册 ${registeredNames.length} 个素材源：${registeredNames.join(', ')}`);

  const pkg = require(path.join(ROOT, 'package.json'));
  const scripts = Object.keys(pkg.scripts || {});
  const serverSource = fs.readFileSync(path.join(ROOT, 'agent/server.mjs'), 'utf-8');
  const servedRoutes = [...serverSource.matchAll(/route === '(\/api\/[^']+)'/g)].map((match) => match[1]);
  const toolsModule = await loadModule('agent/tools.mjs');
  const toolNames = toolsModule ? toolsModule.tools.map((tool) => tool.name) : [];
  const serverModule = await loadModule('agent/server.mjs');
  const defaultPort = serverModule && typeof serverModule.DEFAULT_PORT === 'number' ? serverModule.DEFAULT_PORT : null;
  if (defaultPort === null) fail('agent-port', 'agent/server.mjs 没有导出 DEFAULT_PORT，端口声明无从核对');

  // electron-builder.yml 的真实产物形态（数量与名单之外的另一类"文档吹牛"）
  const builderYml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf-8');
  const declaredTargets = [...new Set(
    builderYml
      .split(/\r?\n/)
      .filter((line) => /^\s*(-?\s*target:|target:)/.test(line))
      .flatMap((line) => [...line.matchAll(/\b(portable|nsis|appx|msi|oneclick|zip|deb|rpm|tar|squirrel)\b/gi)].map((match) => match[1].toLowerCase())),
  )];
  const installerTargets = ['nsis', 'appx', 'msi', 'oneclick', 'squirrel'];
  const producesInstaller = declaredTargets.some((target) => installerTargets.includes(target));
  ok('electron-builder', `win.target = ${declaredTargets.join('/') || '未知'}（${producesInstaller ? '安装程序' : '免安装的单个可执行文件'}）`);

  const docs = ['README.md', 'README.zh-CN.md'];
  for (const name of docs) {
    const text = readDoc(name);
    if (!text) continue;
    // 加粗/行内代码会把 "8** free stock sources" 这种声明拆开，模式匹配前先把强调符号摊平
    const flat = text.replace(/\*\*|`|__/g, ' ');

    // 1) 素材源数量：每一处声明都要等于注册表实测；找不到声明也算失败（不许靠删声明绕过）
    const keyless = keylessClaims(flat);
    const keylessCount = sources.filter((source) => !source.needsKey).length;
    for (const claim of keyless) {
      if (claim.value !== keylessCount) {
        fail('keyless-count', `${name} 写的是「${claim.text}」= ${claim.value}，免配置（needsKey=false）的注册源实测 ${keylessCount}`);
      }
    }
    if (keyless.length && keyless.every((claim) => claim.value === keylessCount)) {
      ok('keyless-count', `${name} 的 ${keyless.length} 处"免配置"声明等于实测免 key 源数 ${keylessCount}`);
    }
    const claims = countClaims(maskRanges(flat, keyless));
    if (!claims.length) {
      fail('count-claim-present', `${name} 里找不到任何「素材源数量」声明，这道检查无从判定`);
    }
    const wrong = claims.filter((claim) => claim.value !== registeredNames.length);
    for (const claim of wrong) {
      fail('count-claim', `${name} 写的是「${claim.text}」= ${claim.value}，注册表实测 ${registeredNames.length}`);
    }
    if (claims.length && !wrong.length) {
      ok('count-claim', `${name} 的 ${claims.length} 处数量声明都等于注册表的 ${registeredNames.length}`);
    }

    // 2) 名单：表里每一行都要有对应插件，且注册表里每一个都要在表里露面
    const rows = sourceTableRows(text);
    if (!rows) {
      fail('source-table', `${name} 的「Sources / 聚合的素材源」表缺失或为空 —— 名单没法被机械核对`);
    } else {
      const listed = rows.map((cells) => cells[0].replace(/`/g, '').trim().toLowerCase());
      const unknown = listed.filter((cell) => !registeredNames.includes(cell));
      const missing = registeredNames.filter((regName) => !listed.includes(regName));
      if (unknown.length) fail('source-names', `${name} 列了没注册的素材源：${unknown.join(', ')}（registry.js 里没有这些插件）`);
      if (missing.length) fail('source-names', `${name} 漏掉了已注册的素材源：${missing.join(', ')}`);
      if (!unknown.length && !missing.length) ok('source-names', `${name} 的 ${listed.length} 行与注册表逐一对上`);
      for (const cell of listed) {
        if (registeredNames.includes(cell) && !registry.getPlugin(cell)) {
          fail('source-plugin', `${name} 列了 ${cell}，但 getPlugin('${cell}') 取不到实例`);
        }
      }
    }

    // 3) 纯 ASCII 展示名要在正文露面（中文源名由表里的 name 列负责）
    for (const source of sources) {
      if (!/^[\x20-\x7e]+$/.test(source.displayName)) continue;
      if (!text.includes(source.displayName)) {
        fail('display-name', `${name} 没提到 ${source.name} 的展示名 "${source.displayName}"`);
      }
    }

    // 4) Vimeo 不是插件：只许作为 pixabay 视频接口返回的托管文件被提及
    for (const line of linesMentioning(text, 'vimeo')) {
      if (/pixabay/i.test(line)) continue;
      if (/^\s*\|/.test(line)) fail('vimeo-as-source', `${name} 把 Vimeo 列成了一行素材源：${line.trim().slice(0, 90)}`);
      else fail('vimeo-mention', `${name} 提到 Vimeo 却没说明它来自 pixabay 视频接口：${line.trim().slice(0, 90)}`);
    }

    // 5) 文中每一条 npm run 都要真实存在
    const runScripts = [...new Set([...text.matchAll(/npm run ([A-Za-z][\w:-]*)/g)].map((match) => match[1]))];
    const ghostScripts = runScripts.filter((script) => !scripts.includes(script));
    if (ghostScripts.length) fail('npm-script', `${name} 写了 npm run ${ghostScripts.join(' / ')}，package.json 的 scripts 里没有`);
    else if (runScripts.length) ok('npm-script', `${name} 引用的 ${runScripts.length} 条脚本都在 package.json 里`);

    // 6) 打包文案必须与 electron-builder.yml 的 target 一致
    const installerWording = /(安装包|安装程序|安装向导|installer|\bmsi\b|setup\.exe)/i;
    const negation = /(不是|不再是|没有|不含|无需|不提供|不写系统|\bnot\b|\bno\b|never)/i;
    const offendingLines = text
      .split(/\r?\n/)
      .filter((line) => installerWording.test(line) && !negation.test(line));
    if (producesInstaller) {
      const honest = offendingLines.length === 0 && /portable|便携/i.test(text) === false;
      if (!honest && !declaredTargets.some((target) => installerTargets.includes(target) && text.includes(target))) {
        fail('packaging-wording', `${name} 没有写出真实的打包 target（${declaredTargets.join('/')}）`);
      }
    } else {
      for (const line of offendingLines) {
        fail('packaging-wording', `${name} 写了「${line.trim().slice(0, 90)}」，但 electron-builder.yml 的 target 是 ${declaredTargets.join('/')}，产出的不是安装程序`);
      }
      if (!offendingLines.length) {
        if (!declaredTargets.some((target) => text.toLowerCase().includes(target))) {
          fail('packaging-wording', `${name} 描述打包产物时没写真实的 target（${declaredTargets.join('/')}）`);
        } else {
          ok('packaging-wording', `${name} 的打包文案与 target=${declaredTargets.join('/')} 一致`);
        }
      }
    }

    // 7) Agent 路由不许是幽灵路由
    const claimedRoutes = [...new Set([...text.matchAll(/`(\/api\/[a-z/]+)`/gi)].map((match) => match[1]))];
    if (claimedRoutes.length) {
      const ghosts = claimedRoutes.filter((route) => !servedRoutes.includes(route));
      if (ghosts.length) fail('agent-route', `${name} 列了不存在的路由：${ghosts.join(', ')}；server.mjs 实际只有 ${servedRoutes.join(', ')}`);
      else ok('agent-route', `${name} 的 ${claimedRoutes.length} 条路由都在 server.mjs 里`);
    }

    // 8) 工具数量与名单
    const toolClaims = [...flat.matchAll(/(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|[一二三四五六七八九十])\s*(?:个)?\s*(?:tools?\b|工具)/gi)];
    if (toolClaims.length && toolsModule) {
      const wrongTools = toolClaims.filter((claim) => toNumber(claim[1]) !== toolNames.length);
      for (const claim of wrongTools) {
        fail('tool-count', `${name} 写的是「${claim[0].trim()}」= ${toNumber(claim[1])}，agent/tools.mjs 实际注册 ${toolNames.length}`);
      }
      for (const toolName of toolNames) {
        if (!text.includes(toolName)) fail('tool-name', `${name} 没提到已注册的工具 ${toolName}`);
      }
      if (!wrongTools.length) ok('tool-count', `${name} 的工具数量（${toolNames.length}）与名单都对得上`);
    }

    // 9) Node 版本要求与 engines 一致（README 只能写 package.json 里那个最低版本）
    const requiredNode = String(pkg.engines?.node || '').replace(/[^\d.]/g, '');
    const nodeClaims = [...text.matchAll(/Node\.js\s*(\d+(?:\.\d+)?)/gi)];
    for (const match of nodeClaims) {
      if (requiredNode && match[1] !== requiredNode) {
        fail('node-version', `${name} 写的是 Node.js ${match[1]}，package.json engines.node 是 >=${requiredNode}`);
      }
    }
    if (nodeClaims.length && nodeClaims.every((match) => match[1] === requiredNode)) {
      ok('node-version', `${name} 的 Node.js ${requiredNode} 与 engines.node 一致`);
    }

    // 10) 监听地址与端口
    if (defaultPort !== null) {
      const portMatches = [...text.matchAll(/127\.0\.0\.1:(\d{2,5})/g)];
      for (const match of portMatches) {
        if (Number(match[1]) !== defaultPort) {
          fail('agent-port', `${name} 写的是 127.0.0.1:${match[1]}，server.mjs 默认监听 ${defaultPort}`);
        }
      }
      if (portMatches.length) ok('agent-port', `${name} 的端口 ${defaultPort} 与 server.mjs 一致`);
    }
  }

  // tools.mjs 的自述会经 /api/agent/manifest 交给 agent，同样不许吹牛
  if (toolsModule) {
    const summary = String(toolsModule.project?.summary || '');
    const summaryClaims = countClaims(summary);
    for (const claim of summaryClaims) {
      if (claim.value !== registeredNames.length) {
        fail('summary-count', `agent/tools.mjs 的 project.summary 写的是「${claim.text}」= ${claim.value}，注册表实测 ${registeredNames.length}`);
      }
    }
    if (summaryClaims.length) ok('summary-count', `tools.mjs 自述的素材源数量（${summaryClaims[0].value}）与注册表一致`);
    else fail('summary-count', 'agent/tools.mjs 的 project.summary 里找不到素材源数量声明，无法核对');
  }

  // agent/README.md：脚本、路由、端口三件事
  const agentReadme = readDoc('agent/README.md');
  if (agentReadme) {
    const ghostScripts = [...new Set([...agentReadme.matchAll(/npm run ([A-Za-z][\w:-]*)/g)].map((m) => m[1]))]
      .filter((script) => !scripts.includes(script));
    if (ghostScripts.length) fail('npm-script', `agent/README.md 写了 npm run ${ghostScripts.join(' / ')}，package.json 里没有`);
    const routes = [...new Set([...agentReadme.matchAll(/(?:GET|POST)\s+(\/api\/[a-z/]+)/gi)].map((match) => match[1]))];
    const ghosts = routes.filter((route) => !servedRoutes.includes(route));
    if (ghosts.length) fail('agent-route', `agent/README.md 列了不存在的路由：${ghosts.join(', ')}`);
    for (const match of agentReadme.matchAll(/默认\s*(\d{2,5})|127\.0\.0\.1:(\d{2,5})/g)) {
      const port = Number(match[1] || match[2]);
      if (defaultPort !== null && port !== defaultPort) {
        fail('agent-port', `agent/README.md 写的是 ${port}，server.mjs 默认监听 ${defaultPort}`);
      }
    }
  }

  // launch.json 的 ready_port 必须就是服务自己的默认端口，否则 MCP 桥自动拉起后找不到它
  const launch = JSON.parse(fs.readFileSync(path.join(ROOT, 'agent/launch.json'), 'utf-8'));
  if (defaultPort !== null && launch.ready_port !== defaultPort) {
    fail('launch-port', `agent/launch.json 的 ready_port=${launch.ready_port}，server.mjs 默认监听 ${defaultPort} —— 自动拉起的进程会被 MCP 桥判成"没起来"`);
  } else if (defaultPort !== null) {
    ok('launch-port', `launch.json ready_port = server.mjs DEFAULT_PORT = ${defaultPort}`);
  }

  console.log('文档诚实性闸门 · 实测：');
  for (const line of measured) console.log(`  ✓ ${line}`);
  if (failures.length) {
    console.error(`\n✗ 文档与代码不一致，共 ${failures.length} 条：`);
    for (const line of failures) console.error(`  ✗ ${line}`);
    console.error('\n修法：改文档去符合代码（注册表 electron/plugins/registry.js、工具表 agent/tools.mjs、打包配置 electron-builder.yml），不要反过来。');
    process.exitCode = 1;
    return;
  }
  console.log(`\n✓ README 的素材源数量（${registeredNames.length}）、名单、npm 脚本、打包文案、Agent 端口/路由/工具数、Node 版本要求都与代码一致。`);
}

await main();
