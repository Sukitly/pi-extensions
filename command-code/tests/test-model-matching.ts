// Tests: model matching against Pi's built-ins, endpoint routing, fallback
// behavior, and cost/cost-neutral adaptation of Command Code catalog entries.
import { inspect } from "node:util";
import {
  apiForEndpoints,
  buildChatCatalogIndex,
  discoverCommandCodeModels,
  FALLBACK_ENTRIES,
  fallbackModels,
  isCatalogFresh,
  lastPathSegment,
  matchCommandCodeModel,
  normalizeKey,
  parseCommandCodeModels,
  refreshStoredModelMetadata,
  type BuiltinModelLike,
  type CommandCodeModelEntry,
  type CommandCodeApiResponse,
} from "../src/catalog.ts";
import { PROVIDER_ID } from "../src/constants.ts";

let passed = 0;
const failures: string[] = [];

function ok(condition: unknown, message: string): void {
  if (condition) {
    passed++;
    return;
  }
  failures.push(message);
}

function eq(actual: unknown, expected: unknown, message: string): void {
  if (inspect(actual) === inspect(expected)) {
    passed++;
    return;
  }
  failures.push(`${message}: got ${inspect(actual)}, expected ${inspect(expected)}`);
}

// ---------------------------------------------------------------------------
// Synthetic built-in catalog so these tests do not depend on live Pi content.
// ---------------------------------------------------------------------------

const glmBuiltIn: BuiltinModelLike = {
  id: "glm-5.3-flash",
  name: "GLM-5.3-Flash",
  api: "openai-completions",
  provider: "zai",
  baseUrl: "https://api.z.ai/api/paas",
  reasoning: true,
  input: ["text"],
  cost: { input: 0.9, output: 2.2, cacheRead: 0.09, cacheWrite: 1.1 },
  contextWindow: 1048576,
  maxTokens: 131072,
  compat: { thinkingFormat: "deepseek" },
  thinkingLevelMap: { off: "off", high: "high" },
};

const mimoBuiltIn: BuiltinModelLike = {
  id: "mimo-v2.6-flash",
  name: "MiMo-V2.6-Flash",
  api: "openai-completions",
  provider: "xiaomi",
  baseUrl: "https://api.xiaomimimo.com/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
  contextWindow: 1048576,
  maxTokens: 131072,
};

const museBuiltIn: BuiltinModelLike = {
  id: "muse-spark-1.3",
  name: "Muse Spark 1.3",
  api: "openai-completions",
  provider: "meta",
  baseUrl: "https://api.meta.ai/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0.4, output: 1.2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1048576,
  maxTokens: 32768,
};

const claudeBuiltIn: BuiltinModelLike = {
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet 4.6",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200000,
  maxTokens: 64000,
  compat: { anthropicBeta: "context-1m" },
};

const index = buildChatCatalogIndex([glmBuiltIn, mimoBuiltIn, museBuiltIn, claudeBuiltIn]);

const minimaxAnthropic: BuiltinModelLike = {
  ...claudeBuiltIn,
  id: "MiniMax-M3.1-Flash",
  name: "MiniMax M3.1 Flash",
  compat: { forceAdaptiveThinking: true },
  thinkingLevelMap: { low: "low", high: "high" },
};
const minimaxCompletions: BuiltinModelLike = {
  ...minimaxAnthropic,
  provider: "opencode-go",
  api: "openai-completions",
  compat: { supportsStrictMode: true },
  thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high" },
};
const minimaxIndex = buildChatCatalogIndex([minimaxAnthropic, minimaxCompletions]);
const minimaxEntry: CommandCodeModelEntry = {
  id: "minimax/minimax-m3.1-flash",
  name: "MiniMax M3.1 Flash",
  supported_endpoints: ["/chat/completions"],
};
const minimaxMatch = matchCommandCodeModel(minimaxEntry, minimaxIndex)?.model;
eq(minimaxMatch?.reasoning, true, "same ID prefers a matching protocol for thinking levels");
eq(minimaxMatch?.thinkingLevelMap, minimaxCompletions.thinkingLevelMap, "MiniMax retains the matching thinking levels");
eq(minimaxMatch?.compat, minimaxCompletions.compat, "Anthropic-only thinking flags are not copied to completions");
const previouslyCached = { ...minimaxMatch!, reasoning: false, thinkingLevelMap: minimaxAnthropic.thinkingLevelMap, compat: minimaxAnthropic.compat };
const repaired = refreshStoredModelMetadata([previouslyCached], minimaxIndex)[0];
eq(repaired.reasoning, true, "previously cached non-reasoning model is repaired offline");
eq(repaired.thinkingLevelMap, minimaxCompletions.thinkingLevelMap, "cached thinking map is repaired");
eq(repaired.compat, minimaxCompletions.compat, "cached protocol flags are repaired");
const mismatchedOnly = matchCommandCodeModel(minimaxEntry, buildChatCatalogIndex([minimaxAnthropic]))?.model;
eq(mismatchedOnly?.reasoning, false, "no compatible protocol means thinking stays unavailable");
eq(mismatchedOnly?.thinkingLevelMap, undefined, "incompatible thinking map is not leaked");
eq(mismatchedOnly?.compat, undefined, "incompatible transport flags are not leaked");

