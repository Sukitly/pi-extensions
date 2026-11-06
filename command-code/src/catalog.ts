// Command Code model catalog: discovery from api.commandcode.ai + reuse of Pi's
// built-in model metadata (context window, capabilities, compat flags).
//
// Costs are deliberately zeroed: Command Code does not bill per-token USD like
// the upstream vendors; usage draws down a plan-wide credit pool on the server
// (see /command-code.usage). Copying Anthropic/xAI/Z.ai prices here would show
// fictitious spend.
import type { Api, Model } from "@earendil-works/pi-ai";

import { BASE_URL, MODELS_URL, PROVIDER_ID, PROVIDER_NAME } from "./constants.ts";
export { BASE_URL, MODELS_URL, PROVIDER_ID, PROVIDER_NAME };

export const DEFAULT_CATALOG_REFRESH_MS = 4 * 60 * 60 * 1000;
export const CATALOG_SCHEMA_VERSION = 1;
export const PERSIST_KEY = "pi-command-code";

/** Minimal shape of one entry of GET /provider/v1/models. */
export interface CommandCodeModelEntry {
	id: string;
	name?: string;
	context_length?: number;
	supported_endpoints?: string[];
}

export type CommandCodeApiResponse = { data?: CommandCodeModelEntry[] };

/** Minimal Model fields we depend on when cloning built-ins. */
export type BuiltinModelLike = Pick<
	Model<Api>,
	"id" | "name" | "api" | "provider" | "baseUrl" | "reasoning" | "input" | "cost" | "contextWindow" | "maxTokens"
> & {
	compat?: Record<string, unknown>;
	thinkingLevelMap?: Record<string, string | null>;
	inputLimits?: Record<string, unknown>;
};

export interface ChatCatalogIndex {
	byId: Map<string, BuiltinModelLike>;
	byName: Map<string, BuiltinModelLike>;
}

export function normalizeKey(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function lastPathSegment(id: string): string {
	const slash = id.indexOf("/");
	return slash === -1 ? id : id.slice(slash + 1);
}

/**
 * Index Pi's built-in chat catalog so Command Code entries can reuse upstream
 * metadata instead of maintaining a private model database.
 */
export function buildChatCatalogIndex(models: readonly BuiltinModelLike[]): ChatCatalogIndex {
	const byId = new Map<string, BuiltinModelLike>();
	const byName = new Map<string, BuiltinModelLike>();
	for (const model of models) {
		if (!byId.has(normalizeKey(model.id))) byId.set(normalizeKey(model.id), model);
		const name = normalizeKey(model.name ?? "");
		if (name && !byName.has(name)) byName.set(name, model);
	}
	return { byId, byName };
}

export type ApiChoice = "anthropic-messages" | "openai-completions" | "openai-responses";

/** Pick Pi's built-in protocol implementation from Command Code's supported endpoints. */
export function apiForEndpoints(endpoints: readonly string[] | undefined): ApiChoice | undefined {
	const eps = new Set(endpoints ?? []);
	// Explicit, verified-only choices: /messages -> Anthropic Messages,
	// /chat/completions -> OpenAI Chat Completions. /responses alone -> Responses.
	const hasMessages = eps.has("/messages");
	const hasCompletions = eps.has("/chat/completions");
	const hasResponses = eps.has("/responses");
	if (hasMessages && !hasCompletions) return "anthropic-messages";
	if (hasCompletions) return "openai-completions";
	if (hasMessages) return "anthropic-messages";
	if (hasResponses) return "openai-responses";
	return undefined;
}

export interface MatchResult {
	model: Model<Api>;
	matched: "builtin-id" | "builtin-name" | "synthesized" | "cached";
}

const MAX_OUTPUT_TOKENS_CAP = 65536;
const MAX_OUTPUT_TOKENS_MIN = 8192;

function defaultMaxTokens(contextWindow: number): number {
	return Math.max(MAX_OUTPUT_TOKENS_MIN, Math.min(MAX_OUTPUT_TOKENS_CAP, Math.floor(contextWindow / 2)));
}

export const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/**
 * Adapt one Command Code catalog entry into a Pi chat model, reusing the best
 * matching Pi built-in for capability metadata. The cost is always reset:
 * Command Code plan billing is credit-based, so per-token vendor prices would
 * lie. Server-supplied context_length wins over the upstream value since the
 * proxy advertises what it actually accepts.
 */
export function matchCommandCodeModel(
	entry: CommandCodeModelEntry,
	index: ChatCatalogIndex,
): MatchResult | undefined {
	const endpoints = entry.supported_endpoints;
	const api = apiForEndpoints(endpoints);
	if (!api || !entry.id) return undefined;

	const bare = lastPathSegment(entry.id);
	let builtin = index.byId.get(normalizeKey(bare));
	let matched: MatchResult["matched"] | undefined;
	if (builtin) {
		matched = "builtin-id";
	} else {
		builtin = index.byId.get(normalizeKey(entry.id));
		if (builtin) matched = "builtin-id";
	}
	if (!builtin) {
		builtin = index.byName.get(normalizeKey(entry.name ?? entry.id));
		if (builtin) matched = "builtin-name";
	}

	const contextWindow =
		typeof entry.context_length === "number" && entry.context_length > 0
			? entry.context_length
			: (builtin?.contextWindow ?? 200000);

	if (!builtin) {
		// Unknown vendor: synthesize a conservative chat model directly from the
		// server-declared metadata (endpoint + context length). No vendor compat
		// flags, no reasoning guess, zero cost.
		return {
			model: {
				type: "chat",
				id: entry.id,
				name: entry.name ?? entry.id,
				api,
				provider: PROVIDER_ID,
				baseUrl: BASE_URL,
				reasoning: false,
				input: ["text"],
				cost: { ...ZERO_COST },
				contextWindow,
				maxTokens: defaultMaxTokens(contextWindow),
			} as unknown as Model<Api>,
			matched: "synthesized",
		};
	}
	const compatible = builtin.api === api;

	const model: Model<Api> = {
		...(builtin as Model<Api>),
		// Without an exact-ID match we cannot trust vendor-specific compat flags
		// across a different protocol on the proxy.
		...(compatible && builtin.reasoning ? { reasoning: true } : {}),
		id: entry.id,
		name: entry.name ?? builtin.name,
		api,
		provider: PROVIDER_ID,
		baseUrl: BASE_URL,
		cost: { ...ZERO_COST },
		contextWindow,
		maxTokens: builtin.maxTokens ?? defaultMaxTokens(contextWindow),
		reasoning: compatible ? (builtin.reasoning ?? false) : false,
		...(compatible && builtin.thinkingLevelMap ? { thinkingLevelMap: builtin.thinkingLevelMap } : {}),
		...(compatible && builtin.inputLimits ? { inputLimits: builtin.inputLimits } : {}),
		...(compatible && builtin.compat ? { compat: builtin.compat } : {}),
	};
	return { model, matched: matched ?? "builtin-id" };
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
