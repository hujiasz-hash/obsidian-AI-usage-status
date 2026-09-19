import { App, PluginSettingTab, Setting } from "obsidian";
import type UsageHudPlugin from "./main";

export const GLM_HOSTS: Record<string, string> = {
	"https://open.bigmodel.cn": "智谱国内站 (open.bigmodel.cn)",
	"https://api.z.ai": "Z.ai 国际站 (api.z.ai)",
};

export const GH_TIERS: Record<string, string> = {
	pro: "Copilot Pro (300/月)",
	free: "Copilot Free (50/月)",
	"pro+": "Copilot Pro+ (1500/月)",
	business: "Copilot Business (300/月)",
	enterprise: "Copilot Enterprise (1000/月)",
};

export interface UsageHudSettings {
	schemaVersion: number; // 2 = 引入 provider 框架与 Copilot
	glmHost: string;
	glmApiKey: string;
	dsApiKey: string;
	ghUsername: string;
	ghPat: string;
	ghTier: string; // COPILOT_PLAN_LIMITS 的 key
	intervalMin: number;
	dsWarnThreshold: number;
	showInStatusBar: boolean;
}

export const DEFAULT_SETTINGS: UsageHudSettings = {
	schemaVersion: 2,
	glmHost: "https://open.bigmodel.cn",
	glmApiKey: "",
	dsApiKey: "",
	ghUsername: "",
	ghPat: "",
	ghTier: "pro",
	intervalMin: 5,
	dsWarnThreshold: 10,
	showInStatusBar: true,
};

export class UsageHudSettingTab extends PluginSettingTab {
	plugin: UsageHudPlugin;

	constructor(app: App, plugin: UsageHudPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("GLM Coding Plan").setHeading();

		new Setting(containerEl)
			.setName("站点")
			.setDesc("你的套餐所属站点")
			.addDropdown((drop) => {
				for (const [host, label] of Object.entries(GLM_HOSTS)) {
					drop.addOption(host, label);
				}
				drop.setValue(this.plugin.settings.glmHost).onChange(async (v) => {
					this.plugin.settings.glmHost = v;
					await this.plugin.saveSettings();
					this.plugin.refresh();
				});
			});

		new Setting(containerEl)
			.setName("GLM API Key")
			.setDesc("open.bigmodel.cn 控制台 → API Keys。格式形如 xxxxxxxx.yyyyyyyy。只存本机。")
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.style.width = "100%";
				text
					.setPlaceholder("")
					.setValue(this.plugin.settings.glmApiKey)
					.onChange(async (v) => {
						this.plugin.settings.glmApiKey = v.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl).setName("GitHub Copilot").setHeading();

		new Setting(containerEl)
			.setName("GitHub 用户名")
			.setDesc("个人版 Copilot 账号的用户名")
			.addText((text) => {
				text.inputEl.style.width = "100%";
				text
					.setPlaceholder("octocat")
					.setValue(this.plugin.settings.ghUsername)
					.onChange(async (v) => {
						this.plugin.settings.ghUsername = v.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("GitHub PAT")
			.setDesc("fine-grained Personal Access Token，需 Plan: Read 权限。只存本机。")
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.style.width = "100%";
				text
					.setPlaceholder("github_pat_…")
					.setValue(this.plugin.settings.ghPat)
					.onChange(async (v) => {
						this.plugin.settings.ghPat = v.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Copilot 套餐")
			.setDesc("用于确定每月额度上限；若接口返回 limit 字段则优先使用")
			.addDropdown((drop) => {
				for (const [tier, label] of Object.entries(GH_TIERS)) {
					drop.addOption(tier, label);
				}
				drop.setValue(this.plugin.settings.ghTier).onChange(async (v) => {
					this.plugin.settings.ghTier = v;
					await this.plugin.saveSettings();
					this.plugin.refresh();
				});
			});

		new Setting(containerEl).setName("DeepSeek").setHeading();

		new Setting(containerEl)
			.setName("DeepSeek API Key")
			.setDesc("platform.deepseek.com → API keys。只存本机。")
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.style.width = "100%";
				text
					.setPlaceholder("")
					.setValue(this.plugin.settings.dsApiKey)
					.onChange(async (v) => {
						this.plugin.settings.dsApiKey = v.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl).setName("通用").setHeading();

		new Setting(containerEl)
			.setName("刷新间隔（分钟）")
			.setDesc("自动轮询间隔，1–120 分钟，默认 5")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text.inputEl.max = "120";
				text
					.setValue(String(this.plugin.settings.intervalMin))
					.onChange(async (v) => {
						const n = Math.min(120, Math.max(1, Number(v) || 5));
						this.plugin.settings.intervalMin = n;
						await this.plugin.saveSettings();
						this.plugin.restartPolling();
					});
			});

		new Setting(containerEl)
			.setName("DeepSeek 余额预警（元）")
			.setDesc("余额低于该值时状态栏变红，默认 10")
			.addText((text) => {
				text.inputEl.type = "number";
				text
					.setValue(String(this.plugin.settings.dsWarnThreshold))
					.onChange(async (v) => {
						const n = Math.max(0, Number(v) || 0);
						this.plugin.settings.dsWarnThreshold = n;
						await this.plugin.saveSettings();
						this.plugin.renderStatusBar();
					});
			});

		new Setting(containerEl)
			.setName("显示状态栏")
			.setDesc("关闭后仅保留命令面板入口")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.showInStatusBar).onChange(async (v) => {
					this.plugin.settings.showInStatusBar = v;
					await this.plugin.saveSettings();
					this.plugin.renderStatusBar();
				});
			});
	}
}
