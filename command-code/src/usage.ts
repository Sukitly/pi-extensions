// Command Code plan-usage client and formatter.
//
// Data source: GET https://api.commandcode.ai/alpha/billing/credits with a
// Bearer API key. This endpoint is undocumented (alpha); the response shape is
// modeled after the independent CommandCode GOAT Usagebar extension
// (https://github.com/berkeduruu/CommandCode-Usagebar) and verified with a real
// GOAT account. Everything shown here is rendered from values the server
// actually returned — the GOAT monthly pool is NOT hard-coded, because the
// server never sends a monthly cap. Missing totals are displayed as unknown.
import {
	CREDITS_URL,
} from "./constants.ts";

// Shape based on the community usagebar extension; alpha endpoint, may drift.
export interface CreditWindowRaw {
	used?: number | string;
	cap?: number | string;
	exceeded?: boolean | null;
	resetAt?: number | string;
}

export interface RawCreditsResponse {
	credits?: {
		belowThreshold?: boolean;
		creditThreshold?: number;
		monthlyCredits?: number;
		purchasedCredits?: number;
		premiumMonthlyCredits?: number;
		openSourceMonthlyCredits?: number;
	};
	windowLimits?: {
		limited?: boolean;
		exceeded?: boolean | null;
		fiveHour?: CreditWindowRaw;
		weekly?: CreditWindowRaw;
	};
	plan?: { id?: string; name?: string };
}

export interface UsageWindow {
	label: string;
	used: number | undefined;
	cap: number | undefined;
	resetAt: number | undefined;
	exceeded: boolean | null;
}

export interface CommandCodeUsage {
	fiveHour: UsageWindow;
	weekly: UsageWindow;
	/** Remaining monthly credits as reported by the server; undefined = unknown. */
	monthlyRemaining: number | undefined;
	monthlyLabel: string;
	/** Minimum spend floor the server promises (usually 0); may be undefined. */
	creditThreshold: number | undefined;
	limited: boolean;
	planName: string | undefined;
	fetchedAt: number;
}

export class CreditsApiError extends Error {
	readonly status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.name = "CreditsApiError";
		this.status = status;
	}
}

function toNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function toTimestamp(value: unknown): number | undefined {
	const n = toNumber(value);
	if (n !== undefined && n > 0) {
		// Some responses send seconds. Heuristic: values below 1e12 are seconds.
		return n < 1e12 ? n * 1000 : n;
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function normalizeWindow(label: string, raw: CreditWindowRaw | undefined): UsageWindow {
	const used = Math.max(0, toNumber(raw?.used) ?? 0);
	const cap = toNumber(raw?.cap);
	return {
		label,
		used: toNumber(raw?.used),
		cap,
		resetAt: toTimestamp(raw?.resetAt),
		exceeded: typeof raw?.exceeded === "boolean" ? raw.exceeded : null,
	};
}

export function parseCredits(payload: unknown, fetchedAt = Date.now()): CommandCodeUsage {
	const raw = (payload ?? {}) as RawCreditsResponse;
	if (typeof raw !== "object" || raw === null) {
		throw new CreditsApiError("Command Code credits endpoint returned an unexpected payload");
	}
	const fiveHour = raw.windowLimits?.fiveHour;
	const weekly = raw.windowLimits?.weekly;
	if (fiveHour === undefined && weekly === undefined && raw.credits === undefined) {
		throw new CreditsApiError("Command Code credits response contained no usage data");
	}
	return {
		fiveHour: normalizeWindow("5h", fiveHour),
		weekly: normalizeWindow("Weekly", weekly),
		monthlyRemaining: toNumber(raw.credits?.monthlyCredits),
		monthlyLabel: "Remaining credits",
		creditThreshold: toNumber(raw.credits?.creditThreshold),
		limited: raw.windowLimits?.limited ?? true,
		planName: raw.plan?.name,
		fetchedAt,
	};
}

export async function fetchCommandCodeUsage(
	apiKey: string,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<CommandCodeUsage> {
	const controller = new AbortController();
	const link = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	const timeout = setTimeout(() => controller.abort(new Error("Command Code usage request timed out")), 10_000);
	try {
		const res = await fetchImpl(CREDITS_URL, {
			headers: {
				Accept: "application/json",
				// Only sent over HTTPS to api.commandcode.ai by construction.
				Authorization: `Bearer ${apiKey}`,
				"User-Agent": "pi-command-code/0.1.0",
			},
			signal: link,
		});
		if (!res.ok) {
			const detail = (await res.text()).slice(0, 200);
			throw new CreditsApiError(`Command Code usage request failed (HTTP ${res.status}): ${detail}`, res.status);
		}
		let payload: unknown;
		try {
			payload = await res.json();
		} catch {
			throw new CreditsApiError(`Command Code usage endpoint returned invalid JSON (HTTP ${res.status})`, res.status);
		}
		return parseCredits(payload);
	} catch (error) {
		if (error instanceof CreditsApiError) throw error;
		if (error instanceof Error && error.name === "AbortError") {
			const reason = error.reason instanceof Error ? error.reason.message : "aborted";
			throw new CreditsApiError(`Command Code usage request failed: ${reason}`);
		}
		throw error instanceof Error
			? new CreditsApiError(`Command Code usage request failed: ${error.message}`)
			: error;
	} finally {
		clearTimeout(timeout);
	}
}

export function formatReset(resetAt: number | undefined, now = Date.now()): string {
	if (resetAt === undefined) return "unknown";
	const deltaMs = resetAt - now;
	if (deltaMs <= 0) return "now";
	const totalMin = Math.round(deltaMs / 60_000);
	if (totalMin >= 60 * 24) return `${Math.floor(totalMin / (60 * 24))}d ${Math.floor((totalMin % (60 * 24)) / 60)}h`;
	if (totalMin >= 60) return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
	return `${Math.max(0, totalMin)}m`;
}

function formatCredits(value: number | undefined): string {
	if (value === undefined) return "?";
	return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function bar(used: number | undefined, cap: number | undefined, width = 20): string {
	if (cap === undefined || cap <= 0 || used === undefined) return `[${"?".repeat(width)}]`;
	const filled = Math.max(0, Math.min(width, Math.round((Math.max(0, used) / cap) * width)));
	return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function windowPercent(used: number | undefined, cap: number | undefined): string {
	if (cap === undefined || cap <= 0 || used === undefined) return "?%";
	return `${Math.max(0, Math.min(100, Math.round((used / cap) * 100)))}%`;
}

/** Full multi-line summary for /command-code.usage. Never invents a monthly cap. */
export function formatUsageSummary(
	usage: CommandCodeUsage,
	opts: { stale?: string; now?: number } = {},
): string {
	const lines: string[] = [];
	const now = opts.now ?? Date.now();
	
	lines.push(`Command Code usage${usage.planName ? ` — plan: ${usage.planName}` : ""}`);
	lines.push(
		`  ${bar(usage.fiveHour.used, usage.fiveHour.cap)} 5-hour window: ${formatCredits(usage.fiveHour.used)}${usage.fiveHour.cap !== undefined ? ` of ${formatCredits(usage.fiveHour.cap)}` : ""} credits used (${windowPercent(usage.fiveHour.used, usage.fiveHour.cap)}) · resets ${formatReset(usage.fiveHour.resetAt, now)}`,
	);
	lines.push(
		`  ${bar(usage.weekly.used, usage.weekly.cap)} Weekly window: ${formatCredits(usage.weekly.used)}${usage.weekly.cap !== undefined ? ` of ${formatCredits(usage.weekly.cap)}` : ""} credits used (${windowPercent(usage.weekly.used, usage.weekly.cap)}) · resets ${formatReset(usage.weekly.resetAt, now)}`,
	);
	if (usage.monthlyRemaining !== undefined) {
		lines.push(
			`  Monthly: ${formatCredits(usage.monthlyRemaining)} credits remaining (server-reported; total pool not exposed by the API${usage.monthlyRemaining < (usage.creditThreshold ?? Infinity) ? ` · threshold ${formatCredits(usage.creditThreshold)}` : ""})`,
		);
	} else {
		lines.push("  Monthly: remaining credits not reported by the server; total pool unavailable");
	}
	if (opts.stale) lines.push(`  Note: ${opts.stale}`);
	return lines.join("\n");
}

/** Single-line footer widget text. */
export function formatUsageLine(usage: CommandCodeUsage, now = Date.now()): string {
	const fiveHour = `${windowPercent(usage.fiveHour.used, usage.fiveHour.cap)} / ${formatReset(usage.fiveHour.resetAt, now)}`;
	const weekly = `${windowPercent(usage.weekly.used, usage.weekly.cap)}${usage.weekly.cap === undefined && usage.weekly.used !== undefined ? ` used ${formatCredits(usage.weekly.used)}cr` : ""}`;
	const monthly = usage.monthlyRemaining !== undefined ? `${formatCredits(usage.monthlyRemaining)}cr left` : undefined;
	const segments = [`CC 5h ${fiveHour}`, `wk ${weekly}`];
	if (monthly) segments.push(`mo ${monthly}`);
	return segments.join(" · ");
}
