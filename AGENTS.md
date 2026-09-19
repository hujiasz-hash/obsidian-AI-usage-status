# AGENTS.md — AI 协作说明

## 项目概述

**AI Usage HUD**：Obsidian 状态栏插件，显示 AI 服务用量/余额。
当前支持：GLM Coding Plan（智谱国内站）+ DeepSeek。规划中：GitHub Copilot、自定义 API（见 PRD.md）。

- 源码仓库：`~/Desktop/Working/obsidian-usage-hud`（本目录）
- 部署目标：`/Users/hujia/Desktop/Working/110_L3/.obsidian/plugins/usage-hud/`
- 相关人：胡嘉（作者/唯一用户）

## 目录结构

```
├── manifest.json        # 插件清单（id: usage-hud）
├── main.js              # esbuild 构建产物（入库，Obsidian 插件惯例）
├── styles.css           # 样式（源码即产物，不经过构建）
├── src/
│   ├── main.ts          # 插件入口：状态栏渲染、轮询、命令
│   ├── api.ts           # GLM / DeepSeek API 客户端 + 格式化辅助
│   ├── settings.ts      # 设置页
│   └── modal.ts         # 明细弹窗
├── esbuild.config.mjs   # 构建配置
├── PRD.md               # 产品需求文档
└── AGENTS.md            # 本文件
```

## 常用命令

```bash
npm run build        # tsc 类型检查 + esbuild 打包（production）
npm run dev          # watch 模式
```

### 部署 + 热重载（macOS + Obsidian CLI）

```bash
cp main.js styles.css manifest.json "/Users/hujia/Desktop/Working/110_L3/.obsidian/plugins/usage-hud/"
obsidian vault="110_L3" eval code="app.plugins.disablePlugin('usage-hud').then(() => app.plugins.enablePluginAndSave('usage-hud')).then(() => console.log('已重载'))"
```

### 端到端验证（Obsidian CLI）

```bash
# 状态栏文本 / 位置 / tooltip
obsidian vault="110_L3" eval code="const uh = document.querySelector('.uh-statusbar'); console.log(JSON.stringify({文本: uh.textContent, tooltip: uh.getAttribute('aria-label'), 在窗口内: uh.getBoundingClientRect().right <= window.innerWidth}))"
```

注意：重载后立即查询会显示 `…`（数据未回来），`sleep 3` 后再查。

## 关键技术约束（勿违反）

1. **GLM 认证头不加 `Bearer` 前缀**：`Authorization: <API Key>` 直接放 key。DeepSeek 才用 `Authorization: Bearer <Token>`。两者不同，是踩过的点。
2. **GLM `quota/limit` 是非公开内部接口**（官方 glm-plan-usage 插件在用），返回结构可能变：
   - `TOKENS_LIMIT`：`unit=3` → 5h 窗口、`unit=6` → 周窗口；新套餐 2 个、老套餐仅 5h 一个，解析必须兼容
   - `TIME_LIMIT` → MCP 月用量
   - 解析层必须容错：字段缺失显示 `--`，不抛异常
3. **网络请求一律用 Obsidian `requestUrl`**（绕 CORS），不用 fetch/XMLHttpRequest。
4. **API Key 只存本地** `data.json`（已 gitignore）。禁止写死 key、禁止引入遥测。
5. **状态栏空间有限**：金额用 `formatMoney` 缩写（≥1000 千分位取整、≥1万 k 缩写）；明细弹窗里才显示完整两位小数。
6. **兼容性下限**：本机 git 2.24（不支持 `git init -b`）；Obsidian minAppVersion 1.4.0。

## 代码风格

- 跟随现有代码：TypeScript strict、tab 缩进、中文注释与 UI 文案
- 无 React/无框架，纯 DOM API（`createSpan`/`createDiv` 等 Obsidian helper）
- 颜色语义：`.uh-good`(绿) / `.uh-warn`(黄) / `.uh-bad`(红) 按用量状态；provider 标签色区分品牌（GLM 蓝 / DS 紫），用 Obsidian 主题变量 `var(--color-*)` 保证深浅主题自适应

## 版本流程

- 版本号三处同步：`package.json` / `manifest.json` / `PRD.md` 版本表
- 每次改动 PRD 加版本行（不改历史行），改动点写实际内容
- commit message 用中文祈使句，如「状态栏改为仅显示周额度」
