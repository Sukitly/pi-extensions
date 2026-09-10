/**
 * Docs Changes - Show changes in agent-docs/ (falling back to docs/) as a widget
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { join } from "node:path";

const WIDGET_ID = "docs-changes";
const MAX_VISIBLE_CHANGES = 8;

interface DocsChange {
	prefix: string;
	file: string;
	kind: "added" | "modified" | "deleted";
}

async function getDocsChanges(pi: ExtensionAPI, cwd: string): Promise<DocsChange[] | null> {
	const docsDir = existsSync(join(cwd, "agent-docs")) ? "agent-docs" : "docs";
	if (!existsSync(join(cwd, docsDir))) return null;
	const docsPrefix = `${docsDir}/`;

	const changes: DocsChange[] = [];
	const seen = new Set<string>();

	// Tracked file changes (modified, deleted, staged)
	const diff = await pi.exec("git", ["diff", "--name-status", "HEAD", "--", docsPrefix], {
		timeout: 5000,
	});
	if (diff.code === 0 && diff.stdout.trim()) {
		for (const line of diff.stdout.trim().split("\n")) {
			const [status, ...rest] = line.split("\t");
			const file = rest.join("\t").replace(new RegExp(`^${docsPrefix}`), "");
			if (!status || !file || seen.has(file) || file.endsWith("/index.md") || file === "index.md") continue;
			seen.add(file);

			if (status === "A") {
				changes.push({ prefix: "+", file, kind: "added" });
			} else if (status === "D") {
				changes.push({ prefix: "-", file, kind: "deleted" });
			} else {
				changes.push({ prefix: "~", file, kind: "modified" });
			}
		}
	}

	// Untracked files
	const untracked = await pi.exec("git", ["ls-files", "--others", "--exclude-standard", "--", docsPrefix], {
		timeout: 5000,
	});
	if (untracked.code === 0 && untracked.stdout.trim()) {
		for (const file of untracked.stdout.trim().split("\n")) {
			const short = file.replace(new RegExp(`^${docsPrefix}`), "");
			if (!short || seen.has(short) || short.endsWith("/index.md") || short === "index.md") continue;
			seen.add(short);
			changes.push({ prefix: "+", file: short, kind: "added" });
		}
	}

	return changes.length > 0 ? changes : null;
}

export default function (pi: ExtensionAPI) {
	let lastChanges: DocsChange[] | null = null;
	let refreshGeneration = 0;

	function showWidget(ctx: ExtensionContext) {
		if (!lastChanges) return;
		const changes = lastChanges;
		ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => {
			const colorMap = {
				added: "success",
				modified: "warning",
				deleted: "error",
			} as const;
			const visibleChanges = changes.slice(0, MAX_VISIBLE_CHANGES);
			const parts = visibleChanges.map((c) => theme.fg(colorMap[c.kind], `${c.prefix}${c.file}`));
			const hiddenCount = changes.length - visibleChanges.length;
			if (hiddenCount > 0) {
				parts.push(theme.fg("dim", `… ${hiddenCount} more`));
			}
			return new Text(parts.join(theme.fg("dim", "  ·  ")), 0, 0);
		});
	}

	function hideWidget(ctx: ExtensionContext) {
		ctx.ui.setWidget(WIDGET_ID, undefined);
	}

	async function refresh(ctx: ExtensionContext, cwd: string, generation: number) {
		const nextChanges = await getDocsChanges(pi, cwd);
		if (generation !== refreshGeneration) return;
		lastChanges = nextChanges;
		if (lastChanges) showWidget(ctx);
		else hideWidget(ctx);
	}

	function refreshInBackground(ctx: ExtensionContext) {
		const cwd = ctx.cwd;
		const generation = ++refreshGeneration;
		void refresh(ctx, cwd, generation).catch(() => {
			// Best-effort widget refreshes must not reject detached lifecycle work.
		});
	}

	pi.on("session_shutdown", () => {
		refreshGeneration++;
		lastChanges = null;
	});

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		hideWidget(ctx);
		refreshInBackground(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!ctx.hasUI) return;
		refreshInBackground(ctx);
	});
}
