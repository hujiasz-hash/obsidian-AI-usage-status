import { Plugin, Notice } from "obsidian";
import { DEFAULT_SETTINGS, UsageHudSettingTab, type UsageHudSettings } from "./settings";
import { UsageModal } from "./modal";
import { GlmProvider } from "./provider/glm";
import { DeepSeekProvider } from "./provider/deepseek";
import { CopilotProvider } from "./provider/copilot";
import type { UsageProvider } from "./provider/types";

export default class UsageHudPlugin extends Plugin {
	settings!: UsageHudSettings;
	providers: UsageProvider[] = [];
	private statusBarEl: HTMLElement | null = null;
	private pollTimer: number | null = null;
	private refreshing = false;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.providers = [
			new GlmProvider(this.settings),
			new CopilotProvider(this.settings),
			new DeepSeekProvider(this.settings),
		];

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
		// schemaVersion 迁移：v0.1 配置（无 schemaVersion）补齐新字段并落盘一次
		if (!raw?.schemaVersion || raw.schemaVersion < DEFAULT_SETTINGS.schemaVersion) {
			this.settings.schemaVersion = DEFAULT_SETTINGS.schemaVersion;
			await this.saveData(this.settings);
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
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

	// ── 状态栏渲染：按 provider 顺序组装 ────────────────────

	renderStatusBar(): void {
		const el = this.statusBarEl;
		if (!el) return;
		el.empty();
		el.removeAttribute("aria-label");

		if (!this.settings.showInStatusBar) return;

		const configured = this.providers.filter((p) => p.isConfigured());
		if (configured.length === 0) {
			el.setText("Usage HUD 未配置");
			el.setAttr("aria-label", "AI Usage HUD：请在设置中填入 API Key");
			return;
		}

		const tooltipBits: string[] = [];
		for (const p of configured) {
			const parts = p.statusBarParts();
			const span = el.createSpan({ cls: "uh-seg" });
			span.createSpan({ text: p.label, cls: `uh-label ${p.labelClass}` });
			if (parts && parts.length > 0) {
				for (const part of parts) {
					span.createSpan({ text: part.text, cls: part.cls });
				}
			} else {
				// 尚未拉到数据：有错误显示 ✕，否则显示 …
				span.createSpan({ text: p.error ? " ✕" : " …", cls: p.error ? "uh-bad" : "" });
			}
			tooltipBits.push(...p.tooltipLines());
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
