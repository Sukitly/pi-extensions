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
	groups?: Record<string, UsageWindow[]>;
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

interface AntigravityBucket {
	bucketId?: string;
	displayName?: string;
	window?: string;
	resetTime?: string;
	description?: string;
	remainingFraction?: number;
}

interface AntigravityGroup {
	displayName?: string;
	description?: string;
	buckets?: AntigravityBucket[];
}

interface AntigravityQuotaResponse {
	groups?: AntigravityGroup[];
	description?: string;
}

interface OpenCodeGoWindow {
	status?: string;
	percent: number;
	resetsAt?: string | null;
}

interface OpenCodeGoUsageResponse {
	usage?: {
		rolling?: OpenCodeGoWindow | null;
		weekly?: OpenCodeGoWindow | null;
		monthly?: OpenCodeGoWindow | null;
	};
}

function pad2(n: number): string {
	return n.toString().padStart(2, "0");
}

const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const FIVE_HOURS_SECONDS = 5 * HOUR_SECONDS;
const SEVEN_DAYS_SECONDS = 7 * DAY_SECONDS;
const THIRTY_DAYS_SECONDS = 30 * DAY_SECONDS;

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
	if (windowSeconds >= SEVEN_DAYS_SECONDS * 2) {
		return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${time}`;
	}
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
	return data.windows.map((window) => renderUsageWindow(window, theme)).join(theme.fg("dim", " • "));
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

function extractAntigravityToken(apiKey: string): string {
	try {
		const parsed = JSON.parse(apiKey) as { token?: unknown };
		if (typeof parsed?.token === "string" && parsed.token.length > 0) {
			return parsed.token;
		}
	} catch {
		// Not JSON, treat as raw token.
	}
	return apiKey;
}

function normalizeAntigravityUsage(data: AntigravityQuotaResponse): UsageResponse {
	const groupsRecord: Record<string, UsageWindow[]> = {};
	const allWindows: UsageWindow[] = [];

	for (const group of data.groups ?? []) {
		const groupName = group.displayName ?? "";
		const is3P = /claude|gpt|3p/i.test(groupName);
		const groupKey = is3P ? "claude-gpt" : "gemini";
		const groupWindows: UsageWindow[] = [];

		for (const bucket of group.buckets ?? []) {
			if (typeof bucket.remainingFraction !== "number" || !Number.isFinite(bucket.remainingFraction)) {
				continue;
			}
			const clampedRemaining = Math.max(0, Math.min(1, bucket.remainingFraction));
			const utilization = Math.max(0, Math.min(100, (1 - clampedRemaining) * 100));
			const bucketId = (bucket.bucketId ?? "").toLowerCase();
			const windowType = (bucket.window ?? "").toLowerCase();

			let windowSeconds = FIVE_HOURS_SECONDS;
			let label = "5h";

			if (windowType === "weekly" || bucketId.includes("weekly") || bucketId.includes("7d")) {
				windowSeconds = SEVEN_DAYS_SECONDS;
				label = "7d";
			} else if (windowType === "5h" || bucketId.includes("5h")) {
				windowSeconds = FIVE_HOURS_SECONDS;
				label = "5h";
			} else if (bucket.window) {
				label = bucket.window;
			}

			groupWindows.push({
				label,
				utilization,
				resetsAt: bucket.resetTime ?? null,
				windowSeconds,
			});
		}

		groupWindows.sort((a, b) => a.windowSeconds - b.windowSeconds);
		groupsRecord[groupKey] = groupWindows;
		allWindows.push(...groupWindows);
	}

	const defaultWindows = groupsRecord["gemini"] ?? groupsRecord["claude-gpt"] ?? allWindows;
	return {
		windows: defaultWindows,
		groups: groupsRecord,
	};
}

function normalizeOpenCodeGoUsage(data: OpenCodeGoUsageResponse): UsageResponse {
	const windows: UsageWindow[] = [];
	const usage = data?.usage;
	if (!usage) return { windows };

	if (usage.rolling && typeof usage.rolling.percent === "number" && Number.isFinite(usage.rolling.percent)) {
		windows.push({
			label: "5h",
			utilization: usage.rolling.percent,
			resetsAt: usage.rolling.resetsAt ?? null,
			windowSeconds: FIVE_HOURS_SECONDS,
		});
	}
	if (usage.weekly && typeof usage.weekly.percent === "number" && Number.isFinite(usage.weekly.percent)) {
		windows.push({
			label: "7d",
			utilization: usage.weekly.percent,
			resetsAt: usage.weekly.resetsAt ?? null,
			windowSeconds: SEVEN_DAYS_SECONDS,
		});
	}
	if (usage.monthly && typeof usage.monthly.percent === "number" && Number.isFinite(usage.monthly.percent)) {
		windows.push({
			label: "30d",
			utilization: usage.monthly.percent,
			resetsAt: usage.monthly.resetsAt ?? null,
			windowSeconds: THIRTY_DAYS_SECONDS,
		});
	}

	return { windows };
}

function resolveUsageForModel(data: UsageResponse | null, modelId?: string): UsageResponse | null {
	if (!data) return null;
	if (!data.groups) return data;
	const is3P = modelId ? /claude|gpt|3p/i.test(modelId) : false;
	const groupKey = is3P ? "claude-gpt" : "gemini";
	const selectedWindows = data.groups[groupKey] ?? data.windows;
	return { windows: selectedWindows, groups: data.groups };
}

function formatUsageError(error: unknown, apiKey?: string): string {
	let message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	if (error instanceof Error && error.cause instanceof Error) {
		message += ` (${error.cause.message})`;
	}
	if (apiKey) {
		message = message.split(apiKey).join("[redacted]");
		const token = extractAntigravityToken(apiKey);
		if (token && token !== apiKey) {
			message = message.split(token).join("[redacted]");
		}
	}
	message = message
		.replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [redacted]")
		.replace(/sk-[\w-]+/g, "[redacted]")
		.replace(/oc_sk_[\w-]+/g, "[redacted]")
		.replace(/ya29\.[a-zA-Z0-9_-]+/g, "[redacted]")
		.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

async function requireUsageResponse(response: Response): Promise<unknown> {
	if (!response.ok) {
		let detail = "";
		try {
			detail = await response.text();
			try {
				const body = JSON.parse(detail);
				const message = body?.error?.message ?? body?.message ?? body?.error;
				if (typeof message === "string") detail = message;
			} catch { /* Non-JSON error responses are useful too. */ }
		} catch { /* Keep the HTTP status even if reading the body fails. */ }
		throw new Error(`HTTP ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`);
	}
	try {
		return await response.json();
	} catch (error) {
		throw new Error("Invalid usage JSON response", { cause: error });
	}
}

async function fetchAnthropicUsage(apiKey: string): Promise<UsageResponse> {
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
	return normalizeAnthropicUsage((await requireUsageResponse(response)) as AnthropicUsageResponse);
}

async function fetchCodexUsage(apiKey: string): Promise<UsageResponse> {
	const accountId = extractCodexAccountId(apiKey);
	if (!accountId) throw new Error("Missing ChatGPT account ID in Codex credentials; please log in again");
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
	return normalizeCodexUsage((await requireUsageResponse(response)) as CodexUsageResponse);
}

const ANTIGRAVITY_ENDPOINT_FALLBACKS = [
	"https://daily-cloudcode-pa.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
];

async function fetchAntigravityUsage(apiKey: string): Promise<UsageResponse> {
	const token = extractAntigravityToken(apiKey);
	if (!token) throw new Error("Missing Antigravity access token; please log in again");

	let lastError: unknown;
	for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
		try {
			const response = await fetch(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
					"User-Agent": "antigravity/cli/1.2.4 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)",
				},
				body: "{}",
				signal: AbortSignal.timeout(10000),
			});
			const data = (await requireUsageResponse(response)) as AntigravityQuotaResponse;
			return normalizeAntigravityUsage(data);
		} catch (error) {
			lastError = error;
			if (error instanceof Error && error.message.includes("403")) {
				throw error;
			}
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

const OPENCODE_GO_ENDPOINT_FALLBACKS = [
	"https://opencode.ai/zen/go/v1/usage",
	"https://opencode.ai/inference/go/v1/usage",
];

async function fetchOpenCodeGoUsage(apiKey: string): Promise<UsageResponse> {
	if (!apiKey) throw new Error("Missing OpenCode Go API key; please configure credentials");

	let lastError: unknown;
	for (const endpoint of OPENCODE_GO_ENDPOINT_FALLBACKS) {
		try {
			const response = await fetch(endpoint, {
				method: "GET",
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				signal: AbortSignal.timeout(10000),
			});
			const data = (await requireUsageResponse(response)) as OpenCodeGoUsageResponse;
			return normalizeOpenCodeGoUsage(data);
		} catch (error) {
			lastError = error;
			if (error instanceof Error && (error.message.includes("401") || error.message.includes("403"))) {
				throw error;
			}
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchUsage(provider: string, apiKey: string): Promise<UsageResponse | null> {
	if (provider === "anthropic") return fetchAnthropicUsage(apiKey);
	if (provider === "openai-codex") return fetchCodexUsage(apiKey);
	if (provider === "antigravity") return fetchAntigravityUsage(apiKey);
	if (provider === "opencode-go") return fetchOpenCodeGoUsage(apiKey);
	return null;
}

function supportsUsageWidget(
	provider: string | null | undefined,
): provider is "anthropic" | "openai-codex" | "antigravity" | "opencode-go" {
	return (
		provider === "anthropic" ||
		provider === "openai-codex" ||
		provider === "antigravity" ||
		provider === "opencode-go"
	);
}

const WIDGET_ID = "provider-usage";
const MIN_REFRESH_GAP_MS = 3 * 60 * 1000;
// Direct ChatGPT OAuth has no supported quota API; WHAM only accepts legacy Codex credentials.
// https://github.com/openai/sign-in-with-chatgpt-devkit/issues/3#issuecomment-5936080960
const OPENAI_SUBSCRIPTION_USAGE_NOTICE =
	"OpenAI subscription: quota query unavailable — https://chatgpt.com/settings/usage";

export default function (pi: ExtensionAPI) {
	const usageCache = new Map<string, { data: UsageResponse; refreshedAt: number }>();
	const usageRefreshes = new Map<string, Promise<void>>();
	const usageErrors = new Map<string, string>();
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

	function showWidget(ctx: ExtensionContext, provider: string | null, modelId?: string) {
		if (provider === "openai") {
			ignoreStaleContext(() => {
				const model = ctx.model;
				const isSubscription = model?.provider === "openai" && ctx.modelRegistry.isUsingOAuth(model);
				ctx.ui.setWidget(
					WIDGET_ID,
					isSubscription
						? (_tui, theme) => new Text(theme.fg("dim", OPENAI_SUBSCRIPTION_USAGE_NOTICE), 0, 0)
						: undefined,
					{ placement: "belowEditor" },
				);
			});
			return;
		}
		const rawData = getCachedUsage(provider);
		const data = resolveUsageForModel(rawData, modelId ?? ctx.model?.id);
		const error = provider ? usageErrors.get(provider) : undefined;
		if (!data && !error) {
			hideWidget(ctx);
			return;
		}
		ignoreStaleContext(() => {
			ctx.ui.setWidget(
				WIDGET_ID,
				(_tui, theme) => new Text([
					data ? buildWidgetLine(data, theme) : "",
					error ? theme.fg("error", `${provider} usage: ${data ? "refresh failed (stale data)" : "refresh failed"} — ${error}`) : "",
				].filter(Boolean).join("\n"), 0, 0),
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
		if (!force && !usageErrors.has(provider) && cached && Date.now() - cached.refreshedAt < MIN_REFRESH_GAP_MS) return;
		const existingRefresh = usageRefreshes.get(provider);
		if (existingRefresh) {
			await existingRefresh;
			return;
		}

		// Capture the registry before detaching: reading ctx after a reload can throw.
		const modelRegistry = ctx.modelRegistry;
		const refresh = (async () => {
			let apiKey: string | undefined;
			try {
				apiKey = await modelRegistry.getApiKeyForProvider(provider);
				if (!apiKey) throw new Error("No API credentials available; please log in");
				const data = await fetchUsage(provider, apiKey);
				if (data) {
					usageCache.set(provider, { data, refreshedAt: Date.now() });
					usageErrors.delete(provider);
				}
			} catch (error) {
				usageErrors.set(provider, formatUsageError(error, apiKey));
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
				showWidget(ctx, provider);
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

		showWidget(ctx, provider);
		if (supportsUsageWidget(provider)) {
			refreshInBackground(ctx, provider, token, true);
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const provider = activeProvider;
		const token = lifecycleToken;

		if (provider === "openai") {
			showWidget(ctx, provider);
		} else if (supportsUsageWidget(provider)) {
			refreshInBackground(ctx, provider, token);
		}
	});

	pi.on("model_select", (event, ctx) => {
		if (!ctx.hasUI) return;
		const provider = event.model.provider;
		const token = lifecycleToken;
		activeProvider = provider;

		showWidget(ctx, provider, event.model.id);
		if (supportsUsageWidget(provider)) {
			refreshInBackground(ctx, provider, token);
		}
	});
}
