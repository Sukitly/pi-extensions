// Command Code provider extension for Pi.
//
// Registers a native Pi provider with:
//  - api_key authentication (native /login command-code and /logout, stored in
//    Pi's credential store; also authorized via COMMAND_CODE_API_KEY env var)
//  - dynamic model discovery from GET /provider/v1/models, reusing Pi's
//    built-in model metadata and endpoint implementations
//  - plan usage (5h / weekly windows + remaining monthly credits) shown as a
//    persistent widget while a Command Code model is selected
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { registerUsage } from "../../provider-shared/usage-lifecycle.ts";
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
	refreshStoredModelMetadata,
	PROVIDER_ID,
	PROVIDER_NAME,
} from "./catalog.ts";
import { fetchCommandCodeUsage } from "./usage.ts";
import { buildCommandCodeWidgetLine } from "./widget.ts";

export const WIDGET_ID = "command-code-usage";

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
		const stored = refreshStoredModelMetadata(chatModels(context.stored?.models ?? []), index);
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

	registerUsage(pi, {
		provider: PROVIDER_ID,
		widgetId: WIDGET_ID,
		missingCredential: "No Command Code API key. Run /login command-code first.",
		resolveKey: (ctx) => ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID),
		fetchUsage: fetchCommandCodeUsage,
		widgetLine: buildCommandCodeWidgetLine,
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
