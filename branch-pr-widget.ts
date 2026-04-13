import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

interface BranchPr {
	number: number;
	url: string;
}

function osc8Link(url: string, label: string): string {
	return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

async function fetchBranchPr(pi: ExtensionAPI): Promise<BranchPr | null> {
	try {
		const result = await pi.exec("gh", ["pr", "view", "--json", "number,url"]);
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

	async function refresh(ctx: ExtensionContext) {
		lastPr = await fetchBranchPr(pi);
		if (lastPr) showWidget(ctx);
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
