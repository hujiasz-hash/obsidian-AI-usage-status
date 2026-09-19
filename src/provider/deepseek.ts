import { requestUrl } from "obsidian";
import { currencySymbol, formatClock } from "../api";
import { pctClass, renderQuotaRow, type StatusBarPart, type UsageProvider } from "./types";
import type { UsageHudSettings } from "../settings";

// ─────────────────────────────────────────────────────────────
// DeepSeek 余额（官方公开接口）
// 文档: https://api-docs.deepseek.com/api/get-user-balance
// ─────────────────────────────────────────────────────────────

export interface DeepSeekCurrency {
	currency: string; // CNY / USD
	totalBalance: number;
	grantedBalance: number;
	toppedUpBalance: number;
}

export interface DeepSeekBalance {
	isAvailable: boolean;
	currencies: DeepSeekCurrency[];
	fetchedAt: number;
}

/** 金额智能缩写：状态栏空间有限，大额用千分位取整或 k 缩写；明细弹窗仍显示完整两位小数 */
export function formatMoney(n: number): string {
	if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
	if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n >= 1000) return Math.round(n).toLocaleString("en-US");
	return n.toFixed(2);
}

export async function fetchDeepSeekBalance(apiKey: string): Promise<DeepSeekBalance> {
	const resp = await requestUrl({
		url: "https://api.deepseek.com/user/balance",
		method: "GET",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
		},
		throw: false,
	});

	if (resp.status === 401 || resp.status === 403) {
		throw new Error(`DeepSeek 认证失败 (HTTP ${resp.status})，检查 API Key`);
	}
	if (resp.status !== 200) {
		throw new Error(`DeepSeek 接口返回 HTTP ${resp.status}`);
	}

	let body: any;
	try {
		body = resp.json;
	} catch {
		throw new Error("DeepSeek 接口返回非 JSON 内容");
	}

	const currencies: DeepSeekCurrency[] = (body?.balance_infos ?? []).map((info: any) => ({
		currency: String(info.currency ?? ""),
		totalBalance: Number(info.total_balance ?? 0),
		grantedBalance: Number(info.granted_balance ?? 0),
		toppedUpBalance: Number(info.topped_up_balance ?? 0),
	}));

	return {
		isAvailable: Boolean(body?.is_available),
		currencies,
		fetchedAt: Date.now(),
	};
}

// ─────────────────────────────────────────────────────────────

export class DeepSeekProvider implements UsageProvider {
	readonly id = "deepseek";
	readonly label = "DS";
	readonly labelClass = "uh-label-ds";
	error = "";
	private balance: DeepSeekBalance | null = null;

	constructor(private settings: UsageHudSettings) {}

	isConfigured(): boolean {
		return Boolean(this.settings.dsApiKey);
	}

	async fetch(): Promise<void> {
		try {
			this.balance = await fetchDeepSeekBalance(this.settings.dsApiKey);
			this.error = "";
		} catch (e) {
			this.error = e instanceof Error ? e.message : String(e);
		}
	}

	statusBarParts(): StatusBarPart[] | null {
		const ds = this.balance;
		if (!ds) return null;
		const c = ds.currencies[0];
		if (!c) return [{ text: " --", cls: "" }];
		const warn =
			c.currency.toUpperCase() === "CNY" ? c.totalBalance < this.settings.dsWarnThreshold : false;
		return [
			{
				text: ` ${currencySymbol(c.currency)}${formatMoney(c.totalBalance)}`,
				cls: warn || !ds.isAvailable ? "uh-bad" : "uh-good",
			},
		];
	}

	tooltipLines(): string[] {
		const ds = this.balance;
		if (!ds) return this.error ? [`DeepSeek 失败：${this.error}`] : [];
		return [`DeepSeek 更新于 ${formatClock(ds.fetchedAt)}`];
	}

	detailSection(container: HTMLElement): void {
		const ds = this.balance;
		const sec = container.createDiv("uh-section");
		if (!ds) {
			sec.createEl("p", { text: `DeepSeek：${this.error || "暂无数据"}`, cls: "uh-error" });
			return;
		}

		const head = sec.createDiv("uh-row-head");
		head.createEl("strong", { text: "DeepSeek" });
		head.createSpan({
			text: ds.isAvailable ? "可用" : "余额不足",
			cls: ds.isAvailable ? "uh-badge uh-badge-ok" : "uh-badge uh-badge-bad",
		});
		for (const c of ds.currencies) {
			const s = currencySymbol(c.currency);
			renderQuotaRow(sec, {
				label: `余额 (${c.currency})`,
				pct: c.currency.toUpperCase() === "CNY" && c.totalBalance < this.settings.dsWarnThreshold ? 100 : 0,
				valueText: `${s}${c.totalBalance.toFixed(2)}`,
				resetText: c.grantedBalance > 0 ? `赠金 ${s}${c.grantedBalance.toFixed(2)}` : undefined,
			});
		}
	}
}
