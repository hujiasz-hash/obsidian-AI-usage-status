import { requestUrl } from "obsidian";
import { formatClock, formatCountdown } from "../api";
import {
	pctClass,
	renderQuotaRow,
	type StatusBarPart,
	type UsageProvider,
} from "./types";
import type { UsageHudSettings } from "../settings";

// ─────────────────────────────────────────────────────────────
// GLM Coding Plan 用量（内部接口，未公开文档；认证头直接放 key，不加 Bearer）
// 参考: https://github.com/zai-org/zai-coding-plugins (官方 glm-plan-usage)
//      https://github.com/farion1231/cc-switch/issues/1588
// ─────────────────────────────────────────────────────────────

export interface GlmLimit {
	type: string; // TOKENS_LIMIT | TIME_LIMIT
	percentage?: number;
	nextResetTime?: number; // 毫秒时间戳
	unit?: number; // 3=小时窗口 6=周窗口
	number?: number; // 如 5 表示 5 小时
	usage?: number; // TIME_LIMIT: 总量
	currentValue?: number; // TIME_LIMIT: 已用
	remaining?: number; // TIME_LIMIT: 剩余
	usageDetails?: { modelCode?: string; usage?: number }[];
}

export interface GlmQuota {
	level: string; // lite / pro / max
	token5h?: GlmLimit;
	tokenWeekly?: GlmLimit;
	mcp?: GlmLimit;
	fetchedAt: number;
}

export async function fetchGlmQuota(host: string, apiKey: string): Promise<GlmQuota> {
	const url = `${host}/api/monitor/usage/quota/limit`;
	const resp = await requestUrl({
		url,
		method: "GET",
		headers: {
			Authorization: apiKey, // 注意：直接放 key，不要 "Bearer " 前缀
			"Content-Type": "application/json",
		},
		throw: false,
	});

	if (resp.status === 401 || resp.status === 403) {
		throw new Error(`GLM 认证失败 (HTTP ${resp.status})，检查 API Key`);
	}
	if (resp.status !== 200) {
		throw new Error(`GLM 接口返回 HTTP ${resp.status}`);
	}

	let body: any;
	try {
		body = resp.json;
	} catch {
		throw new Error("GLM 接口返回非 JSON 内容");
	}
	if (!body?.success || !body?.data) {
		throw new Error(`GLM 接口返回失败: ${body?.msg ?? "未知错误"}`);
	}

	const quota: GlmQuota = {
		level: String(body.data.level ?? "").trim(),
		fetchedAt: Date.now(),
	};

	for (const item of (body.data.limits ?? []) as GlmLimit[]) {
		if (item.type === "TOKENS_LIMIT") {
			// unit=3 → 小时窗口(通常 5h)，unit=6 → 周窗口；新套餐两个都有，老套餐只有 5h
			if (item.unit === 6) {
				quota.tokenWeekly = item;
			} else if (item.unit === 3 || !quota.token5h) {
				quota.token5h = item;
			}
		} else if (item.type === "TIME_LIMIT") {
			quota.mcp = item;
		}
	}
	return quota;
}

// ─────────────────────────────────────────────────────────────

export class GlmProvider implements UsageProvider {
	readonly id = "glm";
	readonly label = "GLM";
	readonly labelClass = "uh-label-glm";
	error = "";
	private quota: GlmQuota | null = null;

	constructor(private settings: UsageHudSettings) {}

	isConfigured(): boolean {
		return Boolean(this.settings.glmApiKey);
	}

	async fetch(): Promise<void> {
		try {
			this.quota = await fetchGlmQuota(this.settings.glmHost, this.settings.glmApiKey);
			this.error = "";
		} catch (e) {
			this.error = e instanceof Error ? e.message : String(e);
		}
	}

	/** 状态栏显示周额度百分比；老套餐（无周窗口）回退 5h（PRD R4 再开放指标选择） */
	statusBarParts(): StatusBarPart[] | null {
		const q = this.quota;
		if (!q) return null;
		const limit = q.tokenWeekly ?? q.token5h;
		if (!limit) return [{ text: " --", cls: "" }];
		const pct = Math.round(limit.percentage ?? 0);
		return [{ text: ` ${pct}%`, cls: pctClass(pct) }];
	}

	tooltipLines(): string[] {
		const q = this.quota;
		if (!q) return this.error ? [`GLM 失败：${this.error}`] : [];
		const parts: string[] = [];
		if (q.token5h) {
			const reset = q.token5h.nextResetTime ? `（${formatCountdown(q.token5h.nextResetTime)}重置）` : "";
			parts.push(`5h ${Math.round(q.token5h.percentage ?? 0)}%${reset}`);
		}
		if (q.tokenWeekly) {
			const reset = q.tokenWeekly.nextResetTime ? `（${formatCountdown(q.tokenWeekly.nextResetTime)}重置）` : "";
			parts.push(`周 ${Math.round(q.tokenWeekly.percentage ?? 0)}%${reset}`);
		}
		if (q.mcp) parts.push(`MCP ${q.mcp.currentValue ?? 0}/${q.mcp.usage ?? 0}`);
		return [`GLM${q.level ? " " + q.level.toUpperCase() : ""}：${parts.join(" / ")} · 更新于 ${formatClock(q.fetchedAt)}`];
	}

	detailSection(container: HTMLElement): void {
		const q = this.quota;
		const sec = container.createDiv("uh-section");
		if (!q) {
			sec.createEl("p", { text: `GLM：${this.error || "暂无数据"}`, cls: "uh-error" });
			return;
		}

		const head = sec.createDiv("uh-row-head");
		head.createEl("strong", { text: "GLM Coding Plan" });
		if (q.level) head.createSpan({ text: q.level.toUpperCase(), cls: "uh-badge" });

		const rows: { label: string; limit?: GlmLimit }[] = [
			{ label: "5 小时窗口", limit: q.token5h },
			{ label: "每周窗口", limit: q.tokenWeekly },
		];
		for (const { label, limit } of rows) {
			if (!limit) continue;
			const pct = Math.round(limit.percentage ?? 0);
			renderQuotaRow(sec, {
				label,
				pct,
				valueText: `${pct}%`,
				resetText: formatCountdown(limit.nextResetTime),
			});
		}

		if (q.mcp) {
			renderQuotaRow(sec, {
				label: "MCP 月用量",
				pct: Math.round(q.mcp.percentage ?? 0),
				valueText: `${q.mcp.currentValue ?? 0}/${q.mcp.usage ?? 0}`,
				resetText: formatCountdown(q.mcp.nextResetTime),
			});
		}
	}
}
