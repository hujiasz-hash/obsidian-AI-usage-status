import { requestUrl } from "obsidian";
import { formatClock } from "../api";
import { pctClass, renderQuotaRow, type StatusBarPart, type UsageProvider } from "./types";
import type { UsageHudSettings } from "../settings";

// ─────────────────────────────────────────────────────────────
// GitHub Copilot 用量，两种数据源：
// 1) pi-web 本地接口（推荐）：GET <piWebBase>/api/copilot/usage
//    pi-web 用 github-copilot OAuth token 调 copilot_internal/user，
//    返回 quota_snapshots（creditsUsed/entitlement/percentRemaining）+
//    plan / orgs / quotaResetDate，自动续期无需维护 token。
// 2) PAT 备用：官方 Billing API（fine-grained PAT，Plan: Read 权限）。
//    文档: https://docs.github.com/en/rest/billing/usage
// ─────────────────────────────────────────────────────────────

/** pi-web /api/copilot/usage 的返回结构 */
export interface PiWebCopilotSnapshot {
	id: string;
	creditsUsed: number;
	entitlement: number;
	remaining: number;
	percentRemaining: number;
	unlimited: boolean;
}

export interface PiWebCopilotUsage {
	configured: boolean;
	plan?: string | null;
	orgs?: string[];
	tokenBasedBilling?: boolean;
	quotaResetDate?: string | null;
	snapshot?: PiWebCopilotSnapshot | null;
	error?: string;
}

/** PAT 模式（官方 Billing API）的结构 */
export interface CopilotUsageItem {
	product?: string;
	sku?: string;
	model?: string;
	unitType?: string;
	grossQuantity?: number;
	limit?: number;
}

export interface CopilotBillingUsage {
	timePeriod?: { year?: number; month?: number };
	user?: string;
	usageItems?: CopilotUsageItem[];
}

/** 各套餐每月 premium requests 额度（PAT 模式回退用；来源 docs.github.com） */
export const COPILOT_PLAN_LIMITS: Record<string, number> = {
	free: 50,
	pro: 300,
	"pro+": 1500,
	business: 300,
	enterprise: 1000,
};

/** credits 数值缩写：27673 → 27.7k */
function fmtCredits(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(Math.round(n));
}

