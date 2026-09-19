import { Modal, App } from "obsidian";
import type { UsageProvider } from "./provider/types";

export class UsageModal extends Modal {
	providers: UsageProvider[];
	onRefresh: () => Promise<void>;

	constructor(app: App, providers: UsageProvider[], onRefresh: () => Promise<void>) {
		super(app);
		this.providers = providers.filter((p) => p.isConfigured());
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

		for (const p of this.providers) {
			p.detailSection(contentEl);
		}

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
