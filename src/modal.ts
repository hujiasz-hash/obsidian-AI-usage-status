import { Modal, App } from "obsidian";
import {
	currencySymbol,
	formatClock,
	formatCountdown,
	type GlmQuota,
	type DeepSeekBalance,
} from "./api";
import type { UsageHudState } from "./main";

function pctClass(pct: number): string {
	if (pct >= 90) return "uh-bad";
	if (pct >= 70) return "uh-warn";
	return "uh-good";
}

export class UsageModal extends Modal {
	state: UsageHudState;
	onRefresh: () => Promise<void>;

	constructor(app: App, state: UsageHudState, onRefresh: () => Promise<void>) {
		super(app);
		this.state = state;
		this.onRefresh = onRefresh;
	}

	onOpen(): void {
		this.renderContent();
	}

	private async refresh(): Promise<void> {
		await this.onRefresh();
		this.renderContent();
	}

	private renderContent(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("uh-modal");

		contentEl.createEl("h3", { text: "AI 用量明细" });

		const updatedBits: string[] = [];
		if (this.state.glm) updatedBits.push(`GLM ${formatClock(this.state.glm.fetchedAt)}`);
		if (this.state.ds) updatedBits.push(`DeepSeek ${formatClock(this.state.ds.fetchedAt)}`);
		if (this.state.glmError) updatedBits.push(`⚠ GLM: ${this.state.glmError}`);
		if (this.state.dsError) updatedBits.push(`⚠ DeepSeek: ${this.state.dsError}`);
		if (updatedBits.length > 0) {
			contentEl.createEl("p", {
				text: `更新于 ${updatedBits.join(" · ")}`,
				cls: "uh-updated",
			});
		}

		// ── GLM ──────────────────────────────────────────────
		const glm = this.state.glm;
		if (glm) {
			const sec = contentEl.createDiv("uh-section");
			const head = sec.createDiv("uh-row-head");
			head.createEl("strong", { text: "GLM Coding Plan" });
			if (glm.level) {
				head.createSpan({ text: glm.level.toUpperCase(), cls: "uh-badge" });
			}

			const rows: { label: string; limit?: { percentage?: number; nextResetTime?: number } }[] = [
				{ label: "5 小时窗口", limit: glm.token5h },
				{ label: "每周窗口", limit: glm.tokenWeekly },
			];
			for (const { label, limit } of rows) {
				if (!limit) continue;
				const pct = Math.round(limit.percentage ?? 0);
				const row = sec.createDiv("uh-quota-row");
				row.createSpan({ text: label, cls: "uh-quota-label" });
				const bar = row.createDiv("uh-bar");
				bar.createDiv(`uh-bar-fill ${pctClass(pct)}`).style.width = `${Math.min(100, pct)}%`;
				row.createSpan({ text: `${pct}%`, cls: `uh-quota-pct ${pctClass(pct)}` });
				const reset = formatCountdown(limit.nextResetTime);
				if (reset) row.createSpan({ text: reset, cls: "uh-quota-reset" });
			}

			if (glm.mcp) {
				const used = glm.mcp.currentValue ?? 0;
				const total = glm.mcp.usage ?? 0;
				const pct = Math.round(glm.mcp.percentage ?? 0);
				const row = sec.createDiv("uh-quota-row");
				row.createSpan({ text: "MCP 月用量", cls: "uh-quota-label" });
				const bar = row.createDiv("uh-bar");
				bar.createDiv(`uh-bar-fill ${pctClass(pct)}`).style.width = `${Math.min(100, pct)}%`;
				row.createSpan({ text: `${used}/${total}`, cls: `uh-quota-pct ${pctClass(pct)}` });
				const reset = formatCountdown(glm.mcp.nextResetTime);
				if (reset) row.createSpan({ text: reset, cls: "uh-quota-reset" });
			}
		} else if (this.state.glmError) {
			contentEl.createEl("p", { text: `GLM：${this.state.glmError}`, cls: "uh-error" });
		}

		// ── DeepSeek ─────────────────────────────────────────
		const ds = this.state.ds;
		if (ds) {
			const sec = contentEl.createDiv("uh-section");
			const head = sec.createDiv("uh-row-head");
			head.createEl("strong", { text: "DeepSeek" });
			head.createSpan({
				text: ds.isAvailable ? "可用" : "余额不足",
				cls: ds.isAvailable ? "uh-badge uh-badge-ok" : "uh-badge uh-badge-bad",
			});
			for (const c of ds.currencies) {
				const s = currencySymbol(c.currency);
				const row = sec.createDiv("uh-quota-row");
				row.createSpan({ text: `余额 (${c.currency})`, cls: "uh-quota-label" });
				row.createSpan({
					text: `${s}${c.totalBalance.toFixed(2)}`,
					cls: "uh-quota-pct uh-good",
				});
				if (c.grantedBalance > 0) {
					row.createSpan({ text: `赠金 ${s}${c.grantedBalance.toFixed(2)}`, cls: "uh-quota-reset" });
				}
			}
		} else if (this.state.dsError) {
			contentEl.createEl("p", { text: `DeepSeek：${this.state.dsError}`, cls: "uh-error" });
		}

		// ── 刷新按钮 ─────────────────────────────────────────
		const btnRow = contentEl.createDiv("uh-btn-row");
		const btn = btnRow.createEl("button", { text: "立即刷新" });
		btn.addEventListener("click", async () => {
			btn.disabled = true;
			btn.textContent = "刷新中…";
			await this.refresh();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
