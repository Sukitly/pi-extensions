import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// The shared footer places model:* statuses after the model/thinking label.
const STATUS_KEY = "model:codex-fast";
const USAGE = "/fast [on|off|status]";

type FastState = { enabled: boolean; error?: string };

/** A shared preference, not session state. OFF leaves Pi's original payload alone. */
export default function (pi: ExtensionAPI) {
	const agentDir = process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=$|\/)/, homedir())
		|| join(homedir(), ".pi", "agent");
	const statePath = join(agentDir, "codex-fast.json");
	let currentContext: ExtensionContext | undefined;
	let stopWatching = () => {};
	let lastReadError: string | undefined;

	function readState(): FastState {
		try {
			const data: unknown = JSON.parse(fs.readFileSync(statePath, "utf8"));
			if (!data || typeof data !== "object" || !("enabled" in data) || typeof data.enabled !== "boolean") {
				throw new Error('Expected { "enabled": true | false }');
			}
			return { enabled: data.enabled };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: false };
			return { enabled: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	function refresh(ctx: ExtensionContext): FastState {
		currentContext = ctx;
		const state = readState();
		if (ctx.mode === "tui") {
			ctx.ui.setStatus(
				STATUS_KEY,
				ctx.model?.provider === "openai-codex" && (state.enabled || state.error)
					? ctx.ui.theme.fg("warning", state.error ? "fast?" : "fast")
					: undefined,
			);
		}
		if (state.error && state.error !== lastReadError) {
			ctx.ui.notify(`Cannot read ${statePath}: ${state.error}. This extension will not request priority.`, "warning");
		}
		lastReadError = state.error;
		return state;
	}

	pi.registerCommand("fast", {
		description: "Toggle global Codex Fast mode, or use on/off/status (higher credit usage when ON)",
		getArgumentCompletions: (prefix) => {
			const items = ["on", "off", "status"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (!["", "on", "off", "status"].includes(action)) {
				ctx.ui.notify(`Usage: ${USAGE}. No argument toggles the global setting.`, "warning");
				return;
			}

			const state = refresh(ctx);
			const inactive = ctx.model?.provider === "openai-codex"
				? ""
				: " This session's provider is unaffected.";
			if (action === "status") {
				ctx.ui.notify(
					state.error
						? `Fast status unavailable: cannot read ${statePath}. This extension will not request priority.${inactive}`
						: `Fast ${state.enabled ? "ON" : "OFF"} globally.${inactive}`,
					state.error ? "warning" : "info",
				);
				return;
			}
			if (!action && state.error) {
				ctx.ui.notify("Cannot toggle an unreadable setting. Use /fast on or /fast off explicitly to replace it.", "warning");
				return;
			}

			const enabled = action ? action === "on" : !state.enabled;
			try {
				fs.mkdirSync(agentDir, { recursive: true });
				fs.writeFileSync(statePath, `${JSON.stringify({ enabled }, null, 2)}\n`, { mode: 0o600 });
			} catch (error) {
				ctx.ui.notify(`Could not save Fast mode: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			refresh(ctx);
			ctx.ui.notify(
				`Fast ${enabled ? "ON" : "OFF"} globally. Applies from the next Codex request.${enabled ? " Higher credit usage." : ""}${inactive}`,
				"info",
			);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		stopWatching();
		stopWatching = () => {};
		refresh(ctx);
		// Keep other open terminals' indicators in sync, even while they are idle.
		// Request correctness does not depend on this poll: every request reads the file.
		if (ctx.mode === "tui") {
			const onChange = () => { if (currentContext) refresh(currentContext); };
			fs.watchFile(statePath, { persistent: false, interval: 1000 }, onChange);
			stopWatching = () => fs.unwatchFile(statePath, onChange);
		}
	});

	pi.on("model_select", (_event, ctx) => { refresh(ctx); });

	pi.on("session_shutdown", (_event, ctx) => {
		stopWatching();
		stopWatching = () => {};
		currentContext = undefined;
		if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "openai-codex") return;
		if (!refresh(ctx).enabled) return;
		if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
			ctx.ui.notify("Fast mode skipped: unexpected Codex request payload.", "warning");
			return;
		}
		return { ...event.payload, service_tier: "priority" };
	});
}
