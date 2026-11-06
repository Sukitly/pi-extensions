// Command Code provider extension for Pi.
//
// Registers a native Pi provider with:
//  - api_key authentication (native /login command-code and /logout, stored in
//    Pi's credential store; also authorized via COMMAND_CODE_API_KEY env var)
//  - dynamic model discovery from GET /provider/v1/models, reusing Pi's
//    built-in model metadata and endpoint implementations
//  - plan usage (5h / weekly windows + remaining monthly credits) shown as a
//    persistent widget while a Command Code model is selected, and via
//    /command-code.usage
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	anthropicMessagesApi,
	createProvider,
	envApiKeyAuth,
	type Model,
	openAICompletionsApi,
	type Provider,
	openAIResponsesApi,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai/compat";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import {
	BASE_URL,
	buildChatCatalogIndex,
	type ChatCatalogIndex,
	discoverCommandCodeModels,
	fallbackModels,
	isCatalogFresh,
	PROVIDER_ID,
	PROVIDER_NAME,
} from "./catalog.ts";
import {
	fetchCommandCodeUsage,
	formatUsageLine,
	formatUsageSummary,
	type CommandCodeUsage,
} from "./usage.ts";

export const WIDGET_ID = "command-code-usage";
const MIN_USAGE_REFRESH_MS = 3 * 60 * 1000;

function chatModels(models: readonly unknown[]): Model[] {
	return models.filter(
		(model): model is Model =>
			typeof model === "object" && model !== null && (model as { type?: unknown }).type === undefined,
	);
}

function emitCommandOutput(
	ctx: ExtensionCommandContext,
	text: string,
	type: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(text, type);
		return;
	}
	if (type === "warning" || type === "error") console.error(text);
	else console.log(text);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function buildCommandCodeProvider(index: ChatCatalogIndex): Provider {
	let lastKnownModels: Model[] = [];

	async function fetchModels(context: RefreshModelsContext): Promise<Model[]> {
		const stored = chatModels(context.stored?.models ?? []);
		if (stored.length > 0) lastKnownModels = stored;
		if (context.signal.aborted) return lastKnownModels;

		if (!context.force && isCatalogFresh(context.stored?.checkedAt)) {
			// Fresh cache. Return it untouched so nothing is wiped and fetches stay idle.
			if (lastKnownModels.length > 0) return lastKnownModels;
		}
		if (!context.allowNetwork) {
			return lastKnownModels;
		}

		try {
			const fetched = await discoverCommandCodeModels(index, context.signal);
			if (context.signal.aborted) return lastKnownModels;
			lastKnownModels = fetched;
			return fetched;
		} catch (error) {
			// Keep the last-known-good (or fallback) catalog; a failed refresh must
			// never clear registered models. Surface the error only when we have
			// nothing at all to show.
			if (lastKnownModels.length === 0) throw error;
			emitWarningOnce(`Command Code model refresh failed; keeping last known catalog (${errorMessage(error)})`);
			return lastKnownModels;
		}
	}

	return createProvider({
		id: PROVIDER_ID,
		name: PROVIDER_NAME,
		baseUrl: BASE_URL,
		auth: { apiKey: envApiKeyAuth(`${PROVIDER_NAME} API key`, ["COMMAND_CODE_API_KEY"]) },
		models: fallbackModels(index),
		fetchModels,
		api: {
			"openai-completions": openAICompletionsApi(),
			"anthropic-messages": anthropicMessagesApi(),
			"openai-responses": openAIResponsesApi(),
		},
	});
}

let lastRefreshWarning: string | undefined;
function emitWarningOnce(message: string): void {
	if (lastRefreshWarning === message) return;
	lastRefreshWarning = message;
	console.error(`[command-code] ${message}`);
}

