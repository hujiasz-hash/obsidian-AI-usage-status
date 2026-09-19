---
title: AI Usage HUD 产品需求文档（PRD）
version: v0.2
author: 胡嘉
date: 2026-09-18
---

# AI Usage HUD 产品需求文档（PRD）

## 版本
| 版本 | 日期 | 作者 | 改动点 |
| --- | --- | --- | --- |
| v0.1 | 2026-09-18 | 胡嘉 | 首版：记录 v0.1 现状，定义 V0.2 需求（Copilot、自定义 API、显示配置） |
| v0.2 | 2026-09-19 | 胡嘉 | M1–M5 全部实施：Provider 框架、Copilot provider、自定义 API、显示配置、版本号 v0.2.0 |

## 链接
- 库内：无
- 上游调研：[GitHub Billing Usage REST API](https://docs.github.com/en/rest/billing/usage) — Copilot 用量端点官方文档
- 上游调研：[cc-switch#1588](https://github.com/farion1231/cc-switch/issues/1588) — GLM quota/limit 接口结构社区实测
- 上游调研：[glm-quota-monitor](https://github.com/ChenMengfang/glm-quota-monitor) — GLM 接口 Python 参考实现

---

## 1. 背景

Obsidian 状态栏插件 **AI Usage HUD**（id: `usage-hud`），在状态栏常驻显示 AI 服务用量，点击弹出明细。

**v0.1 已上线能力**（2026-09-18）：
- GLM Coding Plan（智谱国内站）：5h 窗口 / 周窗口 / MCP 月用量，状态栏显示周额度百分比，明细含重置倒计时
- DeepSeek：账户余额（含赠金拆分），低额预警变红
- 轮询间隔可配（默认 5 分钟），手动刷新命令，双 provider 标签色区分（GLM 蓝 / DS 紫）

**V0.2 目标**：从「两个内置 provider 的硬编码」升级为「可扩展的 provider 框架」，并开放显示配置。

## 2. 需求清单

| 编号 | 需求 | 优先级 |
| --- | --- | --- |
| R1 | Provider 抽象框架（内置 provider 重构 + 插件点） | P0（R2/R3 的前置） |
| R2 | GitHub Copilot 内置 provider | P0 |
| R3 | 自定义 API provider（任意端点查额度） | P0 |
| R4 | 显示内容与显示格式配置 | P1 |

### R1 Provider 抽象框架

现状 `main.ts` 里 GLM/DeepSeek 的取数与渲染互相交织。V0.2 抽出统一接口，后续新增 provider 只加文件不改主干：

```ts
interface UsageProvider {
  id: string;                          // "glm" | "deepseek" | "copilot" | "custom-<n>"
  label: string;                       // 状态栏标签文案
  labelClass: string;                  // 标签色 class
  isConfigured(): boolean;             // 设置是否齐全
  fetch(): Promise<void>;              // 拉数据并写回自身状态，失败置 error
  statusBarText(): string | null;      // 状态栏片段；null = 本轮无数据显示
  tooltipLines(): string[];            // hover 明细行
  detailSections(el: HTMLElement): void; // 弹窗区块
}
```

- 插件主循环只依赖 `UsageProvider[]`，轮询 = 依次调用各 provider 的 `fetch()`（`Promise.allSettled`，互不拖累）
- 设置结构迁移：`data.json` 加 `schemaVersion` 字段，读取时对旧版配置做一次迁移（glmHost/glmApiKey/dsApiKey 原样保留），不破坏现有用户数据

### R2 GitHub Copilot 内置 provider

**数据源（已调研，官方公开 API）**：

- 个人版端点：`GET https://api.github.com/users/{username}/settings/billing/premium_request/usage`
  - 认证：fine-grained PAT，权限 **Plan: Read**（社区实现 [opencode-mystatus](https://github.com/vbgate/opencode-mystatus) 验证可行）
  - 仅适用**个人自费** Copilot（Pro / Pro+）；组织/企业管理的席位走 `GET /organizations/{org}/settings/billing/premium_request/usage`，需要管理员权限——**V0.2 只做个人版**，组织版列入开放问题
- 返回结构含 `entitlement`（总额度）、`remaining`/`quota_remaining`（剩余）、`percent_remaining`、`unlimited` 等字段（以官方 OpenAPI 为准，解析做容错）

**风险**：GitHub 2026-06-01 起计费模型从 premium requests 向 **AI credits** 演进（legacy 文档已标注仅适用存量用户）。实现时必须：
1. 以 [docs.github.com/en/rest/billing/usage](https://docs.github.com/en/rest/billing/usage) 最新版为准核对端点与字段
2. 解析层对未知字段/新字段容错，模型切换后只改 provider 一个文件

**设置项**：GitHub 用户名、PAT（password 输入框，仅存本地）、（预留）站点字段。

**验收**：配置 PAT 后状态栏出现 Copilot 片段，显示本月额度已用百分比；无额度限制（`unlimited`）时显示 `∞`；401/403 显示 `Copilot ✕` 且 tooltip 说明 PAT 权限问题。

### R3 自定义 API provider

面向「任意能返回 JSON 的额度接口」（如中转站、自建网关）。设置页表单化配置，每条自定义 provider 包含：

| 字段 | 说明 |
| --- | --- |
| 名称 | 状态栏标签，如 `Relay` |
| URL | 完整端点 |
| Method | GET / POST |
| Headers | KV 对；值支持 `{apiKey}` 占位符（运行时替换，配置文件里不落明文 key） |
| API Key | 独立密码框，注入占位符 |
| Body | POST 时可选 |
| 提取规则 | 1–2 条：JSON 点路径（如 `data.total_balance`、`limits.0.percentage`）→ 值类型（`money` / `percent` / `raw`） |
| 显示模板 | 默认 `{name} {value}`，可自定义 |

**实现约束**：
- 点路径解析自实现（`a.b.0.c` → 逐段取），**不引入 jsonpath 依赖**；解析失败显示 `--`
- 每条自定义 provider 有独立启用开关；上限 5 条（防设置页失控）
- 自定义 provider 标签色按注册顺序分配调色板（蓝/紫/青/橙/粉），与内置 provider 区分

**验收**：不写代码、纯设置页操作，能接入一个返回 `{"data":{"percentage":42}}` 的假接口并在状态栏显示 `Relay 42%`。

### R4 显示内容与显示格式配置

**内容开关**（每 provider 独立）：
- 是否在状态栏显示（关闭后仅保留明细弹窗入口与命令）
- GLM：显示指标三选一（周额度 / 5h / 两者）
- DeepSeek：显示内容二选一（余额 / 仅可用状态点）
- Copilot：额度百分比 / 剩余次数

**格式配置（全局）**：
- 状态栏模板字符串，占位符：`{glm}` `{copilot}` `{deepseek}` `{custom:名称}`，默认 `{glm} {copilot} {deepseek}`
- 分隔符：无 / 半角空格 / 竖线 / 中点，默认半角空格
- 模板里出现未启用 provider 的占位符 → 该占位符静默移除，不报错

**验收**：改模板后状态栏即时重排，无需重载插件；模板解析失败回退默认模板并在 tooltip 提示。

## 3. 非目标（V0.2 不做）

- 组织/企业级 Copilot 席位用量（等个人版稳定后再评估）
- 历史用量曲线、本地统计账本
- 移动端适配优化（`requestUrl` 本身跨端，但不专门测试）
- 多 Vault 配置同步

## 4. 里程碑

| 阶段 | 内容 | 预估 |
| --- | --- | --- |
| M1 | R1 框架重构 + 现有功能回归（GLM/DS 显示不回归） | 0.5 天 |
| M2 | R2 Copilot provider | 0.5 天 |
| M3 | R3 自定义 provider + 设置页 | 1 天 |
| M4 | R4 显示配置 + 模板引擎 | 0.5 天 |
| M5 | 整体回归、版本号 v0.2、tag | 0.5 天 |

## 5. 开放问题

1. Copilot PAT 的最小权限粒度：fine-grained PAT「Plan: Read」已验证可用，但到期策略与 scope 收敛待确认
2. GitHub credits 新模型上线后的字段形态（影响 R2 解析层，预留容错）
3. 自定义 provider 是否需要 POST 轮询节流（当前全局统一间隔已够用，先不做）
