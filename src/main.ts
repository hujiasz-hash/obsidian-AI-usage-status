import { Plugin, Notice } from "obsidian";
import { DEFAULT_SETTINGS, UsageHudSettingTab, type UsageHudSettings } from "./settings";
import { UsageModal } from "./modal";
import { GlmProvider } from "./provider/glm";
import { DeepSeekProvider } from "./provider/deepseek";
import { CopilotProvider } from "./provider/copilot";
import { makeCustomProviders } from "./provider/custom";
import type { UsageProvider } from "./provider/types";

/** 分隔符文案（PRD R4）：占位符之间的连接物 */
const SEPARATOR_TEXT: Record<string, string> = {
	space: " ",
	none: "",
	pipe: " │ ",
	dot: " · ",
};

const TEMPLATE_TOKEN_RE = /\{(glm|copilot|deepseek|custom:[^}]+)\}/g;

export default class UsageHudPlugin extends Plugin {
	settings!: UsageHudSettings;
	providers: UsageProvider[] = [];
	private statusBarEl: HTMLElement | null = null;
	private pollTimer: number | null = null;
	private refreshing = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.buildProviders();

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("uh-statusbar");
		this.statusBarEl.addEventListener("click", () => this.openDetails());
		this.renderStatusBar();

		this.addSettingTab(new UsageHudSettingTab(this.app, this));

		this.addCommand({
			id: "refresh-usage",
			name: "刷新用量",
			callback: () => this.refresh(),
		});
		this.addCommand({
			id: "show-details",
			name: "打开用量明细",
			callback: () => this.openDetails(),
		});

		// 启动即查一次，然后定时轮询
		this.refresh();
		this.restartPolling();
	}

	onunload(): void {
		this.stopPolling();
	}

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as Partial<UsageHudSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw ?? {});
		this.settings.customProviders = this.settings.customProviders ?? [];
		// schemaVersion 迁移：旧版配置补齐新字段并落盘一次
		if (!raw?.schemaVersion || raw.schemaVersion < DEFAULT_SETTINGS.schemaVersion) {
			this.settings.schemaVersion = DEFAULT_SETTINGS.schemaVersion;
			await this.saveData(this.settings);
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private buildProviders(): void {
		this.providers = [
			new GlmProvider(this.settings),
			new CopilotProvider(this.settings),
			new DeepSeekProvider(this.settings),
			...makeCustomProviders(this.settings),
		];
	}

	/** 自定义 API 增删改后调用：重建 provider 列表并刷新 */
	async rebuildProviders(): Promise<void> {
		this.buildProviders();
		await this.refresh();
	}

	// ── 轮询 ────────────────────────────────────────────────

	restartPolling(): void {
		this.stopPolling();
		const ms = Math.min(120, Math.max(1, this.settings.intervalMin)) * 60 * 1000;
		this.pollTimer = window.setInterval(() => this.refresh(), ms);
		this.registerInterval(this.pollTimer);
	}

	private stopPolling(): void {
		if (this.pollTimer !== null) {
			window.clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	// ── 数据获取：依次驱动各 provider，互不拖累 ─────────────

	async refresh(): Promise<void> {
		if (this.refreshing) return;
		this.refreshing = true;
		this.renderStatusBar();

		await Promise.allSettled(
			this.providers.filter((p) => p.isConfigured()).map((p) => p.fetch()),
		);

		this.refreshing = false;
		this.renderStatusBar();
	}

	// ── 状态栏渲染：模板引擎（PRD R4）────────────────────────

	/** 解析模板 → provider 实例序列；模板无有效占位符返回 invalid=true */
	private resolveTemplate(active: UsageProvider[]): { selected: UsageProvider[]; invalid: boolean } {
		const tokens = [...this.settings.statusbarTemplate.matchAll(TEMPLATE_TOKEN_RE)].map(
			(m) => m[1],
		);
		if (tokens.length === 0) return { selected: [...active], invalid: true };

		const matched: UsageProvider[] = [];
		for (const token of tokens) {
			const provider = active.find((p) =>
				token.startsWith("custom:")
					? "config" in p && (p as any).config?.name === token.slice(7)
					: p.id === token,
			);
			if (provider && !matched.includes(provider)) matched.push(provider);
		}
		// 模板中未出现的自定义 provider 自动追加（“加完即可见”；隐藏走 enabled 开关）
		for (const p of active) {
			if ("isCustom" in p && !matched.includes(p)) matched.push(p);
		}
		return { selected: matched, invalid: false };
	}

	renderStatusBar(): void {
		const el = this.statusBarEl;
		if (!el) return;
		el.empty();
		el.removeAttribute("aria-label");

		if (!this.settings.showInStatusBar) return;

		const active = this.providers.filter((p) => p.isConfigured() && p.statusbarEnabled());
		if (active.length === 0) {
			const anyConfigured = this.providers.some((p) => p.isConfigured());
			el.setText(anyConfigured ? "" : "Usage HUD 未配置");
			if (!anyConfigured) {
				el.setAttr("aria-label", "AI Usage HUD：请在设置中填入 API Key");
			}
			return;
		}

		// 模板解析：无效/无匹配 → 回退默认顺序（PRD R4 验收）
		const { selected, invalid: templateInvalid } = this.resolveTemplate(active);

		const sep = SEPARATOR_TEXT[this.settings.separator] ?? " ";
		const tooltipBits: string[] = [];
		selected.forEach((p, i) => {
			if (i > 0 && sep) {
				el.createSpan({ text: sep, cls: "uh-sep" });
			}
			const parts = p.statusBarParts();
			const span = el.createSpan({ cls: "uh-seg" });
			span.createSpan({ text: p.label, cls: `uh-label ${p.labelClass}` });
			if (parts && parts.length > 0) {
				for (const part of parts) {
					span.createSpan({ text: part.text, cls: part.cls });
				}
			} else {
				span.createSpan({ text: p.error ? " ✕" : " …", cls: p.error ? "uh-bad" : "" });
			}
			tooltipBits.push(...p.tooltipLines());
		});

		if (templateInvalid) {
			tooltipBits.push("⚠ 状态栏模板无效，已回退默认顺序（请检查设置中的显示模板）");
		}
		if (tooltipBits.length > 0) el.setAttr("aria-label", tooltipBits.join("\n"));
	}

	// ── 明细弹窗 ────────────────────────────────────────────

	openDetails(): void {
		if (this.providers.every((p) => !p.isConfigured())) {
			new Notice("Usage HUD：请先在设置中填入 API Key");
			return;
		}
		new UsageModal(this.app, this.providers, () => this.refresh()).open();
	}
}
