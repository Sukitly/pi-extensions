import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	clampThinkingLevel,
	openAICodexResponsesApi,
	type OpenAICodexResponsesOptions,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";

// The shared footer places model:* statuses after the model/thinking label.
const STATUS_KEY = "model:codex-fast";
const USAGE = "/fast [on|off|status]";
const nativeCodex = openAICodexResponsesApi();

// Explicit model aliases covered by https://developers.openai.com/codex/speed/.
// New aliases and snapshots require verification, not prefix matching.
// Model support does not establish account eligibility or confirm server routing.
const FAST_MODEL_IDS = new Set([
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-astra",
]);

function supportsFast(model: ExtensionContext["model"]): boolean {
	return model?.provider === "openai-codex" && FAST_MODEL_IDS.has(model.id);
}

type FastState = { enabled: boolean; error?: string };

export function getFastStatePath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=$|\/)/, homedir())
		|| join(homedir(), ".pi", "agent");
	return join(agentDir, "codex-fast.json");
}

export function readFastState(statePath: string): FastState {
	try {
		const data: unknown = JSON.parse(fs.readFileSync(statePath, "utf8"));
		if (!data || typeof data !== "object" || !("enabled" in data) || typeof data.enabled !== "boolean") {
			throw new Error('Expected { "enabled": true | false }');
		}
		return { enabled: data.enabled };
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { enabled: false };
		return { enabled: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Publish one complete snapshot. Readers see the previous file or the new one, never a partial write. */
export function writeFastState(statePath: string, enabled: boolean): void {
	const directory = dirname(statePath);
	fs.mkdirSync(directory, { recursive: true });
	const temporary = join(directory, `.${basename(statePath)}.${randomUUID()}.tmp`);
	let fd: number | undefined;
	let created = false;
	try {
		fd = fs.openSync(temporary, "wx", 0o600);
		created = true;
		fs.writeFileSync(fd, `${JSON.stringify({ enabled }, null, 2)}\n`);
		fs.fsyncSync(fd);
		const closing = fd;
		fd = undefined;
		fs.closeSync(closing);
		fs.renameSync(temporary, statePath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// Failed temporary files are retained for diagnosis, not published or deleted.
		throw new Error(`${message}${created ? `. Unpublished temporary file: ${temporary}` : ""}`, { cause: error });
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* Preserve the original publication error. */ }
		}
	}
}

/** Keep the SDK's pricing input aligned with the final payload after all extension hooks. */
export const streamCodexWithTier: NonNullable<ProviderConfig["streamSimple"]> = (model, context, options) => {
	// Built-in compaction and branch summaries do not carry the agent-loop onPayload hook.
	// Leave those calls on the original simple-stream path; this adapter never reads the Fast preference.
	if (!options?.onPayload) return nativeCodex.streamSimple(model, context, options);

	// Pi 0.85's native streamSimple drops serviceTier. Use the native full stream,
	// preserving transport/auth/callbacks and the same reasoning-level conversion.
	const requestOptions: OpenAICodexResponsesOptions & Record<string, unknown> = { ...options };
	if (options.reasoning) {
		const level = clampThinkingLevel(model, options.reasoning);
		requestOptions.reasoningEffort = level === "off" ? undefined : level;
	}
	const onPayload = options.onPayload;
	requestOptions.onPayload = async (payload, requestModel) => {
		const replacement = await onPayload(payload, requestModel);
		const finalPayload = replacement === undefined ? payload : replacement;
		requestOptions.serviceTier = finalPayload && typeof finalPayload === "object" && "service_tier" in finalPayload
			? finalPayload.service_tier as OpenAICodexResponsesOptions["serviceTier"]
			: undefined;
		return replacement;
	};
	return nativeCodex.stream(model, context, requestOptions);
};

function report(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error", failed = false): void {
	if (ctx.mode === "tui" || ctx.mode === "rpc") {
		ctx.ui.notify(message, level);
	} else {
		// Keep JSON stdout machine-readable. Pi catches command exceptions, so throwing
		// alone cannot make a failed print/JSON command exit unsuccessfully.
		process.stderr.write(`[codex-fast] ${message}\n`);
		if (failed) process.exitCode = 1;
	}
}

/** A shared preference for agent-loop requests, not session state. OFF leaves the payload alone. */
export default function (pi: ExtensionAPI) {
	const statePath = getFastStatePath();
	let currentContext: ExtensionContext | undefined;
	let stopWatching = () => {};
	let lastReadError: string | undefined;

	// Override streaming only. Keep the existing provider's models, OAuth, and request authentication.
	pi.registerProvider("openai-codex", { api: "openai-codex-responses", streamSimple: streamCodexWithTier });

	function refresh(ctx: ExtensionContext): FastState {
		currentContext = ctx;
		const state = readFastState(statePath);
		if (ctx.mode === "tui") {
			ctx.ui.setStatus(
				STATUS_KEY,
				supportsFast(ctx.model) && (state.enabled || state.error)
					? ctx.ui.theme.fg("warning", state.error ? "fast?" : "fast")
					: undefined,
			);
		}
		if (state.error && state.error !== lastReadError) {
			report(ctx, `Cannot read ${statePath}: ${state.error}. This extension will not request priority.`, "warning");
		}
		lastReadError = state.error;
		return state;
	}

	pi.registerCommand("fast", {
		description: "Toggle global Fast for supported agent-loop Codex models, or use on/off/status (higher credit usage when ON)",
		getArgumentCompletions: (prefix) => {
			const items = ["on", "off", "status"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (!["", "on", "off", "status"].includes(action)) {
				report(ctx, `Usage: ${USAGE}. No argument toggles the global setting.`, "warning", true);
				return;
			}

			const state = refresh(ctx);
			const inactive = supportsFast(ctx.model)
				? ""
				: !ctx.model
					? " No active model; Fast is inactive in this session."
					: ctx.model.provider === "openai-codex"
						? ` Fast is inactive for ${ctx.model.id}: model is not in this extension's supported list.`
						: " This session's provider is unaffected.";
			if (action === "status") {
				report(ctx,
					state.error
						? `Fast status unavailable: cannot read ${statePath}. This extension will not request priority.${inactive}`
						: `Fast ${state.enabled ? "ON" : "OFF"} globally for supported agent-loop Codex models.${inactive}`,
					state.error ? "error" : "info",
					Boolean(state.error),
				);
				return;
			}
			if (!action && state.error) {
				report(ctx, "Cannot toggle an unreadable setting. Use /fast on or /fast off explicitly to replace it.", "warning", true);
				return;
			}

			const enabled = action ? action === "on" : !state.enabled;
			try {
				writeFastState(statePath, enabled);
			} catch (error) {
				report(ctx, `Could not save Fast mode: ${error instanceof Error ? error.message : String(error)}`, "error", true);
				return;
			}
			refresh(ctx);
			report(ctx,
				`Fast ${enabled ? "ON" : "OFF"} globally. Applies from the next supported agent-loop Codex request.${enabled ? " Higher credit usage." : ""}${inactive}`,
				"info",
			);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		stopWatching();
		stopWatching = () => {};
		refresh(ctx);
		// Keep other open terminals' indicators in sync, even while they are idle.
		// Each supported agent-loop request reads the file independently of this poll.
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
		if (!supportsFast(ctx.model)) return;
		if (!refresh(ctx).enabled) return;
		if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
			report(ctx, "Fast mode skipped: unexpected Codex request payload.", "warning");
			return;
		}
		return { ...event.payload, service_tier: "priority" };
	});
}
