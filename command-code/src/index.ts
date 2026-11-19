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
import { isModelType } from "@earendil-works/pi-ai/models";
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
	const fallback = fallbackModels(index);
	let discovered: Model[] = [];
	const currentModels = () => [...new Map([...fallback, ...discovered].map((model) => [model.id, model])).values()];

	const transport = createProvider({
		id: PROVIDER_ID,
		name: PROVIDER_NAME,
		baseUrl: BASE_URL,
		auth: { apiKey: envApiKeyAuth(`${PROVIDER_NAME} API key`, ["COMMAND_CODE_API_KEY"]) },
		models: fallback,
		api: {
			"openai-completions": openAICompletionsApi(),
			"anthropic-messages": anthropicMessagesApi(),
			"openai-responses": openAIResponsesApi(),
		},
	});

	return {
		...transport,
		getModels: currentModels,
		getAllModels: currentModels,
		async refreshModels(context: RefreshModelsContext): Promise<void> {
			if (context.signal.aborted) return;
			const stored = context.stored?.models.filter(
				(model): model is Model => isModelType(model, "chat") && model.provider === PROVIDER_ID,
			) ?? [];
			if (stored.length > 0) {
				const restored = refreshStoredModelMetadata(stored, index);
				if (!await context.publish({ update: () => { discovered = restored; } })) return;
			}
			if (!context.allowNetwork || context.signal.aborted) return;
			// Old snapshots with only untyped entries may have been truncated by the
			// previous chat filter. Recheck them even if their timestamp looks fresh.
			if (!context.force && stored.some((model) => model.type === "chat") && isCatalogFresh(context.stored?.checkedAt)) return;

			// Publish a new timestamp only after a successful remote check. On
			// failure, keep the existing catalog and let the refresh caller report it.
			const models = (await discoverCommandCodeModels(index, context.signal))
				.map((model) => ({ ...model, type: "chat" as const }));
			if (context.signal.aborted) return;
			await context.publish({
				persist: { models, checkedAt: Date.now() },
				update: () => { discovered = models; },
			});
		},
	};
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
