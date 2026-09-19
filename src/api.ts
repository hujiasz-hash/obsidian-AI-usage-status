import { requestUrl } from "obsidian";

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

/** GLM quota/limit 接口里一个限制条目 */
export interface GlmLimit {
	type: string; // TOKENS_LIMIT | TIME_LIMIT
	percentage?: number;
	nextResetTime?: number; // 毫秒时间戳
	unit?: number; // 3=小时窗口 6=周窗口
	number?: number; // 如 5 表示 5 小时
	usage?: number; // TIME_LIMIT: 总量
	currentValue?: number; // TIME_LIMIT: 已用
	remaining?: number; // TIME_LIMIT: 剩余
	usageDetails?: { modelCode?: string; usage?: number }[];
}

export interface GlmQuota {
	level: string; // lite / pro / max
	token5h?: GlmLimit;
	tokenWeekly?: GlmLimit;
	mcp?: GlmLimit;
	fetchedAt: number; // 本机时间戳 ms
}

export interface DeepSeekCurrency {
	currency: string; // CNY / USD
	totalBalance: number;
	grantedBalance: number;
	toppedUpBalance: number;
}

export interface DeepSeekBalance {
	isAvailable: boolean;
	currencies: DeepSeekCurrency[];
	fetchedAt: number;
}

export class ApiError extends Error {
	constructor(
		message: string,
		public status?: number,
	) {
		super(message);
		this.name = "ApiError";
	}
}

// ─────────────────────────────────────────────────────────────
// GLM Coding Plan 用量（内部接口，未公开文档；认证头直接放 key，不加 Bearer）
// 参考: https://github.com/zai-org/zai-coding-plugins (官方 glm-plan-usage)
//      https://github.com/farion1231/cc-switch/issues/1588
// ─────────────────────────────────────────────────────────────

export async function fetchGlmQuota(
	host: string,
	apiKey: string,
): Promise<GlmQuota> {
	const url = `${host}/api/monitor/usage/quota/limit`;
	const resp = await requestUrl({
		url,
		method: "GET",
		headers: {
			Authorization: apiKey, // 注意：直接放 key，不要 "Bearer " 前缀
			"Content-Type": "application/json",
		},
		throw: false,
	});

	if (resp.status === 401 || resp.status === 403) {
		throw new ApiError(`GLM 认证失败 (HTTP ${resp.status})，检查 API Key`, resp.status);
	}
	if (resp.status !== 200) {
		throw new ApiError(`GLM 接口返回 HTTP ${resp.status}`, resp.status);
	}

	let body: any;
	try {
		body = resp.json;
	} catch {
		throw new ApiError("GLM 接口返回非 JSON 内容");
	}
	if (!body?.success || !body?.data) {
		throw new ApiError(`GLM 接口返回失败: ${body?.msg ?? "未知错误"}`);
	}

	const quota: GlmQuota = {
		level: String(body.data.level ?? "").trim(),
		fetchedAt: Date.now(),
	};

	for (const item of (body.data.limits ?? []) as GlmLimit[]) {
		if (item.type === "TOKENS_LIMIT") {
			// unit=3 → 小时窗口(通常 5h)，unit=6 → 周窗口；新套餐两个都有，老套餐只有 5h
			if (item.unit === 6) {
				quota.tokenWeekly = item;
			} else if (item.unit === 3 || !quota.token5h) {
				quota.token5h = item;
			}
		} else if (item.type === "TIME_LIMIT") {
			quota.mcp = item;
		}
	}
	return quota;
}

// ─────────────────────────────────────────────────────────────
// DeepSeek 余额（官方公开接口）
// 文档: https://api-docs.deepseek.com/api/get-user-balance
// ─────────────────────────────────────────────────────────────

export async function fetchDeepSeekBalance(apiKey: string): Promise<DeepSeekBalance> {
	const resp = await requestUrl({
		url: "https://api.deepseek.com/user/balance",
		method: "GET",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
		},
		throw: false,
	});

	if (resp.status === 401 || resp.status === 403) {
		throw new ApiError(`DeepSeek 认证失败 (HTTP ${resp.status})，检查 API Key`, resp.status);
	}
	if (resp.status !== 200) {
		throw new ApiError(`DeepSeek 接口返回 HTTP ${resp.status}`, resp.status);
	}

	let body: any;
	try {
		body = resp.json;
	} catch {
		throw new ApiError("DeepSeek 接口返回非 JSON 内容");
	}

	const currencies: DeepSeekCurrency[] = (body?.balance_infos ?? []).map((info: any) => ({
		currency: String(info.currency ?? ""),
		totalBalance: Number(info.total_balance ?? 0),
		grantedBalance: Number(info.granted_balance ?? 0),
		toppedUpBalance: Number(info.topped_up_balance ?? 0),
	}));

	return {
		isAvailable: Boolean(body?.is_available),
		currencies,
		fetchedAt: Date.now(),
	};
}

// ─────────────────────────────────────────────────────────────
// 格式化辅助
// ─────────────────────────────────────────────────────────────

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
