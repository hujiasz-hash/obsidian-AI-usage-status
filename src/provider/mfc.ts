import { requestUrl } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { formatClock } from "../api";
import { pctClass, renderQuotaRow, type StatusBarPart, type UsageProvider } from "./types";
import type { UsageHudSettings } from "../settings";

// ─────────────────────────────────────────────────────────────
// Bosch Model Farm (China) token/cost 用量（对齐 pi-web MfcUsageIndicator）
// 端点: GET https://aigc.bosch.com.cn/llmservice/api/v1/client/usage
//       ?dateType=month|day&startDate=<yyyy-MM|yyyy-MM-dd>&endDate=<same>
// 认证: Authorization: Bearer <MFC API Key>
//
// 网关两个特性：
//  - 失败也返回 HTTP 200，真实状态在 body.code（{"msg":"Invalid API Key","code":401}）
//  - 金额为 EUR；cost 不含平台服务费，服务费单独在 serviceFee / totalCost
// ─────────────────────────────────────────────────────────────

export interface MfcModelUsage {
	model: string;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cost: number;
}

export interface MfcUsageReport {
	dateType: "month" | "day";
	startDate: string;
	endDate: string;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cost: number;
	serviceFee?: number;
	totalCost?: number;
	models: MfcModelUsage[];
}

/** MFC 监控接口原始返回 */
interface MfcRawResponse {
	msg?: unknown;
	code?: unknown;
	data?: unknown;
}

export const MFC_USAGE_BASE = "https://aigc.bosch.com.cn/llmservice/api/v1/client/usage";

/** pi models.json 里 bosch-mfc 的位置（读取 API Key 用） */
const PI_MODELS_JSON = path.join(os.homedir(), ".pi", "agent", "models.json");

/** 从 pi 的 models.json 读取 bosch-mfc API Key；读不到返回空串 */
export function readMfcKeyFromPi(): string {
	try {
		const raw = fs.readFileSync(PI_MODELS_JSON, "utf-8");
		const json = JSON.parse(raw);
		const key = json?.providers?.["bosch-mfc"]?.apiKey;
		return typeof key === "string" ? key.trim() : "";
	} catch {
		return "";
	}
}

function num(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return Math.max(0, parsed);
	}
	return 0;
}

function optionalNum(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function modelRows(value: unknown): MfcModelUsage[] {
	if (!Array.isArray(value)) return [];
	const rows: MfcModelUsage[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) continue;
		const row = entry as Record<string, unknown>;
		const model = typeof row.model === "string" ? row.model.trim() : "";
		if (!model) continue;
		rows.push({
			model,
			promptTokens: num(row.promptTokens),
			completionTokens: num(row.completionTokens),
			totalTokens: num(row.totalTokens),
			cost: num(row.cost),
		});
	}
	return rows.sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
}

/** 校验 body.code 契约（200/数字或字符串），返回 data 对象 */
function assertMfcSuccess(payload: MfcRawResponse): Record<string, unknown> {
	const code = payload.code;
	if (code !== 200 && code !== "200") {
		const msg =
			typeof payload.msg === "string" && payload.msg.trim()
				? payload.msg.trim().slice(0, 120)
				: "MFC 用量请求失败";
		throw new Error(msg);
	}
	if (typeof payload.data !== "object" || payload.data === null) {
		throw new Error("MFC 返回缺少 data 对象");
	}
	return payload.data as Record<string, unknown>;
}

function normalizeReport(payload: MfcRawResponse, dateType: "month" | "day"): MfcUsageReport {
	const data = assertMfcSuccess(payload);
	const periods = Array.isArray(data.periods) ? (data.periods as Record<string, unknown>[]) : [];
	const first = periods.length > 0 && typeof periods[0] === "object" ? periods[0] : {};
	const details = modelRows(data.details).length > 0 ? modelRows(data.details) : modelRows(first.details);
	return {
		dateType,
		startDate: typeof data.startDate === "string" ? data.startDate : "",
		endDate: typeof data.endDate === "string" ? data.endDate : "",
		promptTokens: num(data.promptTokens),
		completionTokens: num(data.completionTokens),
		totalTokens: num(data.totalTokens),
		cost: num(data.cost),
		serviceFee: optionalNum(data.serviceFee),
		totalCost: optionalNum(data.totalCost),
		models: details,
	};
}

async function fetchUsage(
	dateType: "month" | "day",
	period: string,
	apiKey: string,
): Promise<MfcUsageReport> {
	const url = `${MFC_USAGE_BASE}?dateType=${dateType}&startDate=${encodeURIComponent(period)}&endDate=${encodeURIComponent(period)}`;
	const resp = await requestUrl({
		url,
		method: "GET",
		headers: { authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		throw: false,
	});
	if (resp.status !== 200) {
		throw new Error(`MFC 接口返回 HTTP ${resp.status}`);
	}
	try {
		return normalizeReport(resp.json, dateType);
	} catch (e) {
		if (e instanceof Error) throw e;
		throw new Error("MFC 返回解析失败");
	}
}

/** 本地时区周期键：月 yyyy-MM / 日 yyyy-MM-dd */
function periodKeys(now = new Date()): { month: string; day: string } {
	const pad = (v: number) => String(v).padStart(2, "0");
	return {
		month: `${now.getFullYear()}-${pad(now.getMonth() + 1)}`,
		day: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
	};
}

/** 金额缩写：€35.44 / €115 / €12.3k（对齐 pi-web formatCost） */
export function formatCost(value: number): string {
	if (value >= 10_000) return `€${(value / 1000).toFixed(1)}k`;
	if (value >= 100) return `€${value.toFixed(0)}`;
	return `€${value.toFixed(2)}`;
}

/** tokens 缩写：369.0M / 68.7M（对齐 pi-web formatTokens） */
export function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 10_000) return `${(value / 1000).toFixed(0)}k`;
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
	return String(value);
}

