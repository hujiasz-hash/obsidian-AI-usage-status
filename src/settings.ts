import { App, PluginSettingTab, Setting } from "obsidian";
import type UsageHudPlugin from "./main";
import type { CustomProviderConfig } from "./provider/custom";

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

export const GLM_METRICS: Record<string, string> = {
	weekly: "周额度",
	"5h": "5 小时窗口",
	both: "两者 (5h/周)",
};

export const COPILOT_METRICS: Record<string, string> = {
	pct: "额度百分比",
	remaining: "剩余次数",
};

export const DS_METRICS: Record<string, string> = {
	balance: "余额金额",
	status: "仅可用状态点",
};

export const SEPARATORS: Record<string, string> = {
	space: "半角空格",
	none: "无",
	pipe: "竖线 │",
	dot: "中点 ·",
};

export interface UsageHudSettings {
	schemaVersion: number; // 3 = provider 框架 + 显示配置 + 自定义 API
	glmHost: string;
	glmApiKey: string;
	dsApiKey: string;
	ghUsername: string;
	ghPat: string;
	ghTier: string;
	intervalMin: number;
	dsWarnThreshold: number;
	showInStatusBar: boolean;
	// ── v0.2 显示配置（PRD R4）──
	showGlm: boolean;
	glmMetric: string; // weekly | 5h | both
	showCopilot: boolean;
	copilotMetric: string; // pct | remaining
	showDs: boolean;
	dsMetric: string; // balance | status
	statusbarTemplate: string; // 占位符: {glm} {copilot} {deepseek} {custom:名称}
	separator: string; // space | none | pipe | dot
	// ── v0.2 自定义 API（PRD R3）──
	customProviders: CustomProviderConfig[];
}

export const DEFAULT_SETTINGS: UsageHudSettings = {
	schemaVersion: 3,
	glmHost: "https://open.bigmodel.cn",
	glmApiKey: "",
	dsApiKey: "",
	ghUsername: "",
	ghPat: "",
	ghTier: "pro",
	intervalMin: 5,
	dsWarnThreshold: 10,
	showInStatusBar: true,
	showGlm: true,
	glmMetric: "weekly",
	showCopilot: true,
	copilotMetric: "pct",
	showDs: true,
	dsMetric: "balance",
	statusbarTemplate: "{glm} {copilot} {deepseek}",
	separator: "space",
	customProviders: [],
};

export class UsageHudSettingTab extends PluginSettingTab {
	plugin: UsageHudPlugin;

