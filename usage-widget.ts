import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

interface UsageBucket {
	utilization: number;
	resets_at: string | null;
}

interface UsageResponse {
	five_hour: UsageBucket | null;
	seven_day: UsageBucket | null;
	seven_day_opus: UsageBucket | null;
}

interface CodexWindow {
	used_percent: number;
	reset_at: number;
}

interface CodexUsageResponse {
	rate_limit?: {
		primary_window?: CodexWindow | null;
		secondary_window?: CodexWindow | null;
	} | null;
}

function pad2(n: number): string {
	return n.toString().padStart(2, "0");
}

function formatResetTime5h(resetsAt: string | null): string {
	if (!resetsAt) return "";
	const d = new Date(resetsAt);
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatResetTime7d(resetsAt: string | null): string {
	if (!resetsAt) return "";
	const d = new Date(resetsAt);
	const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	return `${days[d.getDay()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function renderBar(pct: number, barWidth: number): string {
	const filled = Math.round((pct / 100) * barWidth);
	const empty = barWidth - filled;
	return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function computePaceDiff(bucket: UsageBucket): { diff: number; ahead: boolean } | null {
	if (!bucket.resets_at) return null;
	const resetMs = new Date(bucket.resets_at).getTime();
	const windowStartMs = resetMs - SEVEN_DAYS_MS;
	const elapsed = Date.now() - windowStartMs;
	const expectedPct = Math.min(100, Math.max(0, (elapsed / SEVEN_DAYS_MS) * 100));
	const diff = bucket.utilization - expectedPct;
	return { diff, ahead: diff > 0 };
}

function formatPaceDiff(pace: { diff: number; ahead: boolean }, theme: Theme): string {
	const label = `${Math.abs(pace.diff).toFixed(1)}%`;
	if (pace.ahead) {
		return theme.fg("error", `▲${label}`);
	}
	return theme.fg("success", `▼${label}`);
}

function buildWidgetLine(data: UsageResponse, theme: Theme): string {
	const parts: string[] = [];

	if (data.five_hour) {
		const pct = data.five_hour.utilization;
		const resetTime = formatResetTime5h(data.five_hour.resets_at);
		const bar = renderBar(pct, 10);
		parts.push(theme.fg("dim", `5h: ${bar} ${pct.toFixed(0)}%${resetTime ? ` ~ ${resetTime}` : ""}`));
	}

	if (data.seven_day) {
		const pct = data.seven_day.utilization;
		const resetTime = formatResetTime7d(data.seven_day.resets_at);
		const bar = renderBar(pct, 10);
		const pace = computePaceDiff(data.seven_day);
		const paceStr = pace ? ` ${formatPaceDiff(pace, theme)}` : "";
		parts.push(theme.fg("dim", `7d: ${bar} ${pct.toFixed(0)}%${resetTime ? ` ~ ${resetTime}` : ""}`) + paceStr);
	}

	if (parts.length === 0) return theme.fg("dim", "No usage data");
	return parts.join(theme.fg("dim", "  ·  "));
}

function unixSecondsToIso(timestamp: number | null | undefined): string | null {
	if (!timestamp || !Number.isFinite(timestamp)) return null;
	return new Date(timestamp * 1000).toISOString();
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		return JSON.parse(atob(parts[1])) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function extractCodexAccountId(token: string): string | null {
	const payload = decodeJwtPayload(token);
	const auth = payload?.["https://api.openai.com/auth"];
	if (!auth || typeof auth !== "object") return null;
	const accountId = (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id;
	return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

function normalizeCodexUsage(data: CodexUsageResponse): UsageResponse {
	return {
		five_hour: data.rate_limit?.primary_window
			? {
				utilization: data.rate_limit.primary_window.used_percent,
				resets_at: unixSecondsToIso(data.rate_limit.primary_window.reset_at),
			}
			: null,
		seven_day: data.rate_limit?.secondary_window
			? {
				utilization: data.rate_limit.secondary_window.used_percent,
				resets_at: unixSecondsToIso(data.rate_limit.secondary_window.reset_at),
			}
			: null,
		seven_day_opus: null,
	};
}

async function fetchAnthropicUsage(apiKey: string): Promise<UsageResponse | null> {
	try {
		const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
			method: "GET",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
				"anthropic-beta": "oauth-2025-04-20",
			},
			signal: AbortSignal.timeout(10000),
		});
		if (!response.ok) return null;
		return (await response.json()) as UsageResponse;
	} catch {
		return null;
	}
}

async function fetchCodexUsage(apiKey: string): Promise<UsageResponse | null> {
	try {
		const accountId = extractCodexAccountId(apiKey);
		if (!accountId) return null;
		const userAgent = typeof navigator !== "undefined" ? `pi (${navigator.platform || "unknown"})` : "pi";
		const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
			method: "GET",
			headers: {
				Accept: "*/*",
				Authorization: `Bearer ${apiKey}`,
				"chatgpt-account-id": accountId,
				originator: "pi",
				"User-Agent": userAgent,
			},
			signal: AbortSignal.timeout(10000),
		});
		if (!response.ok) return null;
		return normalizeCodexUsage((await response.json()) as CodexUsageResponse);
	} catch {
		return null;
	}
}

async function fetchUsage(provider: string, apiKey: string): Promise<UsageResponse | null> {
	if (provider === "anthropic") return fetchAnthropicUsage(apiKey);
	if (provider === "openai-codex") return fetchCodexUsage(apiKey);
	return null;
}

function supportsUsageWidget(provider: string | undefined): boolean {
	return provider === "anthropic" || provider === "openai-codex";
}

const WIDGET_ID = "provider-usage";
const MIN_REFRESH_GAP_MS = 3 * 60 * 1000;

export default function (pi: ExtensionAPI) {
	const usageCache = new Map<string, { data: UsageResponse; refreshedAt: number }>();
	let activeProvider: string | null = null;

	function getCachedUsage(provider: string | null): UsageResponse | null {
		if (!provider) return null;
		return usageCache.get(provider)?.data ?? null;
	}

	function showWidget(ctx: ExtensionContext) {
		const data = getCachedUsage(activeProvider);
		if (!data) return;
		ctx.ui.setWidget(
			WIDGET_ID,
			(_tui, theme) => new Text(buildWidgetLine(data, theme), 0, 0),
			{ placement: "belowEditor" },
		);
	}

	function hideWidget(ctx: ExtensionContext) {
		ctx.ui.setWidget(WIDGET_ID, undefined);
	}

	async function refreshUsage(ctx: ExtensionContext, force = false) {
		if (!activeProvider || !supportsUsageWidget(activeProvider)) return;
		const cached = usageCache.get(activeProvider);
		if (!force && cached && Date.now() - cached.refreshedAt < MIN_REFRESH_GAP_MS) return;
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(activeProvider);
		if (!apiKey) return;
		const data = await fetchUsage(activeProvider, apiKey);
		if (data) {
			usageCache.set(activeProvider, { data, refreshedAt: Date.now() });
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		activeProvider = ctx.model?.provider ?? null;
		if (supportsUsageWidget(activeProvider ?? undefined)) {
			await refreshUsage(ctx, true);
			if (getCachedUsage(activeProvider)) showWidget(ctx);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (supportsUsageWidget(activeProvider ?? undefined)) {
			await refreshUsage(ctx);
			if (getCachedUsage(activeProvider)) showWidget(ctx);
		}
	});

	pi.on("model_select", async (event, ctx) => {
		activeProvider = event.model.provider;
		if (supportsUsageWidget(activeProvider)) {
			if (getCachedUsage(activeProvider)) showWidget(ctx);
			await refreshUsage(ctx);
			if (getCachedUsage(activeProvider)) showWidget(ctx);
			else hideWidget(ctx);
		} else {
			hideWidget(ctx);
		}
	});
}
