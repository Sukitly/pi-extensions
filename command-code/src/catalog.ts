// Command Code model catalog: discovery from api.commandcode.ai + reuse of Pi's
// built-in model metadata (context window, capabilities, compat flags).
//
// Costs are deliberately zeroed: Command Code does not bill per-token USD like
// the upstream vendors; usage draws down a plan-wide credit pool on the server
// (see the usage widget). Copying Anthropic/xAI/Z.ai prices here would show
// fictitious spend.
import type { Api, Model } from "@earendil-works/pi-ai";

import { BASE_URL, MODELS_URL, PROVIDER_ID, PROVIDER_NAME } from "./constants.ts";
export { BASE_URL, MODELS_URL, PROVIDER_ID, PROVIDER_NAME };

export const DEFAULT_CATALOG_REFRESH_MS = 4 * 60 * 60 * 1000;
export const CATALOG_SCHEMA_VERSION = 1;
export const PERSIST_KEY = "pi-command-code";

export {
	apiForEndpoints, buildChatCatalogIndex, lastPathSegment, normalizeKey, ZERO_COST,
	type ApiChoice, type BuiltinModelLike, type ChatCatalogIndex, type MatchResult,
} from "../../provider-shared/catalog.ts";
import {
	matchGatewayModel,
	type ChatCatalogIndex, type GatewayModelEntry, type MatchResult,
} from "../../provider-shared/catalog.ts";

export type CommandCodeModelEntry = GatewayModelEntry;
export type CommandCodeApiResponse = { data?: CommandCodeModelEntry[] };

export function matchCommandCodeModel(entry: CommandCodeModelEntry, index: ChatCatalogIndex): MatchResult | undefined {
	return matchGatewayModel(entry, index, { provider: PROVIDER_ID, baseUrl: BASE_URL });
}

/** Rebuild capabilities for persisted models without requiring a network refresh. */
export function refreshStoredModelMetadata(models: readonly Model<Api>[], index: ChatCatalogIndex): Model<Api>[] {
	return models.map((model) => {
		const endpoint = model.api === "anthropic-messages" ? "/messages"
			: model.api === "openai-completions" ? "/chat/completions"
			: model.api === "openai-responses" ? "/responses" : undefined;
		if (!endpoint) return model;
		const result = matchCommandCodeModel({
			id: model.id,
			name: model.name,
			context_length: model.contextWindow,
			supported_endpoints: [endpoint],
		}, index);
		return result && result.matched !== "synthesized" ? result.model : model;
	});
}

/**
 * Fallback directory used when discovery fails or Pi starts offline: at least
 * GLM-5.3 Flash, MiMo-V2.6 Flash, Muse and one Claude alias stay available.
 * Entries are adapted the same way as live entries, resolved against the
 * built-in index.
 */
export const FALLBACK_ENTRIES: CommandCodeModelEntry[] = [
	{ id: "z-ai/glm-5.3-flash", name: "GLM-5.3 Flash", context_length: 1048576, supported_endpoints: ["/chat/completions"] },
	{ id: "xiaomi/mimo-v2.6-flash", name: "MiMo V2.6 Flash", context_length: 1048576, supported_endpoints: ["/chat/completions", "/responses"] },
	{ id: "meta/muse-spark-1.3", name: "Muse Spark 1.3", context_length: 1048576, supported_endpoints: ["/chat/completions", "/responses"] },
	{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", context_length: 200000, supported_endpoints: ["/messages"] },
];

export function fallbackModels(index: ChatCatalogIndex): Model<Api>[] {
	const models: Model<Api>[] = [];
	for (const entry of FALLBACK_ENTRIES) {
		const result = matchCommandCodeModel(entry, index);
		if (result) models.push(result.model);
	}
	return models;
}

/** Parse the raw /provider/v1/models payload. Throws with a readable reason. */
export function parseCommandCodeModels(payload: unknown): CommandCodeModelEntry[] {
	const body = payload as CommandCodeApiResponse | Record<string, unknown> | undefined;
	const candidates: CommandCodeModelEntry[] | undefined = Array.isArray((body as CommandCodeApiResponse)?.data)
		? ((body as CommandCodeApiResponse).data as CommandCodeModelEntry[])
		: Array.isArray(payload)
			? (payload as CommandCodeModelEntry[])
			: undefined;
	if (!candidates || candidates.length === 0) {
		throw new Error("Command Code returned an empty or unrecognized model catalog");
	}
	return candidates.filter(
		(entry) => entry && typeof entry.id === "string" && entry.id.trim() !== "",
	);
}

export function sortModels(models: Model<Api>[]): Model<Api>[] {
	return [...models].sort((a, b) => a.id.localeCompare(b.id));
}

export function catalogRefreshIntervalMs(): number {
	const raw = process.env.COMMAND_CODE_CATALOG_REFRESH_MS ?? process.env.PI_OFFLINE;
	if (raw !== undefined && process.env.COMMAND_CODE_CATALOG_REFRESH_MS !== undefined) {
		const parsed = Number.parseInt(raw, 10);
		if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
	}
	return DEFAULT_CATALOG_REFRESH_MS;
}

export function isCatalogFresh(checkedAt: number | undefined, now = Date.now()): boolean {
	if (!checkedAt || checkedAt <= 0) return false;
	const interval = catalogRefreshIntervalMs();
	if (interval === 0) return false;
	return now >= checkedAt && now - checkedAt < interval;
}

/**
 * Fetch the live catalog and adapt it. Builds on any prior model list so a
 * flaky endpoint never wipes already-registered models.
 */
export async function discoverCommandCodeModels(
	index: ChatCatalogIndex,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<Model<Api>[]> {
	const res = await fetchImpl(MODELS_URL, { signal, headers: { Accept: "application/json" } });
	if (!res.ok) {
		throw new Error(`Command Code model list failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
	}
	const entries = parseCommandCodeModels(await res.json());
	const adapted: Model<Api>[] = [];
	for (const entry of entries) {
		const result = matchCommandCodeModel(entry, index);
		if (result) adapted.push(result.model);
	}
	if (adapted.length === 0) {
		throw new Error("Command Code model list produced no usable models");
	}
	return sortModels(adapted);
}