/** ISO 日期 → "10-01" */
function fmtResetDate(iso?: string | null): string {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── 数据源 1：pi-web ───────────────────────────────────────

export async function fetchPiWebCopilotUsage(base: string): Promise<PiWebCopilotUsage> {
	const resp = await requestUrl({
		url: `${base.replace(/\/+$/, "")}/api/copilot/usage`,
		method: "GET",
		headers: { Accept: "application/json" },
		throw: false,
	});
	if (resp.status !== 200) {
		throw new Error(`pi-web 接口返回 HTTP ${resp.status}（服务在跑吗）`);
	}
	try {
		return resp.json as PiWebCopilotUsage;
	} catch {
		throw new Error("pi-web 接口返回非 JSON 内容");
	}
}

// ── 数据源 2：PAT（官方 Billing API）────────────────────────

export async function fetchCopilotPatUsage(
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

/** PAT 模式下月每月 1 号 00:00 UTC 重置 */
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

	// pi-web 模式数据
	private piweb: PiWebCopilotUsage | null = null;
	private piwebOk = false;
	// PAT 模式数据
	private patUsage: CopilotBillingUsage | null = null;
	private patUsed = 0;
	private patLimit = 0;
	private patParsed = false;
	private hasData = false;

	constructor(private settings: UsageHudSettings) {}

	/** pi-web 地址 或 PAT 全套 任一配齐即算已配置 */
	isConfigured(): boolean {
		return Boolean(this.settings.piWebBase.trim() || (this.settings.ghUsername && this.settings.ghPat));
	}

	statusbarEnabled(): boolean {
		return this.settings.showCopilot;
	}

	async fetch(): Promise<void> {
		// 优先 pi-web；未配 pi-web 或失败时回退 PAT
		const base = this.settings.piWebBase.trim();
		if (base) {
			try {
				this.piweb = await fetchPiWebCopilotUsage(base);
				if (!this.piweb.configured) {
					this.error = "pi-web 未登录 github-copilot";
				} else if (this.piweb.error) {
					this.error = `pi-web：${this.piweb.error}`;
				} else {
					this.error = "";
					this.piwebOk = true;
					this.hasData = true;
					return;
				}
				this.piwebOk = false;
			} catch (e) {
				this.error = e instanceof Error ? e.message : String(e);
				this.piwebOk = false;
			}
		}
		// PAT 备用
		if (this.settings.ghUsername && this.settings.ghPat) {
			try {
				this.patUsage = await fetchCopilotPatUsage(this.settings.ghUsername, this.settings.ghPat);
				this.parsePat();
				this.error = "";
				return;
			} catch (e) {
				this.error = e instanceof Error ? e.message : String(e);
			}
		}
	}

	/** PAT 模式解析：used = Premium 条目 grossQuantity 累加；limit 优先响应字段，回退套餐映射 */
	private parsePat(): void {
		this.patParsed = false;
		this.patUsed = 0;
		this.patLimit = 0;
		if (!this.patUsage) return;
		const items = this.patUsage.usageItems ?? [];
		let premiumFound = false;
		for (const item of items) {
			const sku = String(item.sku ?? "");
			if (sku.includes("Premium")) {
				premiumFound = true;
				this.patUsed += Number(item.grossQuantity ?? 0);
				if (!this.patLimit && Number(item.limit ?? 0) > 0) {
					this.patLimit = Number(item.limit);
				}
			}
		}
		if (!premiumFound && items.length > 0) {
			this.patUsed = items.reduce((sum, it) => sum + Number(it.grossQuantity ?? 0), 0);
		}
		if (!this.patLimit) {
			this.patLimit = COPILOT_PLAN_LIMITS[this.settings.ghTier] ?? 300;
		}
		this.patParsed = true;
		this.hasData = true;
	}

	// 统一视图：used / limit / usedPct，两种数据源归一
	private used(): number {
		if (this.piwebOk && this.piweb?.snapshot) return this.piweb.snapshot.creditsUsed;
		return this.patUsed;
	}
	private limit(): number {
		if (this.piwebOk && this.piweb?.snapshot) return this.piweb.snapshot.entitlement;
		return this.patLimit;
	}
	private usedPct(): number {
		const l = this.limit();
		if (l <= 0) return 0;
		return Math.round((this.used() / l) * 100);
	}

	statusBarParts(): StatusBarPart[] | null {
		if (!this.hasData) return null;
		if (this.settings.copilotMetric === "remaining") {
			const remaining = Math.max(0, this.limit() - this.used());
			return [{ text: ` ${fmtCredits(remaining)}`, cls: pctClass(this.usedPct()) }];
		}
		const pct = this.usedPct();
		return [{ text: ` ${pct}%`, cls: pctClass(pct) }];
	}

	tooltipLines(): string[] {
		if (!this.hasData) return this.error ? [`Copilot 失败：${this.error}`] : [];
		if (this.piwebOk && this.piweb?.snapshot) {
			const s = this.piweb.snapshot;
			const plan = (this.piweb.plan ?? "").toUpperCase();
			const reset = fmtResetDate(this.piweb.quotaResetDate);
			const parts: string[] = [
				`Copilot ${plan}：${fmtCredits(s.creditsUsed)}/${fmtCredits(s.entitlement)} credits (${this.usedPct()}%)`,
			];
			parts.push(`剩余 ${fmtCredits(Math.max(0, s.remaining))}`);
			if (reset) parts.push(`${reset} 重置`);
			if (this.piweb.orgs?.length) parts.push(`org: ${this.piweb.orgs.join(", ")}`);
			parts.push(`更新于 ${formatClock(Date.now())}`);
			return [parts.join(" · ")];
		}
		if (this.patUsage && this.patParsed) {
			const tier = this.settings.ghTier.toUpperCase();
			const period = this.patUsage.timePeriod;
			const periodStr = period?.month
				? `${period.year}-${String(period.month).padStart(2, "0")}`
				: String(period?.year ?? "");
			const periodPart = periodStr ? ` · 账期 ${periodStr}` : "";
			return [
				`Copilot ${tier}：本月 ${this.patUsed}/${this.patLimit} 次 · ${formatResetCountdown()}重置${periodPart} · 更新于 ${formatClock(Date.now())}`,
			];
		}
		return this.error ? [`Copilot 失败：${this.error}`] : [];
	}

	detailSection(container: HTMLElement): void {
		const sec = container.createDiv("uh-section");
		const head = sec.createDiv("uh-row-head");
		head.createEl("strong", { text: "GitHub Copilot" });
		if (this.piwebOk && this.piweb) {
			if (this.piweb.plan) head.createSpan({ text: this.piweb.plan.toUpperCase(), cls: "uh-badge" });
			if (this.piweb.tokenBasedBilling) head.createSpan({ text: "credits", cls: "uh-badge" });

			const s = this.piweb.snapshot;
			if (!s || s.unlimited || !s.entitlement) {
				sec.createEl("p", {
					text: s?.unlimited ? "额度不限量" : "无配额快照",
					cls: "uh-quota-reset",
				});
				return;
			}
			const pct = this.usedPct();
			renderQuotaRow(sec, {
				label: "月度 credits",
				pct,
				valueText: `${fmtCredits(s.creditsUsed)}/${fmtCredits(s.entitlement)}`,
				resetText: fmtResetDate(this.piweb.quotaResetDate) ? `${fmtResetDate(this.piweb.quotaResetDate)} 重置` : undefined,
			});
			const remainRow = sec.createDiv("uh-quota-row");
			remainRow.createSpan({ text: "剩余", cls: "uh-quota-label" });
			remainRow.createSpan({ text: fmtCredits(Math.max(0, s.remaining)), cls: "uh-quota-pct uh-good" });
			if (this.piweb.orgs?.length) {
				const orgRow = sec.createDiv("uh-quota-row");
				orgRow.createSpan({ text: "组织", cls: "uh-quota-label" });
				orgRow.createSpan({ text: this.piweb.orgs.join(", "), cls: "uh-quota-pct" });
			}
			return;
		}

		// PAT 模式明细
		head.createSpan({ text: this.settings.ghTier.toUpperCase(), cls: "uh-badge" });
		if (!this.patUsage || !this.patParsed) {
			sec.createEl("p", { text: `Copilot：${this.error || "暂无数据"}`, cls: "uh-error" });
			return;
		}
		const pct = this.usedPct();
		renderQuotaRow(sec, {
			label: "Premium 月额度",
			pct,
			valueText: `${this.patUsed}/${this.patLimit}`,
			resetText: `${formatResetCountdown()}重置`,
		});
		const modelItems = (this.patUsage.usageItems ?? [])
			.filter((it) => it.model && Number(it.grossQuantity ?? 0) > 0)
			.sort((a, b) => Number(b.grossQuantity) - Number(a.grossQuantity))
			.slice(0, 5);
		for (const it of modelItems) {
			const row = sec.createDiv("uh-quota-row");
			row.createSpan({ text: String(it.model).slice(0, 28), cls: "uh-quota-label" });
			row.createSpan({ text: `${it.grossQuantity}`, cls: "uh-quota-pct uh-good" });
		}
		const period = this.patUsage.timePeriod;
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
