/**
 * Git Diff Stats - shows +added / -deleted line counts right after the branch
 * name on the footer's cwd line:
 *
 *   ~/.pi/agent/extensions (feature-x) +42 -7
 *
 * The counts always mean the same thing: everything you have that the integration
 * branch does not. That is branch commits plus staged, unstaged, and untracked work,
 * measured from the merge base, so the number keeps growing as you commit and stays
 * a live estimate of the eventual PR size.
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
	/** Some of the counted work is not committed yet. */
	dirty: boolean;
}

/**
 * Marks an unclean working tree. Deliberately a state flag rather than a second
 * pair of numbers: "how big is my PR" is an occasional deliberate lookup that
 * needs a figure, while "is anything uncommitted" is an ambient yes/no. Four
 * digits in a footer become something you parse instead of absorb.
 *
 * A plain ASCII asterisk, settled on after living with the dot variants for a few
 * days. The round glyphs were picked by reasoning about vertical metrics — U+25CF sits
 * below the optical centre of lowercase text, U+2022 aligns but is too faint when
 * dimmed, U+2981 rides the same axis as the `+` and `-` beside it — but sustained use
 * beat that analysis: a filled dot reads as a bullet or a status LED and keeps drawing
 * the eye, while `*` is already the dirty-tree mark in shell prompts and stays quiet.
 *
 * ASCII also removes the font risk the Unicode candidates carried. It cannot render as
 * a replacement box, and it is unambiguously single width in every terminal rather
 * than relying on pi-tui and the terminal agreeing about an East Asian Ambiguous glyph.
 */
const DIRTY_MARKER = "*";

const EXEC_TIMEOUT_MS = 5000;
const REFRESH_THROTTLE_MS = 1500;
const MAX_UNTRACKED_FILES = 200;
const MAX_UNTRACKED_BYTES = 512 * 1024;
const MUTATING_TOOLS = new Set(["bash", "edit", "write", "multi_edit", "apply_patch"]);

/** Count untracked files as additions so new files are not invisible. */
const INCLUDE_UNTRACKED = true;

/** Probed in order when `origin/HEAD` is not configured locally. */
const BASE_REF_CANDIDATES = ["origin/main", "origin/master", "main", "master"];

