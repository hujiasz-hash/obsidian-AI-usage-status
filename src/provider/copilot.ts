import { requestUrl } from "obsidian";
import { formatClock } from "../api";
import { pctClass, renderQuotaRow, type StatusBarPart, type UsageProvider } from "./types";
import type { UsageHudSettings } from "../settings";

// ─────────────────────────────────────────────────────────────
// GitHub Copilot 个人版用量（官方公开 Billing API）
// 端点: GET /users/{username}/settings/billing/premium_request/usage
// 认证: fine-grained PAT（Plan: Read 权限），Authorization: Bearer <PAT>
// 文档: https://docs.github.com/en/rest/billing/usage
//
// ⚠️ 计费模型风险（PRD R2）：GitHub 2026-06 起从 premium requests 向 AI credits
// 演进，字段形态可能变化。本 provider 解析全程容错：缺字段显示 --，不抛异常。
// 注意：该端点返回「用量条目」而非额度快照，总额度按套餐档位映射或取响应 limit 字段。
// ─────────────────────────────────────────────────────────────

export interface CopilotUsageItem {
	product?: string;
	sku?: string;
	model?: string;
	unitType?: string;
	grossQuantity?: number;
	netQuantity?: number;
	limit?: number;
}

export interface CopilotBillingUsage {
	timePeriod?: { year?: number; month?: number };
	user?: string;
	usageItems?: CopilotUsageItem[];
}

/** 各套餐每月 premium requests 额度（来源: docs.github.com Copilot subscription plans） */
export const COPILOT_PLAN_LIMITS: Record<string, number> = {
	free: 50,
	pro: 300,
	"pro+": 1500,
	business: 300,
	enterprise: 1000,
};

