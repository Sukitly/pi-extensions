import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

interface BranchPr {
	number: number;
	url: string;
}

function osc8Link(url: string, label: string): string {
	return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

async function fetchBranchPr(pi: ExtensionAPI): Promise<BranchPr | null> {
	try {
		const result = await pi.exec("gh", ["pr", "view", "--json", "number,url"], { timeout: 5000 });
		if (result.code !== 0 || !result.stdout) return null;
		const data = JSON.parse(result.stdout) as { number?: number; url?: string };
		if (data.number && data.url) return { number: data.number, url: data.url };
		return null;
	} catch {
		return null;
	}
}

const WIDGET_ID = "branch-pr";

export default function (pi: ExtensionAPI) {
	let lastPr: BranchPr | null = null;
	let refreshGeneration = 0;

	function showWidget(ctx: ExtensionContext) {
		if (!lastPr) return;
		const pr = lastPr;
		ctx.ui.setWidget(
			WIDGET_ID,
			(_tui, theme) => new Text(theme.fg("accent", `#${pr.number}`) + `: ${pr.url}`, 0, 0),
		);
	}

	function hideWidget(ctx: ExtensionContext) {
		ctx.ui.setWidget(WIDGET_ID, undefined);
	}

	async function refresh(ctx: ExtensionContext, generation: number) {
		const nextPr = await fetchBranchPr(pi);
		if (generation !== refreshGeneration) return;
		lastPr = nextPr;
		if (lastPr) showWidget(ctx);
		else hideWidget(ctx);
	}

	function refreshInBackground(ctx: ExtensionContext) {
		const generation = ++refreshGeneration;
		void refresh(ctx, generation).catch(() => {
			// Best-effort widget refreshes must not reject detached lifecycle work.
		});
	}

	pi.on("session_shutdown", () => {
		refreshGeneration++;
		lastPr = null;
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
