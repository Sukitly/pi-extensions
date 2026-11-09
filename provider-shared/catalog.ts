// Shared gateway catalog matching, extracted from Command Code.
import type { Api, Model } from "@earendil-works/pi-ai";

/** Minimal shape of one entry of GET /provider/v1/models. */
export interface GatewayModelEntry {
	id: string;
	name?: string;
	context_length?: number;
	supported_endpoints?: string[];
}

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
	idVariants: Map<string, BuiltinModelLike[]>;
	nameVariants: Map<string, BuiltinModelLike[]>;
}

export function normalizeKey(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function lastPathSegment(id: string): string {
	const slash = id.indexOf("/");
	return slash === -1 ? id : id.slice(slash + 1);
}

/**
 * Index Pi's built-in chat catalog so gateway entries can reuse upstream
 * metadata instead of maintaining a private model database.
 */
export function buildChatCatalogIndex(models: readonly BuiltinModelLike[]): ChatCatalogIndex {
	const byId = new Map<string, BuiltinModelLike>();
	const byName = new Map<string, BuiltinModelLike>();
	const idVariants = new Map<string, BuiltinModelLike[]>();
	const nameVariants = new Map<string, BuiltinModelLike[]>();
	for (const model of models) {
		const id = normalizeKey(model.id);
		if (!byId.has(id)) byId.set(id, model);
		idVariants.set(id, [...(idVariants.get(id) ?? []), model]);
		const name = normalizeKey(model.name ?? "");
		if (name) {
			if (!byName.has(name)) byName.set(name, model);
			nameVariants.set(name, [...(nameVariants.get(name) ?? []), model]);
		}
	}
	return { byId, byName, idVariants, nameVariants };
}

export type ApiChoice = "anthropic-messages" | "openai-completions" | "openai-responses";

/** Pick Pi's built-in protocol implementation from gateway's supported endpoints. */
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
 * Adapt one gateway catalog entry into a Pi chat model, reusing the best
 * matching Pi built-in for capability metadata. The cost is always reset:
 * gateway plan billing is credit-based, so per-token vendor prices would
 * lie. Server-supplied context_length wins over the upstream value since the
 * proxy advertises what it actually accepts.
 */
export function matchGatewayModel(
	entry: GatewayModelEntry,
	index: ChatCatalogIndex,
	target: { provider: string; baseUrl: string },
): MatchResult | undefined {
	const endpoints = entry.supported_endpoints;
	const api = apiForEndpoints(endpoints);
	if (!api || !entry.id) return undefined;

	const bare = lastPathSegment(entry.id);
	const candidates: Array<[BuiltinModelLike, "builtin-id" | "builtin-name"]> = [];
	for (const id of [normalizeKey(bare), normalizeKey(entry.id)]) {
		for (const model of index.idVariants.get(id) ?? []) candidates.push([model, "builtin-id"]);
	}
	for (const model of index.nameVariants.get(normalizeKey(entry.name ?? entry.id)) ?? []) {
		candidates.push([model, "builtin-name"]);
	}
	// The same model ID occurs under several providers/protocols. Prefer one
	// that actually speaks gateway's advertised endpoint.
	const [builtin, matched] = candidates.find(([model]) => model.api === api) ?? candidates[0] ?? [];

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
				provider: target.provider,
				baseUrl: target.baseUrl,
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
	// Never inherit a thinking map or transport flags from the wrong protocol.
	const { thinkingLevelMap: _thinkingLevelMap, compat: _compat, inputLimits: _inputLimits, ...base } = builtin;

	const model: Model<Api> = {
		...(base as Model<Api>),
		id: entry.id,
		name: entry.name ?? builtin.name,
		api,
		provider: target.provider,
		baseUrl: target.baseUrl,
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