	constructor(app: App, plugin: UsageHudPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** 保存 + 重建 provider + 刷新（自定义 API 变更时用） */
	private async applyCustomChanges(): Promise<void> {
		await this.plugin.saveSettings();
		await this.plugin.rebuildProviders();
		this.display(); // 重新渲染列表（增删后序号/内容变化）
	}

	/** 分区卡片：带底色容器 + 彩色标题条（accent 对应各 provider 品牌色） */
	private card(containerEl: HTMLElement, title: string, accent: string): HTMLElement {
		const card = containerEl.createDiv("uh-card");
		const h = card.createDiv(`uh-card-title uh-accent-${accent}`);
		h.setText(title);
		return card;
	}

	/**
	 * 统一条目构造：名字 + 控件保持单行；说明文字放入名字后的问号 tooltip
	 * （代替 setDesc，保证条目高度低且统一）
	 */
	private row(card: HTMLElement, name: string, desc?: string): Setting {
		const s = new Setting(card).setName(name);
		if (desc) {
			const help = s.nameEl.createSpan({ text: "?", cls: "uh-help" });
			help.setAttr("aria-label", desc);
			help.setAttr("aria-label-position", "top");
		}
		return s;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ─────────────────── GLM ───────────────────
		const glmCard = this.card(containerEl, "GLM Coding Plan", "glm");

		this.row(glmCard, "状态栏显示")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.showGlm).onChange(async (v) => {
					this.plugin.settings.showGlm = v;
					await this.plugin.saveSettings();
					this.plugin.renderStatusBar();
				});
			});

		this.row(glmCard, "站点")
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

		this.row(glmCard, "显示指标")
			.addDropdown((drop) => {
				for (const [k, label] of Object.entries(GLM_METRICS)) {
					drop.addOption(k, label);
				}
				drop.setValue(this.plugin.settings.glmMetric).onChange(async (v) => {
					this.plugin.settings.glmMetric = v;
					await this.plugin.saveSettings();
					this.plugin.renderStatusBar();
				});
			});

		this.row(glmCard, "API Key", "open.bigmodel.cn 控制台 → API Keys（形如 xxxxxxxx.yyyyyyyy），只存本机")
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.style.width = "100%";
				text.setValue(this.plugin.settings.glmApiKey).onChange(async (v) => {
					this.plugin.settings.glmApiKey = v.trim();
					await this.plugin.saveSettings();
				});
			});

		// ─────────────── GitHub Copilot ───────────────
		const ghCard = this.card(containerEl, "GitHub Copilot", "copilot");

		this.row(ghCard, "状态栏显示")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.showCopilot).onChange(async (v) => {
					this.plugin.settings.showCopilot = v;
					await this.plugin.saveSettings();
					this.plugin.renderStatusBar();
				});
			});

		this.row(ghCard, "用户名", "个人版 Copilot 账号的 GitHub 用户名")
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

		this.row(ghCard, "PAT", "fine-grained Personal Access Token，需 Plan: Read 权限，只存本机")
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

		this.row(ghCard, "套餐", "用于确定每月额度上限；接口返回 limit 字段时优先使用")
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

		this.row(ghCard, "显示内容")
			.addDropdown((drop) => {
				for (const [k, label] of Object.entries(COPILOT_METRICS)) {
					drop.addOption(k, label);
				}
				drop.setValue(this.plugin.settings.copilotMetric).onChange(async (v) => {
					this.plugin.settings.copilotMetric = v;
					await this.plugin.saveSettings();
					this.plugin.renderStatusBar();
				});
			});

		// ─────────────────── DeepSeek ───────────────────
		const dsCard = this.card(containerEl, "DeepSeek", "ds");

		this.row(dsCard, "状态栏显示")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.showDs).onChange(async (v) => {
					this.plugin.settings.showDs = v;
					await this.plugin.saveSettings();
					this.plugin.renderStatusBar();
				});
			});

		this.row(dsCard, "API Key", "platform.deepseek.com → API keys，只存本机")
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.style.width = "100%";
				text.setValue(this.plugin.settings.dsApiKey).onChange(async (v) => {
					this.plugin.settings.dsApiKey = v.trim();
					await this.plugin.saveSettings();
				});
			});

		this.row(dsCard, "显示内容")
			.addDropdown((drop) => {
				for (const [k, label] of Object.entries(DS_METRICS)) {
					drop.addOption(k, label);
				}
				drop.setValue(this.plugin.settings.dsMetric).onChange(async (v) => {
					this.plugin.settings.dsMetric = v;
					await this.plugin.saveSettings();
					this.plugin.renderStatusBar();
				});
			});

		this.row(dsCard, "余额预警（元）", "CNY 余额低于该值时状态栏变红，默认 10")
			.addText((text) => {
				text.inputEl.type = "number";
				text.setValue(String(this.plugin.settings.dsWarnThreshold)).onChange(async (v) => {
					this.plugin.settings.dsWarnThreshold = Math.max(0, Number(v) || 0);
					await this.plugin.saveSettings();
					this.plugin.renderStatusBar();
				});
			});

		// ─────────────────── 状态栏格式 ───────────────────
		const fmtCard = this.card(containerEl, "状态栏格式", "format");

		this.row(
			fmtCard,
			"显示模板",
			"占位符：{glm} {copilot} {deepseek} {custom:名称}；未启用的自动移除，无效时回退默认顺序",
		)
			.addText((text) => {
				text.inputEl.style.width = "100%";
				text
					.setPlaceholder(DEFAULT_SETTINGS.statusbarTemplate)
					.setValue(this.plugin.settings.statusbarTemplate)
					.onChange(async (v) => {
						this.plugin.settings.statusbarTemplate = v;
						await this.plugin.saveSettings();
						this.plugin.renderStatusBar();
					});
			});

		this.row(fmtCard, "分隔符")
			.addDropdown((drop) => {
				for (const [k, label] of Object.entries(SEPARATORS)) {
					drop.addOption(k, label);
				}
				drop.setValue(this.plugin.settings.separator).onChange(async (v) => {
					this.plugin.settings.separator = v;
					await this.plugin.saveSettings();
					this.plugin.renderStatusBar();
				});
			});

		this.row(fmtCard, "显示状态栏", "总开关：关闭后仅保留命令面板入口")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.showInStatusBar).onChange(async (v) => {
					this.plugin.settings.showInStatusBar = v;
					await this.plugin.saveSettings();
					this.plugin.renderStatusBar();
				});
			});

		// ─────────────────── 自定义 API ───────────────────
		const customCard = this.card(containerEl, "自定义 API（最多 5 条）", "custom");

		const list = this.plugin.settings.customProviders ?? [];
		list.forEach((cfg, index) => {
			this.renderCustomCard(customCard, cfg, index);
		});

		new Setting(customCard).addButton((btn) => {
			btn.setButtonText("＋ 添加自定义 API").setDisabled(list.length >= 5);
			btn.onClick(async () => {
				this.plugin.settings.customProviders.push({
					id: `custom-${Date.now()}`,
					name: "",
					url: "",
					method: "GET",
					headersText: "",
					body: "",
					apiKey: "",
					enabled: true,
					extract: [{ path: "", format: "percent" }],
					template: "{value}",
				});
				await this.applyCustomChanges();
			});
		});

		// ─────────────────── 通用 ───────────────────
		const genCard = this.card(containerEl, "通用", "general");

		this.row(genCard, "刷新间隔（分钟）", "自动轮询间隔，1–120 分钟，默认 5")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text.inputEl.max = "120";
				text.setValue(String(this.plugin.settings.intervalMin)).onChange(async (v) => {
					this.plugin.settings.intervalMin = Math.min(120, Math.max(1, Number(v) || 5));
					await this.plugin.saveSettings();
					this.plugin.restartPolling();
				});
			});

		this.equalizeCardHeights();
	}

	/** 每张卡片内条目统一高度（按卡内最高条目取齐；自定义 API 子卡片内容不参与）。
	 *  渲染时序不定，多次幂等执行确保覆盖（detached/未渲染完时测量无效自动跳过） */
	private equalizeCardHeights(): void {
		const apply = () => {
			const root = this.containerEl;
			if (!root.isConnected) return;
			const cards = Array.from(root.querySelectorAll(".uh-card"));
			for (const card of cards) {
				const items = Array.from(card.querySelectorAll(":scope > .setting-item"));
				if (items.length === 0) continue;
				const max = Math.max(
					...items.map((i) => (i as HTMLElement).getBoundingClientRect().height),
				);
				if (max <= 0) continue;
				for (const item of items) {
					(item as HTMLElement).style.minHeight = `${Math.round(max)}px`;
				}
			}
		};
		for (const delay of [200, 600, 1200, 2000]) {
			window.setTimeout(apply, delay);
		}
	}

	/** 单条自定义 API 的配置卡片 */
	private renderCustomCard(containerEl: HTMLElement, cfg: CustomProviderConfig, index: number): void {
		const card = containerEl.createDiv("uh-custom-card");
		const indexInfo = `#${index + 1}`;

		new Setting(card)
			.setName(`${indexInfo} ${cfg.name || "（未命名）"}`)
			.addToggle((toggle) => {
				toggle.setTooltip("启用/停用").setValue(cfg.enabled).onChange(async (v) => {
					cfg.enabled = v;
					await this.applyCustomChanges();
				});
			})
			.addButton((btn) => {
				btn.setIcon("trash").setTooltip("删除").onClick(async () => {
					this.plugin.settings.customProviders = this.plugin.settings.customProviders.filter(
						(c) => c.id !== cfg.id,
					);
					await this.applyCustomChanges();
				});
			});

		this.row(card, "名称").addText((text) => {
			text.inputEl.style.width = "100%";
			text.setPlaceholder("Relay").setValue(cfg.name).onChange(async (v) => {
				cfg.name = v.trim();
				await this.plugin.saveSettings();
			});
		});

		this.row(card, "URL").addText((text) => {
			text.inputEl.style.width = "100%";
			text.setPlaceholder("https://example.com/api/quota").setValue(cfg.url).onChange(async (v) => {
				cfg.url = v.trim();
				await this.plugin.saveSettings();
			});
		});

		this.row(card, "Method")
			.addDropdown((drop) => {
				drop.addOption("GET", "GET");
				drop.addOption("POST", "POST");
				drop.setValue(cfg.method).onChange(async (v) => {
					cfg.method = v as "GET" | "POST";
					await this.plugin.saveSettings();
				});
			});

		this.row(card, "Headers", '每行一条 "Key: Value"，值可用 {apiKey} 代表下方 API Key')
			.addTextArea((ta) => {
				ta.inputEl.style.width = "100%";
				ta.inputEl.rows = 2;
				ta.setPlaceholder("Authorization: Bearer {apiKey}").setValue(cfg.headersText).onChange(
					async (v) => {
						cfg.headersText = v;
						await this.plugin.saveSettings();
					},
				);
			});

		this.row(card, "Body（POST）")
			.addTextArea((ta) => {
				ta.inputEl.style.width = "100%";
				ta.inputEl.rows = 1;
				ta.setValue(cfg.body).onChange(async (v) => {
					cfg.body = v;
					await this.plugin.saveSettings();
				});
			});

		this.row(card, "API Key", "仅供 Headers 中 {apiKey} 引用")
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.style.width = "100%";
				text.setValue(cfg.apiKey).onChange(async (v) => {
					cfg.apiKey = v.trim();
					await this.plugin.saveSettings();
				});
			});

		// 提取规则（最多 2 条）
		for (let i = 0; i < 2; i++) {
			const rule = cfg.extract[i];
			if (!rule) continue;
			this.row(card, i === 0 ? "提取值 1" : "提取值 2", i === 0 ? "JSON 点路径 → 显示值" : "可选，模板中用 {value2}")
				.addText((text) => {
					text.inputEl.style.width = "55%";
					text.setPlaceholder("data.percentage").setValue(rule.path).onChange(async (v) => {
						rule.path = v.trim();
						await this.plugin.saveSettings();
					});
				})
				.addDropdown((drop) => {
					drop.addOption("percent", "百分比");
					drop.addOption("money", "金额");
					drop.addOption("raw", "原文");
					drop.setValue(rule.format).onChange(async (v) => {
						rule.format = v as "percent" | "money" | "raw";
						await this.plugin.saveSettings();
					});
				});
		}

		this.row(card, "显示模板", "可用 {name} {value} {value2}，默认 {value}")
			.addText((text) => {
				text.inputEl.style.width = "100%";
				text.setPlaceholder("{value}").setValue(cfg.template).onChange(async (v) => {
					cfg.template = v;
					await this.plugin.saveSettings();
				});
			});
	}
}
