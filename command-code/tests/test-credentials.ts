// Tests: provider wiring (native api_key auth via Pi's envApiKeyAuth, native
// protocol implementations, catalog refresh and fallback semantics).
import { inspect } from "node:util";
import {
  BASE_URL,
  buildChatCatalogIndex,
  MODELS_URL,
  fallbackModels,
  PROVIDER_ID,
  PROVIDER_NAME,
} from "../src/catalog.ts";
import { buildCommandCodeProvider } from "../src/index.ts";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { RefreshModelsContext } from "@earendil-works/pi-ai/models";

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
// native credential resolution (no OAuth fake, no private credential file)
// ---------------------------------------------------------------------------

const builtinIndex = buildChatCatalogIndex(
  getBuiltinProviders().flatMap((provider) => getBuiltinModels(provider)),
);
const provider = buildCommandCodeProvider(builtinIndex);
const auth = provider.auth.apiKey;
ok(auth !== undefined, "registered provider exposes native api_key auth");
ok(provider.auth.oauth === undefined, "registered provider does not advertise OAuth");
if (!auth) throw new Error("Provider does not expose api_key auth");
eq(auth.name, "Command Code API key", "api-key display name");
ok(typeof auth.login === "function", "native login flow exists (Pi prompts for the key)");
ok(typeof auth.login === "function", "native secret-prompt login wired");
const resolved = await auth.resolve({
  ctx: { env: async (name) => (name === "COMMAND_CODE_API_KEY" ? "cc_sk_test_key" : undefined), fileExists: async () => false },
  signal: new AbortController().signal,
});
eq(resolved?.auth, { apiKey: "cc_sk_test_key" }, "env var resolves to apiKey auth");
ok(resolved?.source === "COMMAND_CODE_API_KEY", "source label points at the env var");
const none = await auth.resolve({
  ctx: { env: async () => undefined, fileExists: async () => false },
  signal: new AbortController().signal,
});
eq(none, undefined, "unconfigured provider resolves to undefined");

// login flow prompts via interaction and returns a stored api_key credential
const loginResult =
  typeof auth.login === "function" &&
  (await auth.login({
    signal: new AbortController().signal,
    prompt: async (prompt) => {
      ok(prompt.type === "secret", "login prompts for a secret");
      return "cc_sk_prompted_key";
    },
    notify: () => {},
  }));
eq(loginResult, { type: "api_key", key: "cc_sk_prompted_key" }, "login returns a stored api_key credential");

// ---------------------------------------------------------------------------
// provider wiring
// ---------------------------------------------------------------------------

eq(provider.id, PROVIDER_ID, "provider id");
eq(provider.baseUrl, BASE_URL, "provider baseUrl routes to Command Code");
ok(provider.refreshModels !== undefined, "provider is dynamic (fetchModels registered)");
ok(
  typeof provider.stream === "function" && typeof provider.streamSimple === "function",
  "streaming delegated to Pi built-in protocol implementations",
);

// baseline (offline/first-run) catalog contains the required models
const deepSeekPro = "deepseek/deepseek-v4-pro";
const baseline = provider.getModels();
for (const required of [
  deepSeekPro,
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4.1-flash",
  "z-ai/glm-5.3-flash",
  "xiaomi/mimo-v2.6-flash",
  "meta/muse-spark-1.3",
  "Qwen/Qwen4-Max",
  "Qwen/Qwen3.8-Max",
  "Qwen/Qwen3.6-Max-Preview",
  "xai/grok-4.5",
  "xai/grok-4.6",
  "xai/grok-4.7",
  "moonshotai/Kimi-K3.1-Pro",
  "moonshotai/Kimi-K3",
  "moonshotai/Kimi-K2.7-Code",
  "moonshotai/Kimi-K2.5",
]) {
  ok(baseline.some((m) => m.id === required), `baseline includes ${required}`);
}
ok(baseline.some((m) => m.id.startsWith("claude-")), "baseline includes a Claude alias");
ok(baseline.every((m) => m.provider === PROVIDER_ID), "baseline models owned by command-code");
ok(
  baseline.every((m) => (m.api === "openai-completions" || m.api === "anthropic-messages") || m.api === "openai-responses"),
  "baseline routes through Pi built-in protocol implementations",
);

// ---------------------------------------------------------------------------
// Refresh regression: a truncated legacy snapshot must be fetched again;
// typed and untyped chat models must survive subsequent cache restores.
// ---------------------------------------------------------------------------

const visionId = "deepseek/deepseek-v4-flash-vision-exp";
const legacyId = "legacy/cached-chat";
const qwen = fallbackModels(builtinIndex).find((model) => model.id === "Qwen/Qwen4-Max")!;
let stored: RefreshModelsContext["stored"] = {
  models: [{ ...qwen, type: undefined, id: legacyId }],
  checkedAt: Date.now(),
};
let writes = 0;
let fetches = 0;
let fail = false;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  fetches++;
  eq(String(url), MODELS_URL, "refresh uses the Command Code catalog");
  if (fail) return new Response("network unavailable", { status: 503 });
  return Response.json({ data: [deepSeekPro, visionId].map((id) => ({
    id, context_length: 1000000, supported_endpoints: ["/chat/completions"],
  })) });
};
function refresh(target = provider, allowNetwork = true, force = false) {
  return target.refreshModels!({
    stored, allowNetwork, force, signal: new AbortController().signal,
    publish: async ({ persist, update }) => {
      if (persist) { stored = persist; writes++; }
      update?.();
      return true;
    },
  });
}

try {
  await refresh(provider, false);
  eq(fetches, 0, "offline refresh does not fetch");
  eq(writes, 0, "offline refresh does not rewrite the cache");
  ok(provider.getModels().some((model) => model.id === legacyId), "offline restore accepts untyped chat models");

  await refresh();
  eq(fetches, 1, "a recent but legacy-only cache is rechecked");
  eq(writes, 1, "successful refresh saves the new catalog");
  ok(stored?.models.some((model) => model.id === deepSeekPro && model.type === "chat"), "DeepSeek Pro is persisted as chat");
  ok(provider.getModels().some((model) => model.id === visionId), "live discovery adds DeepSeek Vision");
  eq(provider.getAllModels?.().filter((model) => model.id === deepSeekPro).length, 1, "live DeepSeek Pro overrides its fallback");

  const refreshed = stored;
  const restarted = buildCommandCodeProvider(builtinIndex);
  await refresh(restarted);
  eq(fetches, 1, "fresh cache skips discovery across restart");
  eq(writes, 1, "reusing the cache does not advance the last successful check");
  ok(restarted.getModels().some((model) => model.id === visionId), "cached typed DeepSeek survives restart");

  fail = true;
  let refreshError: unknown;
  try { await refresh(restarted, true, true); } catch (error) { refreshError = error; }
  eq(fetches, 2, "forced refresh bypasses freshness");
  ok(refreshError instanceof Error && refreshError.message.includes("503"), "failed force refresh reports the server error");
  ok(stored === refreshed, "failed refresh leaves the stored snapshot unchanged");
  eq(writes, 1, "failed refresh does not touch the cache timestamp");
  ok(restarted.getModels().some((model) => model.id === visionId), "failed refresh retains the last known DeepSeek catalog");
} finally {
  globalThis.fetch = originalFetch;
}

report();

function report(): never {
  console.log(`credentials+provider: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.error(failures.map((f) => `  FAIL ${f}`).join("\n"));
    process.exit(1);
  }
  process.exit(0);
}