// ---------------------------------------------------------------------------
// endpoint routing
// ---------------------------------------------------------------------------

eq(apiForEndpoints(["/messages"]), "anthropic-messages", "claude → messages");
eq(apiForEndpoints(["/chat/completions"]), "openai-completions", "GLM → completions");
eq(apiForEndpoints(["/chat/completions", "/responses"]), "openai-completions", "MiMo prefer completions");
eq(apiForEndpoints(["/responses"]), "openai-responses", "responses-only → responses api");
eq(apiForEndpoints(undefined), undefined, "no endpoints → skip");
eq(apiForEndpoints([]), undefined, "empty endpoints → skip");

// ---------------------------------------------------------------------------
// id matching + namespace stripping
// ---------------------------------------------------------------------------

eq(lastPathSegment("z-ai/glm-5.3-flash"), "glm-5.3-flash", "strips prefix");
eq(normalizeKey("zai-org/GLM-5.3"), "zaiorgglm53", "normalizes full org ids");

const glm53Builtin: BuiltinModelLike = {
  ...glmBuiltIn,
  id: "glm-5.3",
  name: "GLM-5.3",
};
const bigIndex = buildChatCatalogIndex([glm53Builtin, ...[glmBuiltIn, mimoBuiltIn, museBuiltIn, claudeBuiltIn]]
);
const orgMatch = matchCommandCodeModel({ id: "zai-org/GLM-5.3", supported_endpoints: ["/chat/completions"] }, bigIndex);
eq(orgMatch?.matched, "builtin-id", "zai-org/GLM-5.3 matches raw-id builtin by bare segment");
eq(orgMatch?.model.id, "zai-org/GLM-5.3", "org-prefixed id preserved");
ok(orgMatch?.model.provider === PROVIDER_ID, "org match adapted to command-code");

const entry: CommandCodeModelEntry = {
  id: "z-ai/glm-5.3-flash",
  name: "GLM-5.3 Flash",
  context_length: 1048576,
  supported_endpoints: ["/chat/completions"],
};
const glmMatch = matchCommandCodeModel(entry, index);
ok(glmMatch, "z-ai/glm-5.3-flash matched");
eq(glmMatch?.matched, "builtin-id", "GLM matched by id");
eq(
  glmMatch && { api: glmMatch.model.api, provider: glmMatch.model.provider, baseUrl: glmMatch.model.baseUrl },
  { api: "openai-completions", provider: "command-code", baseUrl: "https://api.commandcode.ai/provider/v1" },
  "GLM adapted to Command Code endpoint + protocol",
);
eq(
  glmMatch?.model.compat,
  { thinkingFormat: "deepseek" },
  "GLM keeps vendor compat flags (same protocol)",
);
eq(
  glmMatch?.model.thinkingLevelMap,
  { off: "off", high: "high" },
  "GLM keeps thinkingLevelMap",
);
eq(
  glmMatch?.model.cost,
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "GLM cost zeroed (credit-based billing, not vendor per-token price)",
);
eq(glmMatch?.model.contextWindow, 1048576, "GLM context window reused");

const mimoEntry: CommandCodeModelEntry = {
  id: "xiaomi/mimo-v2.6-flash",
  supported_endpoints: ["/chat/completions"],
};
const mimoMatch = matchCommandCodeModel(mimoEntry, index);
ok(mimoMatch?.model, "MiMo matched");
eq(mimoMatch?.model.contextWindow, 1048576, "MiMo context window");
eq(mimoMatch?.model.reasoning, true, "MiMo reasoning reused");

const claudeEntry: CommandCodeModelEntry = {
  id: "claude-sonnet-4-6",
  context_length: 200000,
  supported_endpoints: ["/messages"],
};
const claudeMatch = matchCommandCodeModel(claudeEntry, index);
eq(claudeMatch?.model.api, "anthropic-messages", "Claude uses Anthropic Messages impl");
eq(claudeMatch?.model.compat, { anthropicBeta: "context-1m" }, "Claude keeps anthropic compat");

