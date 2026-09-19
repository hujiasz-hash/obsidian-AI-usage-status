// Provider 抽象框架（PRD R1）
// 插件主循环只依赖本接口，新增 provider 只加文件不改主干。

/** 状态栏一个数值片段（标签由主循环统一渲染，数值着色由 provider 决定） */
export interface StatusBarPart {
	text: string; // 含前导空格，如 " 24%"
	cls: string; // 着色 class：uh-good / uh-warn / uh-bad 或空串
}

export interface UsageProvider {
	/** 唯一标识："glm" | "copilot" | "deepseek" | "custom-<n>" */
	readonly id: string;
	/** 状态栏标签文案 */
	readonly label: string;
	/** 标签色 class（uh-label-glm / uh-label-copilot / uh-label-ds） */
	readonly labelClass: string;

	/** 设置是否齐全；未配置的 provider 不参与轮询与显示 */
	isConfigured(): boolean;

	/** 状态栏显示开关；关闭后仅保留明细弹窗与命令（PRD R4） */
	statusbarEnabled(): boolean;

	/** 拉取数据并写回自身状态；失败置 error，不清空旧数据 */
	fetch(): Promise<void>;

	/**
	 * 状态栏片段；返回 null = 本轮无数据显示（尚未拉到数据且无数据可保留）
	 */
	statusBarParts(): StatusBarPart[] | null;

	/** hover 明细行（纯文本） */
	tooltipLines(): string[];

	/** 明细弹窗区块，写入 container */
	detailSection(container: HTMLElement): void;

	/** 最近一次错误信息，空串 = 无错误 */
	readonly error: string;
}

/** 通用进度条行渲染（明细弹窗用） */
export function renderQuotaRow(
	container: HTMLElement,
	opts: {
		label: string;
		pct: number; // 0-100，用于着色与条宽
		valueText: string; // 右侧数值文案
		resetText?: string; // 附加说明（如重置倒计时）
	},
): void {
	const row = container.createDiv("uh-quota-row");
	row.createSpan({ text: opts.label, cls: "uh-quota-label" });
	const bar = row.createDiv("uh-bar");
	bar.createDiv(`uh-bar-fill ${pctClass(opts.pct)}`).style.width = `${Math.min(100, Math.max(0, opts.pct))}%`;
	row.createSpan({ text: opts.valueText, cls: `uh-quota-pct ${pctClass(opts.pct)}` });
	if (opts.resetText) row.createSpan({ text: opts.resetText, cls: "uh-quota-reset" });
}

/** 用量百分比 → 状态色 class */
export function pctClass(pct: number): string {
	if (pct >= 90) return "uh-bad";
	if (pct >= 70) return "uh-warn";
	return "uh-good";
}
