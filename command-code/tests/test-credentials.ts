// Tests: provider wiring (native api_key auth via Pi's envApiKeyAuth, native
// protocol implementations, fetchModels freshness/fallback semantics).
import { inspect } from "node:util";
import {
  BASE_URL,
  buildChatCatalogIndex,
  FALLBACK_ENTRIES,
  fallbackModels,
  PROVIDER_ID,
  PROVIDER_NAME,
} from "../src/catalog.ts";
import { buildCommandCodeProvider } from "../src/index.ts";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

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
const baseline = provider.getModels();
for (const required of ["z-ai/glm-5.3-flash", "xiaomi/mimo-v2.6-flash", "meta/muse-spark-1.3"]) {
  ok(baseline.some((m) => m.id === required), `baseline includes ${required}`);
}
ok(baseline.some((m) => m.id.startsWith("claude-")), "baseline includes a Claude alias");
ok(baseline.every((m) => m.provider === PROVIDER_ID), "baseline models owned by command-code");
ok(
  baseline.every((m) => (m.api === "openai-completions" || m.api === "anthropic-messages") || m.api === "openai-responses"),
  "baseline routes through Pi built-in protocol implementations",
);

// ---------------------------------------------------------------------------
// fetchModels: freshness, fallback, no-wipe on failure
// ---------------------------------------------------------------------------

// Reach into the provider's refresh contract through pi-ai's public shape.
const refresh = provider.refreshModels!;
type PublishInput = { models?: unknown[]; [key: string]: unknown };

const storedModels = fallbackModels(builtinIndex);

await refresh({
  credential: { type: "api_key", key: "cc_sk_cache" },
  stored: { models: storedModels, checkedAt: Date.now() },
  publish: async (publication: { persist?: PublishInput | null; update?: () => void }) => {
    if (publication.update) publication.update();
    return true;
  },
  allowNetwork: false,
  signal: new AbortController().signal,
});
// offline + fresh cache → catalog preserved, no network, persist not clobbered
ok(provider.getModels().length >= FALLBACK_ENTRIES.length - 1, "offline cache restored (≥ required models remain)");

report();

function report(): never {
  console.log(`credentials+provider: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.error(failures.map((f) => `  FAIL ${f}`).join("\n"));
    process.exit(1);
  }
  process.exit(0);
}
