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

async function fetchUsage(apiKey: string): Promise<UsageResponse | null> {
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

const WIDGET_ID = "anthropic-usage";
const MIN_REFRESH_GAP_MS = 3 * 60 * 1000;
const CLAUDE_PROVIDERS = ["anthropic", "claude-bridge"];

function isClaudeProvider(provider: string): boolean {
	return CLAUDE_PROVIDERS.includes(provider);
}

export default function (pi: ExtensionAPI) {
	let lastData: UsageResponse | null = null;
	let isAnthropicModel = false;
	let lastRefreshTime = 0;

	function showWidget(ctx: ExtensionContext) {
		if (!lastData) return;
		ctx.ui.setWidget(
			WIDGET_ID,
			(_tui, theme) => new Text(buildWidgetLine(lastData!, theme), 0, 0),
			{ placement: "belowEditor" },
		);
	}

	function hideWidget(ctx: ExtensionContext) {
		ctx.ui.setWidget(WIDGET_ID, undefined);
	}

	async function refreshUsage(ctx: ExtensionContext, force = false) {
		if (!force && Date.now() - lastRefreshTime < MIN_REFRESH_GAP_MS) return;
		let apiKey = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
		if (!apiKey) apiKey = await ctx.modelRegistry.getApiKeyForProvider("claude-bridge");
		if (!apiKey) return;
		const data = await fetchUsage(apiKey);
		if (data) {
			lastData = data;
			lastRefreshTime = Date.now();
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		isAnthropicModel = ctx.model ? isClaudeProvider(ctx.model.provider) : true;
		await refreshUsage(ctx, true);
		if (isAnthropicModel && lastData) showWidget(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (isAnthropicModel) {
			await refreshUsage(ctx);
			showWidget(ctx);
		}
	});

	pi.on("model_select", async (event, ctx) => {
		isAnthropicModel = isClaudeProvider(event.model.provider);
		if (isAnthropicModel) {
			if (lastData) showWidget(ctx);
			else await refreshUsage(ctx, true);
		} else {
			hideWidget(ctx);
		}
	});
}