export default function (pi: ExtensionAPI): void {
	const index = buildChatCatalogIndex(
		getBuiltinProviders().flatMap((provider) => getBuiltinModels(provider)),
	);
	const provider = buildCommandCodeProvider(index);
	pi.registerProvider(provider as Provider);

	// Kick discovery early (print/JSON modes do not refresh before resolving --model).
	pi.on("session_start", async (_event, ctx) => {
		if (process.env.PI_OFFLINE !== undefined) return;
		if (typeof ctx.modelRegistry?.refresh !== "function") return;
		try {
			await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID] });
		} catch {
			// Last-known-good catalog stays registered; failures surface via /command-code.models.
		}
	});

	// ------------------------- usage widget -------------------------

	let cachedUsage: CommandCodeUsage | undefined;
	let usageError: string | undefined;
	let refreshInFlight: Promise<void> | undefined;

	function resolveApiKey(ctx: ExtensionContext): Promise<string | undefined> {
		return ctx.modelRegistry
			.getApiKeyForProvider(PROVIDER_ID)
			.catch(() => undefined);
	}

	async function refreshUsage(ctx: ExtensionContext, force = false): Promise<void> {
		if (!cachedUsage && usageError && !force) return;
		const cachedAt = cachedUsage?.fetchedAt ?? 0;
		if (!force && cachedUsage && Date.now() - cachedAt < MIN_USAGE_REFRESH_MS) return;
		if (refreshInFlight) {
			await refreshInFlight;
			return;
		}
		refreshInFlight = (async () => {
			try {
				const apiKey = await resolveApiKey(ctx);
				if (!apiKey) throw new Error("No Command Code API key. Run /login command-code first.");
				cachedUsage = await fetchCommandCodeUsage(apiKey);
				usageError = undefined;
			} catch (error) {
				usageError = errorMessage(error);
			}
		})();
		try {
			await refreshInFlight;
		} finally {
			refreshInFlight = undefined;
		}
	}

	function widgetLines(ctx: ExtensionContext): string | undefined {
		if (!cachedUsage && !usageError) return undefined;
		const parts: string[] = [];
		if (cachedUsage) parts.push(formatUsageLine(cachedUsage));
		if (usageError) {
			const stale = cachedUsage ? " (stale)" : "";
			parts.push(`Command Code usage unavailable${stale}: ${usageError} — ${Math.round((Date.now() - (cachedUsage?.fetchedAt ?? Date.now())) / 60000)}m old; will retry`);
		}
		return parts.filter(Boolean).join("\n") || undefined;
	}

	function updateWidget(ctx: ExtensionContext, active: boolean): void {
		if (!ctx.hasUI) return;
		const text = active ? widgetLines(ctx) : undefined;
		try {
			ctx.ui.setWidget(WIDGET_ID, text, { placement: "belowEditor" });
		} catch (error) {
			// Reloads can orphan contexts; widget updates are best-effort.
			if (!String(error).includes("ctx is stale")) console.error(`[command-code] widget: ${errorMessage(error)}`);
		}
	}

	pi.on("model_select", (event, ctx) => {
		const active = event.model.provider === PROVIDER_ID;
		updateWidget(ctx, active);
		if (active) {
			void refreshUsage(ctx, true)
				.then(() => updateWidget(ctx, true))
				.catch(() => {});
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		if (ctx.model?.provider !== PROVIDER_ID) return;
		updateWidget(ctx, true);
		void refreshUsage(ctx)
			.then(() => updateWidget(ctx, true))
			.catch(() => {});
	});

	pi.on("session_shutdown", () => {
		cachedUsage = undefined;
		usageError = undefined;
	});

	// ------------------------- commands -------------------------

	pi.registerCommand("command-code.usage", {
		description: "Show Command Code plan usage (5h/weekly windows, remaining credits)",
		handler: async (_args, ctx) => {
			try {
				const apiKey = await resolveApiKey(ctx as unknown as ExtensionContext);
				if (!apiKey) {
					emitCommandOutput(ctx, "No Command Code API key. Run /login command-code first.", "warning");
					return;
				}
				if (ctx.hasUI) ctx.ui.notify("Fetching Command Code usage…", "info");
				const usage = await fetchCommandCodeUsage(apiKey);
				cachedUsage = usage;
				usageError = undefined;
				emitCommandOutput(ctx, formatUsageSummary(usage));
				updateWidget(ctx as unknown as ExtensionContext, true);
			} catch (error) {
				usageError = errorMessage(error);
				if (cachedUsage) {
					emitCommandOutput(
						ctx,
						`${formatUsageSummary(cachedUsage, { stale: `refresh failed (${usageError}); data may be expired` })}`,
						"warning",
					);
				} else {
					emitCommandOutput(ctx, `Command Code usage unavailable: ${usageError}`, "warning");
				}
			}
		},
	});

	pi.registerCommand("command-code.models", {
		description: "List Command Code models; pass 'refresh' to force a catalog refresh",
		handler: async (args, ctx) => {
			const wantsRefresh = /\brefresh\b/i.test(args || "");
			try {
				if (wantsRefresh && typeof ctx.modelRegistry?.refresh === "function") {
					const result = await ctx.modelRegistry.refresh({ force: true, providers: [PROVIDER_ID] });
					const error = result?.errors?.get(PROVIDER_ID);
					if (error) throw error;
				}
				const models = ctx.modelRegistry.getModels(PROVIDER_ID);
				if (models.length === 0) {
					emitCommandOutput(ctx, "No Command Code models registered. Try /command-code.models refresh.", "warning");
					return;
				}
				const lines = models.map((m) => `${m.id}  (${m.api}, ctx ${(m.contextWindow / 1000).toFixed(0)}k)`);
				emitCommandOutput(ctx, `Command Code models (${models.length})\n${lines.join("\n")}`);
			} catch (error) {
				emitCommandOutput(ctx, `Command Code model refresh failed: ${errorMessage(error)}`, "error");
			}
		},
	});
}
