import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

interface UsageWindow {
	label: string;
	utilization: number;
	resetsAt: string | null;
	windowSeconds: number;
}

interface UsageResponse {
	windows: UsageWindow[];
}

interface AnthropicUsageBucket {
	utilization: number;
	resets_at: string | null;
}

interface AnthropicUsageResponse {
	five_hour: AnthropicUsageBucket | null;
	seven_day: AnthropicUsageBucket | null;
	seven_day_opus: AnthropicUsageBucket | null;
}

interface CodexWindow {
	used_percent: number;
	reset_at: number;
	limit_window_seconds?: number;
}

interface CodexRateLimit {
	primary_window?: CodexWindow | null;
	secondary_window?: CodexWindow | null;
}

interface CodexUsageResponse {
	rate_limit?: CodexRateLimit | null;
}

function pad2(n: number): string {
	return n.toString().padStart(2, "0");
}

const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const FIVE_HOURS_SECONDS = 5 * HOUR_SECONDS;
const SEVEN_DAYS_SECONDS = 7 * DAY_SECONDS;

function formatWindowDuration(seconds: number): string {
	if (seconds >= DAY_SECONDS && seconds % DAY_SECONDS === 0) return `${seconds / DAY_SECONDS}d`;
	if (seconds >= HOUR_SECONDS && seconds % HOUR_SECONDS === 0) return `${seconds / HOUR_SECONDS}h`;
	if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

function formatResetTime(resetsAt: string | null, windowSeconds: number): string {
	if (!resetsAt) return "";
	const d = new Date(resetsAt);
	if (!Number.isFinite(d.getTime())) return "";
	const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
	if (windowSeconds < DAY_SECONDS) return time;
	const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	return `${days[d.getDay()]} ${time}`;
}

function renderBar(pct: number, barWidth: number): string {
	const filled = Math.round((pct / 100) * barWidth);
	const empty = barWidth - filled;
	return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}

function computePaceDiff(window: UsageWindow): { diff: number; ahead: boolean } | null {
	if (!window.resetsAt) return null;
	const resetMs = new Date(window.resetsAt).getTime();
	if (!Number.isFinite(resetMs)) return null;
	const windowMs = window.windowSeconds * 1000;
	const windowStartMs = resetMs - windowMs;
	const elapsed = Date.now() - windowStartMs;
	const expectedPct = Math.min(100, Math.max(0, (elapsed / windowMs) * 100));
	const diff = window.utilization - expectedPct;
	return { diff, ahead: diff > 0 };
}

function formatPaceDiff(pace: { diff: number; ahead: boolean }, theme: Theme): string {
	const label = `${Math.abs(pace.diff).toFixed(1)}%`;
	if (pace.ahead) {
		return theme.fg("error", `▲${label}`);
	}
	return theme.fg("success", `▼${label}`);
}

function renderUsageWindow(window: UsageWindow, theme: Theme): string {
	const resetTime = formatResetTime(window.resetsAt, window.windowSeconds);
	const bar = renderBar(window.utilization, 10);
	const pace = window.windowSeconds >= DAY_SECONDS ? computePaceDiff(window) : null;
	const paceStr = pace ? ` ${formatPaceDiff(pace, theme)}` : "";
	return (
		theme.fg(
			"dim",
			`${window.label}: ${bar} ${window.utilization.toFixed(0)}%${resetTime ? ` ~ ${resetTime}` : ""}`,
		) + paceStr
	);
}

function buildWidgetLine(data: UsageResponse, theme: Theme): string {
	if (data.windows.length === 0) return theme.fg("dim", "No usage data");
	return data.windows.map((window) => renderUsageWindow(window, theme)).join(theme.fg("dim", "  ·  "));
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

function normalizeAnthropicUsage(data: AnthropicUsageResponse): UsageResponse {
	const windows: UsageWindow[] = [];
	if (data.five_hour) {
		windows.push({
			label: "5h",
			utilization: data.five_hour.utilization,
			resetsAt: data.five_hour.resets_at,
			windowSeconds: FIVE_HOURS_SECONDS,
		});
	}
	if (data.seven_day) {
		windows.push({
			label: "7d",
			utilization: data.seven_day.utilization,
			resetsAt: data.seven_day.resets_at,
			windowSeconds: SEVEN_DAYS_SECONDS,
		});
	}
	return { windows };
}

function normalizeCodexWindow(
	window: CodexWindow | null | undefined,
	fallbackWindowSeconds: number,
): UsageWindow | null {
	if (!window || !Number.isFinite(window.used_percent)) return null;
	const windowSeconds =
		typeof window.limit_window_seconds === "number" &&
		Number.isFinite(window.limit_window_seconds) &&
		window.limit_window_seconds > 0
			? window.limit_window_seconds
			: fallbackWindowSeconds;
	const durationLabel = formatWindowDuration(windowSeconds);
	return {
		label: durationLabel,
		utilization: window.used_percent,
		resetsAt: unixSecondsToIso(window.reset_at),
		windowSeconds,
	};
}

function appendCodexRateLimit(windows: UsageWindow[], rateLimit: CodexRateLimit | null | undefined) {
	if (!rateLimit) return;
	const primary = normalizeCodexWindow(rateLimit.primary_window, FIVE_HOURS_SECONDS);
	const secondary = normalizeCodexWindow(rateLimit.secondary_window, SEVEN_DAYS_SECONDS);
	if (primary) windows.push(primary);
	if (secondary) windows.push(secondary);
}

function normalizeCodexUsage(data: CodexUsageResponse): UsageResponse {
	const windows: UsageWindow[] = [];
	appendCodexRateLimit(windows, data.rate_limit);
	return { windows };
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
		return normalizeAnthropicUsage((await response.json()) as AnthropicUsageResponse);
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

function supportsUsageWidget(provider: string | null | undefined): provider is "anthropic" | "openai-codex" {
	return provider === "anthropic" || provider === "openai-codex";
}

const WIDGET_ID = "provider-usage";
const MIN_REFRESH_GAP_MS = 3 * 60 * 1000;

export default function (pi: ExtensionAPI) {
	const usageCache = new Map<string, { data: UsageResponse; refreshedAt: number }>();
	const usageRefreshes = new Map<string, Promise<void>>();
	let activeProvider: string | null = null;
	let lifecycleToken = 0;

	function getCachedUsage(provider: string | null): UsageResponse | null {
		if (!provider) return null;
		return usageCache.get(provider)?.data ?? null;
	}

	function isCurrent(token: number, provider: string | null): boolean {
		return token === lifecycleToken && provider === activeProvider;
	}

	function isStaleContextError(error: unknown): boolean {
		return error instanceof Error && error.message.includes("ctx is stale");
	}

	function ignoreStaleContext(fn: () => void) {
		try {
			fn();
		} catch (error) {
			if (!isStaleContextError(error)) throw error;
		}
	}

	function showWidget(ctx: ExtensionContext, provider: string | null) {
		const data = getCachedUsage(provider);
		if (!data) return;
		ignoreStaleContext(() => {
			ctx.ui.setWidget(
				WIDGET_ID,
				(_tui, theme) => new Text(buildWidgetLine(data, theme), 0, 0),
				{ placement: "belowEditor" },
			);
		});
	}

	function hideWidget(ctx: ExtensionContext) {
		ignoreStaleContext(() => {
			ctx.ui.setWidget(WIDGET_ID, undefined);
		});
	}

	async function refreshUsage(ctx: ExtensionContext, provider: string | null, force = false) {
		if (!provider || !supportsUsageWidget(provider)) return;
		const cached = usageCache.get(provider);
		if (!force && cached && Date.now() - cached.refreshedAt < MIN_REFRESH_GAP_MS) return;
		const existingRefresh = usageRefreshes.get(provider);
		if (existingRefresh) {
			await existingRefresh;
			return;
		}

		// Capture the registry before detaching: reading ctx after a reload can throw.
		const modelRegistry = ctx.modelRegistry;
		const refresh = (async () => {
			const apiKey = await modelRegistry.getApiKeyForProvider(provider);
			if (!apiKey) return;
			const data = await fetchUsage(provider, apiKey);
			if (data) {
				usageCache.set(provider, { data, refreshedAt: Date.now() });
			}
		})();
		usageRefreshes.set(provider, refresh);
		try {
			await refresh;
		} finally {
			if (usageRefreshes.get(provider) === refresh) usageRefreshes.delete(provider);
		}
	}

	function refreshInBackground(
		ctx: ExtensionContext,
		provider: string,
		token: number,
		force = false,
	) {
		void refreshUsage(ctx, provider, force)
			.then(() => {
				if (!isCurrent(token, provider)) return;
				if (getCachedUsage(provider)) showWidget(ctx, provider);
				else hideWidget(ctx);
			})
			.catch(() => {
				// Usage is best-effort; detached refreshes must not reject lifecycle work.
			});
	}

	pi.on("session_shutdown", () => {
		lifecycleToken++;
		activeProvider = null;
	});

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const provider = ctx.model?.provider ?? null;
		const token = lifecycleToken;
		activeProvider = provider;

		if (supportsUsageWidget(provider)) {
			if (getCachedUsage(provider)) showWidget(ctx, provider);
			else hideWidget(ctx);
			refreshInBackground(ctx, provider, token, true);
		} else {
			hideWidget(ctx);
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const provider = activeProvider;
		const token = lifecycleToken;

		if (supportsUsageWidget(provider)) {
			refreshInBackground(ctx, provider, token);
		}
	});

	pi.on("model_select", (event, ctx) => {
		if (!ctx.hasUI) return;
		const provider = event.model.provider;
		const token = lifecycleToken;
		activeProvider = provider;

		if (supportsUsageWidget(provider)) {
			if (getCachedUsage(provider)) showWidget(ctx, provider);
			else hideWidget(ctx);
			refreshInBackground(ctx, provider, token);
		} else {
			hideWidget(ctx);
		}
	});
}
