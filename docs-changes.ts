/**
 * Docs Changes - Show changes in docs/ directory as a widget
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { existsSync } from "node:fs";
import { join } from "node:path";

const WIDGET_ID = "docs-changes";

interface DocsChange {
	prefix: string;
	file: string;
	kind: "added" | "modified" | "deleted";
}

async function getDocsChanges(pi: ExtensionAPI, cwd: string): Promise<DocsChange[] | null> {
	const docsDir = join(cwd, "docs");
	if (!existsSync(docsDir)) return null;

	const changes: DocsChange[] = [];
	const seen = new Set<string>();

	// Tracked file changes (modified, deleted, staged)
	const diff = await pi.exec("git", ["diff", "--name-status", "HEAD", "--", "docs/"], {
		timeout: 5000,
	});
	if (diff.code === 0 && diff.stdout.trim()) {
		for (const line of diff.stdout.trim().split("\n")) {
			const [status, ...rest] = line.split("\t");
			const file = rest.join("\t").replace(/^docs\//, "");
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
	const untracked = await pi.exec("git", ["ls-files", "--others", "--exclude-standard", "--", "docs/"], {
		timeout: 5000,
	});
	if (untracked.code === 0 && untracked.stdout.trim()) {
		for (const file of untracked.stdout.trim().split("\n")) {
			const short = file.replace(/^docs\//, "");
			if (!short || seen.has(short) || short.endsWith("/index.md") || short === "index.md") continue;
			seen.add(short);
			changes.push({ prefix: "+", file: short, kind: "added" });
		}
	}

	return changes.length > 0 ? changes : null;
}

export default function (pi: ExtensionAPI) {
	let lastChanges: DocsChange[] | null = null;

	function showWidget(ctx: ExtensionContext) {
		if (!lastChanges) return;
		const changes = lastChanges;
		ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => {
			const colorMap = {
				added: "success",
				modified: "warning",
				deleted: "error",
			} as const;
			const parts = changes.map((c) => theme.fg(colorMap[c.kind], `${c.prefix}${c.file}`));
			return new Text(parts.join("\n"), 0, 0);
		});
	}

	function hideWidget(ctx: ExtensionContext) {
		ctx.ui.setWidget(WIDGET_ID, undefined);
	}

	async function refresh(ctx: ExtensionContext) {
		lastChanges = await getDocsChanges(pi, ctx.cwd);
		if (lastChanges) showWidget(ctx);
		else hideWidget(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		await refresh(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		await refresh(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		await refresh(ctx);
	});
}
