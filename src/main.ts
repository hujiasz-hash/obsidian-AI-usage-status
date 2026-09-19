import { Plugin, Notice } from "obsidian";
import {
	fetchDeepSeekBalance,
	fetchGlmQuota,
	currencySymbol,
	formatCountdown,
	type GlmQuota,
	type DeepSeekBalance,
} from "./api";
import {
	DEFAULT_SETTINGS,
	UsageHudSettingTab,
	type UsageHudSettings,
} from "./settings";
import { UsageModal } from "./modal";

export interface UsageHudState {
	glm: GlmQuota | null;
	ds: DeepSeekBalance | null;
	glmError: string;
	dsError: string;
	refreshing: boolean;
}

/** 金额智能缩写：状态栏空间有限，大额用千分位取整或 k 缩写；明细弹窗仍显示完整两位小数 */
function formatMoney(n: number): string {
	if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
	if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n >= 1000) return Math.round(n).toLocaleString("en-US");
	return n.toFixed(2);
}

export default class UsageHudPlugin extends Plugin {
	settings!: UsageHudSettings;
	state: UsageHudState = {
		glm: null,
		ds: null,
		glmError: "",
		dsError: "",
		refreshing: false,
	};
	private statusBarEl: HTMLElement | null = null;
	private pollTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

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
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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

	// ── 数据获取 ────────────────────────────────────────────

	async refresh(): Promise<void> {
		if (this.state.refreshing) return;
		this.state.refreshing = true;
		this.renderStatusBar();

		const tasks: Promise<void>[] = [];

		if (this.settings.glmApiKey) {
			tasks.push(
				fetchGlmQuota(this.settings.glmHost, this.settings.glmApiKey)
					.then((q) => {
						this.state.glm = q;
						this.state.glmError = "";
					})
					.catch((e: Error) => {
						this.state.glmError = e.message || String(e);
					}),
			);
		}
		if (this.settings.dsApiKey) {
			tasks.push(
				fetchDeepSeekBalance(this.settings.dsApiKey)
					.then((b) => {
						this.state.ds = b;
						this.state.dsError = "";
					})
					.catch((e: Error) => {
						this.state.dsError = e.message || String(e);
					}),
			);
		}

		await Promise.all(tasks);
		this.state.refreshing = false;
		this.renderStatusBar();
	}

	// ── 状态栏渲染 ──────────────────────────────────────────

	renderStatusBar(): void {
		const el = this.statusBarEl;
		if (!el) return;
		el.empty();
		el.removeAttribute("aria-label");
		el.removeAttribute("title");

		if (!this.settings.showInStatusBar) return;

		const hasGlm = Boolean(this.settings.glmApiKey);
		const hasDs = Boolean(this.settings.dsApiKey);
		if (!hasGlm && !hasDs) {
			el.setText("Usage HUD 未配置");
			el.setAttr("aria-label", "AI Usage HUD：请在设置中填入 API Key");
			return;
		}

		if (hasGlm) {
			const glm = this.state.glm;
			const span = el.createSpan({ cls: "uh-seg" });
			span.createSpan({ text: "GLM", cls: "uh-label uh-label-glm" });
			if (glm) {
				const limit = glm.tokenWeekly ?? glm.token5h; // 状态栏只显示周额度，老套餐回退 5h
				if (limit) {
					const pct = Math.round(limit.percentage ?? 0);
					span.createSpan({ text: ` ${pct}%`, cls: this.pctClass(pct) });
				} else {
					span.createSpan({ text: " --" });
				}
			} else if (this.state.glmError) {
				span.createSpan({ text: " ✕", cls: "uh-bad" });
			} else {
				span.createSpan({ text: " …" });
			}
		}

		if (hasDs) {
			const ds = this.state.ds;
			const span = el.createSpan({ cls: "uh-seg" });
			span.createSpan({ text: "DS", cls: "uh-label uh-label-ds" });
			if (ds) {
				const c = ds.currencies[0];
				if (c) {
					const warn = c.currency.toUpperCase() === "CNY"
						? c.totalBalance < this.settings.dsWarnThreshold
						: false;
					span.createSpan({
						text: ` ${currencySymbol(c.currency)}${formatMoney(c.totalBalance)}`,
						cls: warn || !ds.isAvailable ? "uh-bad" : "uh-good",
					});
				} else {
					span.createSpan({ text: " --" });
				}
			} else if (this.state.dsError) {
				span.createSpan({ text: " ✕", cls: "uh-bad" });
			} else {
				span.createSpan({ text: " …" });
			}
		}

		// tooltip：更新时间 + 各窗口详情
		const bits: string[] = [];
		if (this.state.glm) {
			const g = this.state.glm;
			const parts: string[] = [];
			if (g.token5h) parts.push(`5h ${Math.round(g.token5h.percentage ?? 0)}%${g.token5h.nextResetTime ? `（${formatCountdown(g.token5h.nextResetTime)}重置）` : ""}`);
			if (g.tokenWeekly) parts.push(`周 ${Math.round(g.tokenWeekly.percentage ?? 0)}%${g.tokenWeekly.nextResetTime ? `（${formatCountdown(g.tokenWeekly.nextResetTime)}重置）` : ""}`);
			if (g.mcp) parts.push(`MCP ${g.mcp.currentValue ?? 0}/${g.mcp.usage ?? 0}`);
			bits.push(`GLM${g.level ? " " + g.level.toUpperCase() : ""}：${parts.join(" / ")} · 更新于 ${new Date(g.fetchedAt).toLocaleTimeString()}`);
		}
		if (this.state.glmError) bits.push(`GLM 失败：${this.state.glmError}`);
		if (this.state.ds) bits.push(`DeepSeek 更新于 ${new Date(this.state.ds.fetchedAt).toLocaleTimeString()}`);
		if (this.state.dsError) bits.push(`DeepSeek 失败：${this.state.dsError}`);
		if (bits.length > 0) el.setAttr("aria-label", bits.join("\n"));
	}

	private pctClass(pct: number): string {
		if (pct >= 90) return "uh-bad";
		if (pct >= 70) return "uh-warn";
		return "uh-good";
	}

	// ── 明细弹窗 ────────────────────────────────────────────

	openDetails(): void {
		if (!this.settings.glmApiKey && !this.settings.dsApiKey) {
			new Notice("Usage HUD：请先在设置中填入 API Key");
			return;
		}
		new UsageModal(this.app, this.state, () => this.refresh()).open();
	}
}
