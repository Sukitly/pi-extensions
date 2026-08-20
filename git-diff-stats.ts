/**
 * Git Diff Stats - shows +added / -deleted line counts right after the branch
 * name on the footer's cwd line:
 *
 *   ~/.pi/agent/extensions (main) +42 -7
 *
 * The cwd line belongs to pi's built-in footer, and `setFooter` replaces the
 * footer wholesale. Rather than reimplementing it, this extension instantiates
 * the built-in `FooterComponent` against a small adapter over `ExtensionContext`
 * and only rewrites line 0 of its output, so the stats/model line keeps upstream
 * behaviour.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { FooterComponent } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface DiffStats {
	added: number;
	deleted: number;
}

const EXEC_TIMEOUT_MS = 5000;
const REFRESH_THROTTLE_MS = 1500;
const MAX_UNTRACKED_FILES = 200;
const MAX_UNTRACKED_BYTES = 512 * 1024;
const MUTATING_TOOLS = new Set(["bash", "edit", "write", "multi_edit", "apply_patch"]);

/** Count untracked files as additions so new files are not invisible. */
const INCLUDE_UNTRACKED = true;

function countLines(path: string): number {
	try {
		if (statSync(path).size > MAX_UNTRACKED_BYTES) return 0;
		const buf = readFileSync(path);
		if (buf.length === 0) return 0;
		if (buf.includes(0)) return 0; // binary
		let lines = 0;
		for (const byte of buf) if (byte === 0x0a) lines++;
		return buf[buf.length - 1] === 0x0a ? lines : lines + 1;
	} catch {
		return 0;
	}
}

async function readTrackedStats(pi: ExtensionAPI, cwd: string): Promise<DiffStats | null> {
	// `HEAD` covers staged + unstaged; falls back to the index on a repo with no commits.
	for (const args of [
		["diff", "--numstat", "HEAD", "--"],
		["diff", "--numstat", "--cached", "--"],
	]) {
		const result = await pi.exec("git", args, { cwd, timeout: EXEC_TIMEOUT_MS });
		if (result.code !== 0) continue;
		const stats: DiffStats = { added: 0, deleted: 0 };
		for (const line of result.stdout.split("\n")) {
			const [added, deleted] = line.split("\t");
			if (added === undefined || deleted === undefined) continue;
			// Binary files report "-".
			if (added !== "-") stats.added += Number.parseInt(added, 10) || 0;
			if (deleted !== "-") stats.deleted += Number.parseInt(deleted, 10) || 0;
		}
		return stats;
	}
	return null;
}

async function addUntrackedStats(pi: ExtensionAPI, cwd: string, stats: DiffStats): Promise<void> {
	const result = await pi.exec("git", ["ls-files", "--others", "--exclude-standard"], {
		cwd,
		timeout: EXEC_TIMEOUT_MS,
	});
	if (result.code !== 0) return;
	const files = result.stdout.split("\n").filter(Boolean).slice(0, MAX_UNTRACKED_FILES);
	for (const file of files) stats.added += countLines(join(cwd, file));
}

async function readDiffStats(pi: ExtensionAPI, cwd: string): Promise<DiffStats | null> {
	try {
		const stats = await readTrackedStats(pi, cwd);
		if (!stats) return null;
		if (INCLUDE_UNTRACKED) await addUntrackedStats(pi, cwd, stats);
		return stats.added === 0 && stats.deleted === 0 ? null : stats;
	} catch {
		return null;
	}
}

function renderStats(stats: DiffStats, theme: Theme): string {
	const parts: string[] = [];
	if (stats.added > 0) parts.push(theme.fg("success", `+${stats.added}`));
	if (stats.deleted > 0) parts.push(theme.fg("error", `-${stats.deleted}`));
	return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

/**
 * Minimal `AgentSession` surface consumed by the built-in `FooterComponent`:
 * `state.model`, `state.thinkingLevel`, `sessionManager`, `getContextUsage()`,
 * and `modelRuntime.isUsingSubscription()`.
 */
function asFooterSession(ctx: ExtensionContext): AgentSession {
	return {
		get state() {
			return { model: ctx.model, thinkingLevel: ctx.thinkingLevel };
		},
		get sessionManager() {
			return ctx.sessionManager;
		},
		getContextUsage: () => ctx.getContextUsage(),
		modelRuntime: {
			// Mirrors ModelRuntime.isUsingSubscription, which is not on ExtensionContext.
			isUsingSubscription: (providerId: string): boolean => {
				const model = ctx.model;
				if (!model || model.provider !== providerId) return false;
				return (
					ctx.modelRegistry.isUsingOAuth(model) &&
					ctx.modelRegistry.getProvider(providerId)?.auth?.oauth?.isSubscription === true
				);
			},
		},
	} as unknown as AgentSession;
}

export default function (pi: ExtensionAPI) {
	let stats: DiffStats | null = null;
	let tui: TUI | null = null;
	let lastRefreshAt = 0;
	let refreshing = false;

	async function refresh(ctx: ExtensionContext, force = false) {
		if (refreshing) return;
		if (!force && Date.now() - lastRefreshAt < REFRESH_THROTTLE_MS) return;
		refreshing = true;
		try {
			const next = await readDiffStats(pi, ctx.cwd);
			lastRefreshAt = Date.now();
			const changed = next?.added !== stats?.added || next?.deleted !== stats?.deleted;
			stats = next;
			if (changed) tui?.requestRender();
		} finally {
			refreshing = false;
		}
	}

	function installFooter(ctx: ExtensionContext) {
		ctx.ui.setFooter((instanceTui, theme, footerData) => {
			// pi's setExtensionFooter disposes the previous footer before invoking this
			// factory, so the assignment below always wins over the old instance's cleanup.
			tui = instanceTui;
			const base = new FooterComponent(asFooterSession(ctx), footerData);
			const unsubscribe = footerData.onBranchChange(() => {
				void refresh(ctx, true);
			});

			return {
				dispose() {
					unsubscribe();
					base.dispose();
					tui = null;
				},
				invalidate() {
					base.invalidate();
				},
				render(width: number): string[] {
					const lines = base.render(width);
					if (!stats || lines.length === 0) return lines;
					const suffix = renderStats(stats, theme);
					const budget = width - visibleWidth(suffix);
					if (!suffix || budget <= 0) return lines;
					lines[0] = truncateToWidth(lines[0], budget, theme.fg("dim", "...")) + suffix;
					return lines;
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		installFooter(ctx);
		await refresh(ctx, true);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		await refresh(ctx, true);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (!MUTATING_TOOLS.has(event.toolName)) return;
		await refresh(ctx);
	});
}
