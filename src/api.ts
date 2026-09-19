/** 公共格式化辅助（provider 共用） */

export function currencySymbol(currency: string): string {
	switch (currency.toUpperCase()) {
		case "CNY":
			return "¥";
		case "USD":
			return "$";
		default:
			return `${currency} `;
	}
}

/** 毫秒时间戳 → "3天2小时后" / "5小时32分后" / "42分钟后" / "即将重置" */
export function formatCountdown(tsMs?: number): string {
	if (!tsMs) return "";
	const secs = Math.max(0, Math.floor((tsMs - Date.now()) / 1000));
	if (secs === 0) return "即将重置";
	const days = Math.floor(secs / 86400);
	const hours = Math.floor((secs % 86400) / 3600);
	const mins = Math.floor((secs % 3600) / 60);
	if (days > 0) return `${days}天${hours}小时后`;
	if (hours > 0) return `${hours}小时${mins}分后`;
	return `${mins}分钟后`;
}

/** 毫秒时间戳 → "06-22 00:32" */
export function formatClock(tsMs?: number): string {
	if (!tsMs) return "";
	const d = new Date(tsMs);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