// contract-context drift: server advertises a different context length
const drifted: CommandCodeModelEntry = {
  id: "claude-sonnet-4-6",
  context_length: 1000000,
  supported_endpoints: ["/messages"],
};
eq(matchCommandCodeModel(drifted, index)?.model.contextWindow, 1000000, "server context_length wins");

// name-only fallback match
const oddId: CommandCodeModelEntry = {
  id: "some-weird-alias/muse-spark-1.3-thing",
  name: "Muse Spark 1.3",
  supported_endpoints: ["/chat/completions"],
};
ok(matchCommandCodeModel(oddId, index)?.matched === "builtin-name", "name match fallback");

// synthesized entry: unknown vendor, no compat copied
const unknown: CommandCodeModelEntry = {
  id: "stealth/glyph-cluster",
  context_length: 256000,
  supported_endpoints: ["/chat/completions"],
};
const unknownMatch = matchCommandCodeModel(unknown, index);
ok(unknownMatch, "unknown vendor synthesized");
eq(unknownMatch?.matched, "synthesized", "unknown vendor matched as synthesized");
eq(unknownMatch?.model.compat, undefined, "synthesized model carries no vendor compat");
eq(unknownMatch?.model.contextWindow, 256000, "synthesized keeps server context");
eq(unknownMatch?.model.reasoning, false, "synthesized model is conservative about reasoning");
eq(unknownMatch?.model.api, "openai-completions", "synthesized routes by endpoint");

// unusable endpoint → no model
eq(
  matchCommandCodeModel({ id: "x/unknown", supported_endpoints: ["/grpc"] }, index),
  undefined,
  "unsupported endpoint skipped",
);

// ---------------------------------------------------------------------------
// fallback directory: required models always present, adapted values
// ---------------------------------------------------------------------------

for (const fallback of FALLBACK_ENTRIES) {
  ok(FALLBACK_ENTRIES.some((e) => e.id === fallback.id), `fallback collection includes ${fallback.id}`);
}
const fallback = fallbackModels(index);
eq(fallback.length, FALLBACK_ENTRIES.length, "fallback count");
ok(fallback.some((m) => m.id === "z-ai/glm-5.3-flash"), "GLM-5.3 Flash in fallback");
ok(fallback.some((m) => m.id === "xiaomi/mimo-v2.6-flash"), "MiMo-V2.6 Flash in fallback");
ok(fallback.some((m) => m.id.startsWith("meta/muse-")), "Muse in fallback");
ok(fallback.every((m) => m.provider === PROVIDER_ID), "fallback models owned by command-code");
ok(fallback.every((m) => m.cost.input === 0 && m.cost.output === 0), "fallback costs zeroed");

// ---------------------------------------------------------------------------
// payload parsing + discovery (fetch stub)
// ---------------------------------------------------------------------------

const payload: CommandCodeApiResponse = {
  data: [entry, claudeEntry, { id: "", supported_endpoints: ["/chat/completions"] }],
};
const parsed = parseCommandCodeModels(payload);
eq(parsed.length, 2, "blank ids filtered");
let threw = false;
try {
  parseCommandCodeModels({ data: [] });
} catch {
  threw = true;
}
ok(threw, "empty catalog throws");

const discovered = await discoverCommandCodeModels(index, undefined, async () =>
  new Response(JSON.stringify(payload), { status: 200 }),
);
eq(discovered.length, 2, "discovery adapts catalog");
eq(discovered[0].id, "claude-sonnet-4-6", "discovery sorted");

let endpointHit: RequestInfo | undefined;
try {
  await discoverCommandCodeModels(index, undefined, async (input) => {
    endpointHit = input;
    return new Response("server exploded", { status: 503 });
  });
} catch (error) {
  ok(error instanceof Error && error.message.includes("503"), "HTTP failure surfaces readable error");
}
ok(String(endpointHit).includes("api.commandcode.ai/provider/v1/models"), "discovery hits the live models URL");

// ---------------------------------------------------------------------------
// freshness
// ---------------------------------------------------------------------------

ok(!isCatalogFresh(undefined), "no checkedAt → stale");
ok(!isCatalogFresh(Date.now() - 5 * 60 * 60 * 1000), "older than 4h → stale");
ok(isCatalogFresh(Date.now() - 60 * 1000), "recent check → fresh");

report();

function report(): never {
  console.log(`model-matching: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.error(failures.map((f) => `  FAIL ${f}`).join("\n"));
    process.exit(1);
  }
  process.exit(0);
}