// ─────────────────────────────────────────────────────────────

export class MfcProvider implements UsageProvider {
	readonly id = "mfc";
	readonly label = "MFC";
	readonly labelClass = "uh-label-mfc";
	error = "";
	private month: MfcUsageReport | null = null;
	private today: MfcUsageReport | null = null;
	private fetchedAt = 0;
	private hasData = false;

	constructor(private settings: UsageHudSettings) {}

	private apiKey(): string {
		return this.settings.mfcApiKey.trim() || readMfcKeyFromPi();
	}

	isConfigured(): boolean {
		return this.settings.showMfc && Boolean(this.apiKey());
	}

	statusbarEnabled(): boolean {
		return this.settings.showMfc && Boolean(this.apiKey());
	}

	async fetch(): Promise<void> {
		const key = this.apiKey();
		if (!key) {
			this.error = "未配置 MFC API Key（设置里填，或保持 pi models.json 有 bosch-mfc）";
			return;
		}
		try {
			const { month, day } = periodKeys();
			this.month = await fetchUsage("month", month, key);
			// 当日失败不影响月度展示
			try {
				this.today = await fetchUsage("day", day, key);
			} catch {
				this.today = null;
			}
			this.fetchedAt = Date.now();
			this.hasData = true;
			this.error = "";
		} catch (e) {
			this.error = e instanceof Error ? e.message : String(e);
		}
	}

	statusBarParts(): StatusBarPart[] | null {
		if (!this.hasData || !this.month) return null;
		return [
			{
				text: ` ${formatCost(this.month.cost)}`,
				// 月度费用无官方额度上限，仅超过 120€/月（近似含服务费预算线）标红提示
				cls: this.month.cost >= 120 ? "uh-bad" : this.month.cost >= 90 ? "uh-warn" : "",
			},
		];
	}

	tooltipLines(): string[] {
		if (!this.hasData || !this.month) {
			return this.error ? [`MFC 失败：${this.error}`] : [];
		}
		const m = this.month;
		const parts: string[] = [`MFC 本月 ${formatCost(m.cost)} · ${formatTokens(m.totalTokens)} tok`];
		parts.push(
			`prompt ${formatTokens(m.promptTokens)} / completion ${formatTokens(m.completionTokens)}`,
		);
		if (m.serviceFee !== undefined) parts.push(`服务费 ${formatCost(m.serviceFee)}`);
		if (m.totalCost !== undefined) parts.push(`总计 ${formatCost(m.totalCost)}`);
		if (this.today) parts.push(`今日 ${formatCost(this.today.cost)} · ${formatTokens(this.today.totalTokens)}`);
		const top = m.models.slice(0, 3);
		if (top.length > 0) {
			parts.push(`Top: ${top.map((r) => `${r.model} ${formatCost(r.cost)}`).join(" · ")}`);
		}
		parts.push(`更新于 ${formatClock(this.fetchedAt)}`);
		return [parts.join(" · ")];
	}

	detailSection(container: HTMLElement): void {
		const sec = container.createDiv("uh-section");
		const head = sec.createDiv("uh-row-head");
		head.createEl("strong", { text: "Bosch Model Farm (China)" });
		head.createSpan({ text: "EUR", cls: "uh-badge" });

		if (!this.hasData || !this.month) {
			sec.createEl("p", { text: `MFC：${this.error || "暂无数据"}`, cls: "uh-error" });
			return;
		}
		const m = this.month;
		const pct = Math.min(100, Math.round((m.cost / 120) * 100));
		renderQuotaRow(sec, {
			label: "本月费用",
			pct,
			valueText: formatCost(m.cost),
			resetText: `${m.startDate} ~ ${m.endDate}`,
		});
		const tokRow = sec.createDiv("uh-quota-row");
		tokRow.createSpan({ text: "本月 tokens", cls: "uh-quota-label" });
		tokRow.createSpan(
			{
				text: `${formatTokens(m.totalTokens)} (p ${formatTokens(m.promptTokens)} / c ${formatTokens(m.completionTokens)})`,
				cls: "uh-quota-pct",
			},
		);
		if (m.serviceFee !== undefined) {
			const feeRow = sec.createDiv("uh-quota-row");
			feeRow.createSpan({ text: "平台服务费", cls: "uh-quota-label" });
			feeRow.createSpan({ text: formatCost(m.serviceFee), cls: "uh-quota-pct" });
		}
		if (m.totalCost !== undefined) {
			const totalRow = sec.createDiv("uh-quota-row");
			totalRow.createSpan({ text: "本月总计", cls: "uh-quota-label" });
			totalRow.createSpan({ text: formatCost(m.totalCost), cls: "uh-quota-pct" });
		}
		if (this.today) {
			const todayRow = sec.createDiv("uh-quota-row");
			todayRow.createSpan({ text: "今日", cls: "uh-quota-label" });
			todayRow.createSpan({
				text: `${formatCost(this.today.cost)} · ${formatTokens(this.today.totalTokens)} tok`,
				cls: "uh-quota-pct",
			});
		}
		// 模型用量 breakdown（Top 8，对齐 pi-web 明细）
		for (const it of m.models.slice(0, 8)) {
			const row = sec.createDiv("uh-quota-row");
			row.createSpan({ text: it.model.slice(0, 28), cls: "uh-quota-label" });
			row.createSpan({ text: `${formatCost(it.cost)} · ${formatTokens(it.totalTokens)}`, cls: "uh-quota-pct" });
		}
	}
}