async function git(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string | null> {
	const result = await pi.exec("git", args, { cwd, timeout: EXEC_TIMEOUT_MS });
	if (result.code !== 0) return null;
	const out = result.stdout.trim();
	return out.length > 0 ? out : null;
}

/**
 * Integration branch to measure against, e.g. "origin/main". Prefers the remote's
 * advertised default branch so repos using `develop` or `trunk` work unchanged, and
 * prefers remote refs because a local `main` is often stale.
 */
async function resolveBaseRef(pi: ExtensionAPI, cwd: string): Promise<string | null> {
	const advertised = await git(pi, cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (advertised) return advertised;
	for (const ref of BASE_REF_CANDIDATES) {
		if (await git(pi, cwd, ["rev-parse", "--verify", "--quiet", ref])) return ref;
	}
	return null;
}

/**
 * Commit to diff the working tree against: always the merge base with the
 * integration branch.
 *
 * Deliberately not special-cased per branch. One rule holds everywhere — "everything
 * you have that the integration branch does not" — so the number never silently
 * changes meaning as you switch branches. On a feature branch it covers branch
 * commits plus staged, unstaged, and untracked work. On the integration branch the
 * merge base collapses to `HEAD` as soon as your commits are pushed, so it reduces
 * to uncommitted-only, while still surfacing commits you have not pushed yet.
 *
 * Note this is the merge base, not the base branch tip: diffing the tip would fold
 * commits that landed upstream after your fork point into your count as deletions.
 */
async function resolveDiffBase(pi: ExtensionAPI, cwd: string, baseRef: string | null): Promise<string> {
	if (!baseRef) return "HEAD";
	// Fails on unrelated histories or a shallow clone that lacks the fork point.
	return (await git(pi, cwd, ["merge-base", baseRef, "HEAD"])) ?? "HEAD";
}

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

async function readTrackedStats(pi: ExtensionAPI, cwd: string, base: string): Promise<DiffStats | null> {
	// A single commit argument diffs it against the working tree, so staged and
	// unstaged edits are included. Falls back to the index on a repo with no commits.
	for (const args of [
		["diff", "--numstat", base, "--"],
		["diff", "--numstat", "--cached", "--"],
	]) {
		const result = await pi.exec("git", args, { cwd, timeout: EXEC_TIMEOUT_MS });
		if (result.code !== 0) continue;
		const stats: DiffStats = { added: 0, deleted: 0, dirty: false };
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
	if (files.length > 0) stats.dirty = true;
	for (const file of files) stats.added += countLines(join(cwd, file));
}

/**
 * Whether tracked files differ from `HEAD`. `--quiet` exits 1 on a difference and
 * writes nothing, so this stays cheap regardless of how large the diff is.
 */
async function hasUncommittedTrackedChanges(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const head = await pi.exec("git", ["diff", "--quiet", "HEAD", "--"], { cwd, timeout: EXEC_TIMEOUT_MS });
	if (head.code === 0) return false;
	if (head.code === 1) return true;
	// Higher codes mean git errored rather than reported a difference, typically
	// because HEAD does not exist yet. Anything staged in that state is uncommitted.
	const cached = await pi.exec("git", ["diff", "--quiet", "--cached", "--"], { cwd, timeout: EXEC_TIMEOUT_MS });
	return cached.code === 1;
}

async function readDiffStats(pi: ExtensionAPI, cwd: string, baseRef: string | null): Promise<DiffStats | null> {
	try {
		const base = await resolveDiffBase(pi, cwd, baseRef);
		const stats = await readTrackedStats(pi, cwd, base);
		if (!stats) return null;
		stats.dirty = await hasUncommittedTrackedChanges(pi, cwd);
		if (INCLUDE_UNTRACKED) await addUntrackedStats(pi, cwd, stats);
		// A dirty tree still reports, even when edits happen to net out to zero lines.
		return stats.added === 0 && stats.deleted === 0 && !stats.dirty ? null : stats;
	} catch {
		return null;
	}
}

function renderStats(stats: DiffStats, theme: Theme): string {
	const parts: string[] = [];
	if (stats.added > 0) parts.push(theme.fg("success", `+${stats.added}`));
	if (stats.deleted > 0) parts.push(theme.fg("error", `-${stats.deleted}`));
	// `dim` rather than `warning`: an unclean tree is an ordinary resting state, not a
	// condition to flag. In the default dark theme `warning` is pure #ffff00, the
	// brightest entry in the palette and twice the luminance of the `success` green
	// rendering the counts, so it drew more attention than the figures it qualifies.
	if (stats.dirty) parts.push(theme.fg("dim", DIRTY_MARKER));
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
	let pendingRefreshCwd: string | null = null;
	// The integration branch effectively never changes within a session, so it is
	// resolved once per cwd instead of on every refresh. `undefined` means unresolved,
	// `null` means resolved to "no base branch here".
	const baseRefByCwd = new Map<string, string | null>();

	async function getBaseRef(cwd: string): Promise<string | null> {
		const cached = baseRefByCwd.get(cwd);
		if (cached !== undefined) return cached;
		const resolved = await resolveBaseRef(pi, cwd);
		baseRefByCwd.set(cwd, resolved);
		return resolved;
	}

	async function refresh(cwd: string, force = false) {
		if (refreshing) {
			// Startup no longer blocks tool execution, so preserve one trailing refresh
			// when files change while an earlier Git inspection is still running.
			pendingRefreshCwd = cwd;
			return;
		}
		if (!force && Date.now() - lastRefreshAt < REFRESH_THROTTLE_MS) return;
		refreshing = true;
		try {
			const next = await readDiffStats(pi, cwd, await getBaseRef(cwd));
			lastRefreshAt = Date.now();
			const changed =
				next?.added !== stats?.added || next?.deleted !== stats?.deleted || next?.dirty !== stats?.dirty;
			stats = next;
			if (changed) tui?.requestRender();
		} finally {
			refreshing = false;
			const trailingCwd = pendingRefreshCwd;
			pendingRefreshCwd = null;
			if (trailingCwd) refreshInBackground(trailingCwd, true);
		}
	}

	function refreshInBackground(cwd: string, force = false) {
		void refresh(cwd, force).catch(() => {
			// Footer data is best-effort; detached refreshes must not reject lifecycle work.
		});
	}

	function installFooter(ctx: ExtensionContext) {
		ctx.ui.setFooter((instanceTui, theme, footerData) => {
			// pi's setExtensionFooter disposes the previous footer before invoking this
			// factory, so the assignment below always wins over the old instance's cleanup.
			tui = instanceTui;
			const base = new FooterComponent(asFooterSession(ctx), footerData);
			const unsubscribe = footerData.onBranchChange(() => {
				refreshInBackground(ctx.cwd, true);
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

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		baseRefByCwd.clear();
		installFooter(ctx);
		refreshInBackground(ctx.cwd, true);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		refreshInBackground(ctx.cwd, true);
	});

	pi.on("tool_result", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (!MUTATING_TOOLS.has(event.toolName)) return;
		refreshInBackground(ctx.cwd);
	});
}
