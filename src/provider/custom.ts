import { requestUrl } from "obsidian";
import { formatClock } from "../api";
import { pctClass, renderQuotaRow, type StatusBarPart, type UsageProvider } from "./types";
import { formatMoney } from "./deepseek";
import type { UsageHudSettings } from "../settings";

// ─────────────────────────────────────────────────────────────
// 自定义 API provider（PRD R3）
// 面向任意返回 JSON 的额度接口：URL/Method/Headers({apiKey} 占位符)/
// 点路径提取(最多 2 条)/显示模板。点路径自实现，不引入 jsonpath 依赖。
// ─────────────────────────────────────────────────────────────

export interface CustomExtractRule {
	path: string; // 点路径，如 "data.percentage"、"limits.0.value"
	format: "percent" | "money" | "raw";
}

export interface CustomProviderConfig {
	id: string; // "custom-<ts>"
	name: string;
	url: string;
	method: "GET" | "POST";
	headersText: string; // 每行 "Key: Value"，值可含 {apiKey} 占位符
	body: string; // POST 时可选
	apiKey: string;
	enabled: boolean;
	extract: CustomExtractRule[]; // 1–2 条
	template: string; // 支持 {name} {value} {value2}，默认 "{value}"
}

/** 点路径取值：a.b.0.c → 逐段索引；任何一段缺失返回 undefined */
export function resolvePath(obj: any, path: string): any {
	if (!path) return undefined;
	let cur = obj;
	for (const seg of path.split(".")) {
		if (cur == null) return undefined;
		cur = cur[seg.trim()];
	}
	return cur;
}

function formatValue(v: any, format: "percent" | "money" | "raw"): string {
	if (v === undefined || v === null || v === "") return "--";
	if (format === "percent") {
		const n = Number(v);
		return Number.isNaN(n) ? String(v) : `${Math.round(n)}%`;
	}
	if (format === "money") {
		const n = Number(v);
		return Number.isNaN(n) ? String(v) : formatMoney(n);
	}
	return String(v);
}

/** 解析 headersText："Key: Value" 每行一条，值替换 {apiKey} */
function parseHeaders(headersText: string, apiKey: string): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const line of headersText.split("\n")) {
		const idx = line.indexOf(":");
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim();
		const value = line
			.slice(idx + 1)
			.trim()
			.split("{apiKey}").join(apiKey);
		if (key) headers[key] = value;
	}
	return headers;
}

/** 自定义 provider 标签色调色板（与内置 GLM 蓝 / Copilot 橙 / DS 紫区分） */
export const CUSTOM_LABEL_CLASSES = [
	"uh-label-custom-0",
	"uh-label-custom-1",
	"uh-label-custom-2",
	"uh-label-custom-3",
	"uh-label-custom-4",
];

export class CustomProvider implements UsageProvider {
	readonly id: string;
	readonly label: string;
	readonly labelClass: string;
	/** 模板引擎识别用：未出现在模板中的自定义 provider 自动追加到状态栏尾部 */
	readonly isCustom = true;
	error = "";
	private values: string[] = [];
	private pcts: (number | null)[] = []; // percent 类提取值对应的状态色基准
	private fetchedAt = 0;
	private hasData = false;

	constructor(
		private settings: UsageHudSettings,
		public config: CustomProviderConfig,
		colorIdx: number,
	) {
		this.id = config.id;
		this.label = config.name || "Custom";
		this.labelClass = CUSTOM_LABEL_CLASSES[colorIdx % CUSTOM_LABEL_CLASSES.length];
	}

	isConfigured(): boolean {
		return this.config.enabled && Boolean(this.config.url.trim());
	}

	statusbarEnabled(): boolean {
		return this.config.enabled;
	}

	async fetch(): Promise<void> {
		try {
			const resp = await requestUrl({
				url: this.config.url.trim(),
				method: this.config.method,
				headers: parseHeaders(this.config.headersText, this.config.apiKey),
				body:
					this.config.method === "POST" && this.config.body.trim()
						? this.config.body
						: undefined,
				throw: false,
			});
			if (resp.status < 200 || resp.status >= 300) {
				throw new Error(`${this.label} 接口返回 HTTP ${resp.status}`);
			}
			let json: any;
			try {
				json = resp.json;
			} catch {
				throw new Error(`${this.label} 返回非 JSON 内容`);
			}
			this.values = [];
			this.pcts = [];
			for (const rule of this.config.extract.slice(0, 2)) {
				if (!rule.path.trim()) continue;
				this.values.push(formatValue(resolvePath(json, rule.path), rule.format));
				this.pcts.push(
					rule.format === "percent" ? Number(resolvePath(json, rule.path)) : null,
				);
			}
			this.hasData = this.values.length > 0;
			this.fetchedAt = Date.now();
			this.error = "";
		} catch (e) {
			this.error = e instanceof Error ? e.message : String(e);
		}
	}

	private renderTemplate(): string {
		const tpl = this.config.template.trim() || "{value}";
		return tpl
			.split("{name}").join(this.label)
			.split("{value2}").join(this.values[1] ?? "--")
			.split("{value}").join(this.values[0] ?? "--");
	}

	private firstPct(): number | null {
		return this.pcts.find((p) => p !== null && !Number.isNaN(p)) ?? null;
	}

	statusBarParts(): StatusBarPart[] | null {
		if (!this.hasData) return null;
		const pct = this.firstPct();
		return [
			{
				text: ` ${this.renderTemplate()}`,
				cls: pct !== null ? pctClass(pct) : "",
			},
		];
	}

	tooltipLines(): string[] {
		if (!this.hasData) return this.error ? [`${this.label} 失败：${this.error}`] : [];
		return [`${this.label}：${this.values.join(" / ")} · 更新于 ${formatClock(this.fetchedAt)}`];
	}

	detailSection(container: HTMLElement): void {
		const sec = container.createDiv("uh-section");
		const head = sec.createDiv("uh-row-head");
		head.createEl("strong", { text: this.label });
		head.createSpan({ text: "自定义", cls: "uh-badge" });

		if (!this.hasData) {
			sec.createEl("p", { text: `${this.label}：${this.error || "暂无数据"}`, cls: "uh-error" });
			return;
		}
		for (let i = 0; i < this.config.extract.length; i++) {
			const rule = this.config.extract[i];
			if (!rule.path.trim()) continue;
			const raw = this.values[i] ?? "--";
			const pct = this.pcts[i];
			renderQuotaRow(sec, {
				label: rule.path,
				pct: pct !== null && !Number.isNaN(pct) ? pct : 0,
				valueText: raw,
			});
		}
	}
}

/** 从设置构建全部自定义 provider 实例 */
export function makeCustomProviders(settings: UsageHudSettings): CustomProvider[] {
	return (settings.customProviders ?? []).map(
		(cfg, i) => new CustomProvider(settings, cfg, i),
	);
}