export async function fetchCopilotUsage(
	username: string,
	pat: string,
): Promise<CopilotBillingUsage> {
	const resp = await requestUrl({
		url: `https://api.github.com/users/${encodeURIComponent(username)}/settings/billing/premium_request/usage`,
		method: "GET",
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${pat}`,
			"X-GitHub-Api-Version": "2022-11-28",
		},
		throw: false,
	});

	if (resp.status === 401 || resp.status === 403) {
		throw new Error(`Copilot 认证失败 (HTTP ${resp.status})，检查 PAT 与 Plan 读权限`);
	}
	if (resp.status === 404) {
		throw new Error("Copilot 用户名不存在或无权限 (HTTP 404)");
	}
	if (resp.status !== 200) {
		throw new Error(`Copilot 接口返回 HTTP ${resp.status}`);
	}

	try {
		return resp.json as CopilotBillingUsage;
	} catch {
		throw new Error("Copilot 接口返回非 JSON 内容");
	}
}

/** 下月 1 号 00:00 UTC（premium requests 每月 1 号重置，官方规则） */
function nextResetDate(): Date {
	const now = new Date();
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

function formatResetCountdown(): string {
	const secs = Math.max(0, Math.floor((nextResetDate().getTime() - Date.now()) / 1000));
	const days = Math.floor(secs / 86400);
	const hours = Math.floor((secs % 86400) / 3600);
	return days > 0 ? `${days}天${hours}小时后` : `${hours}小时后`;
}

// ─────────────────────────────────────────────────────────────

export class CopilotProvider implements UsageProvider {
	readonly id = "copilot";
	readonly label = "Copilot";
	readonly labelClass = "uh-label-copilot";
	error = "";
	private usage: CopilotBillingUsage | null = null;
	private used = 0;
	private limit = 0;
	private hasParsed = false;

	constructor(private settings: UsageHudSettings) {}

	isConfigured(): boolean {
		return Boolean(this.settings.ghUsername && this.settings.ghPat);
	}

	async fetch(): Promise<void> {
		try {
			this.usage = await fetchCopilotUsage(this.settings.ghUsername, this.settings.ghPat);
			this.parse();
			this.error = "";
		} catch (e) {
			this.error = e instanceof Error ? e.message : String(e);
		}
	}

	/** 解析用量条目：used = Premium 条目 grossQuantity 累加；limit 优先响应 limit 字段，回退套餐映射 */
	private parse(): void {
		this.hasParsed = false;
		this.used = 0;
		this.limit = 0;
		if (!this.usage) return;

		const items = this.usage.usageItems ?? [];
		let premiumFound = false;
		for (const item of items) {
			const sku = String(item.sku ?? "");
			if (sku.includes("Premium")) {
				premiumFound = true;
				this.used += Number(item.grossQuantity ?? 0);
				if (!this.limit && Number(item.limit ?? 0) > 0) {
					this.limit = Number(item.limit);
				}
			}
		}
		// 容错：模型切换后 SKU 可能不含 "Premium"，此时退化为全部条目求和
		if (!premiumFound && items.length > 0) {
			this.used = items.reduce((sum, it) => sum + Number(it.grossQuantity ?? 0), 0);
		}
		if (!this.limit) {
			this.limit = COPILOT_PLAN_LIMITS[this.settings.ghTier] ?? 300;
		}
		this.hasParsed = true;
	}

	private usedPct(): number {
		if (this.limit <= 0) return 0;
		return Math.round((this.used / this.limit) * 100);
	}

	statusBarParts(): StatusBarPart[] | null {
		if (!this.hasParsed) return null;
		const pct = this.usedPct();
		return [{ text: ` ${pct}%`, cls: pctClass(pct) }];
	}

	tooltipLines(): string[] {
		if (!this.usage || !this.hasParsed) {
			return this.error ? [`Copilot 失败：${this.error}`] : [];
		}
		const tier = this.settings.ghTier.toUpperCase();
		const period = this.usage.timePeriod;
		const periodStr = period?.month ? `${period.year}-${String(period.month).padStart(2, "0")}` : String(period?.year ?? "");
		const periodPart = periodStr ? ` · 账期 ${periodStr}` : "";
		return [
			`Copilot ${tier}：本月 ${this.used}/${this.limit} 次 · ${formatResetCountdown()}重置${periodPart} · 更新于 ${formatClock(Date.now())}`,
		];
	}

	detailSection(container: HTMLElement): void {
		const sec = container.createDiv("uh-section");
		const head = sec.createDiv("uh-row-head");
		head.createEl("strong", { text: "GitHub Copilot" });
		head.createSpan({ text: this.settings.ghTier.toUpperCase(), cls: "uh-badge" });

		if (!this.usage || !this.hasParsed) {
			sec.createEl("p", { text: `Copilot：${this.error || "暂无数据"}`, cls: "uh-error" });
			return;
		}

		const pct = this.usedPct();
		renderQuotaRow(sec, {
			label: "Premium 月额度",
			pct,
			valueText: `${this.used}/${this.limit}`,
			resetText: `${formatResetCountdown()}重置`,
		});

		// 模型用量 breakdown（Top 5）
		const modelItems = (this.usage.usageItems ?? [])
			.filter((it) => it.model && Number(it.grossQuantity ?? 0) > 0)
			.sort((a, b) => Number(b.grossQuantity) - Number(a.grossQuantity))
			.slice(0, 5);
		if (modelItems.length > 0) {
			for (const it of modelItems) {
				const row = sec.createDiv("uh-quota-row");
				row.createSpan({ text: String(it.model).slice(0, 28), cls: "uh-quota-label" });
				row.createSpan({ text: `${it.grossQuantity}`, cls: "uh-quota-pct uh-good" });
			}
		}

		const period = this.usage.timePeriod;
		if (period?.year) {
			const row = sec.createDiv("uh-quota-row");
			row.createSpan({ text: "账期", cls: "uh-quota-label" });
			row.createSpan({
				text: period.month ? `${period.year}-${String(period.month).padStart(2, "0")}` : `${period.year}`,
				cls: "uh-quota-pct",
			});
		}
	}
}
