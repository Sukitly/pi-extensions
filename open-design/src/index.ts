// OpenDesign-specific auth and usage adapters; catalog/UI/lifecycle are shared
// with Command Code. Credentials and streaming remain Pi-native.
import { readStoredCredential, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { createProvider, envApiKeyAuth, openAICompletionsApi, type Provider } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { buildChatCatalogIndex, matchGatewayModel, type ChatCatalogIndex } from "../../provider-shared/catalog.ts";
import { buildUsageWidgetLine } from "../../provider-shared/widget.ts";
import { registerUsage } from "../../provider-shared/usage-lifecycle.ts";
import { openDesignAccountAuth } from "./auth.ts";
import { fetchUsage, windowLabel, type OpenDesignUsage } from "./usage.ts";

export const PROVIDER_ID = "open-design";
export const BASE_URL = "https://amr-link.open-design.ai/v1";
export const MODEL_IDS = [
  ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash"],
  ["minimax-m3.1-flash", "MiniMax M3.1 Flash"],
  ["glm-5.3-flash", "GLM-5.3 Flash"],
] as const;

export function buildOpenDesignProvider(index?: ChatCatalogIndex): Provider {
  const catalog = index ?? buildChatCatalogIndex(getBuiltinProviders().flatMap((provider) => getBuiltinModels(provider)));
  const models = MODEL_IDS.map(([id, name]) => matchGatewayModel(
    { id, name, supported_endpoints: ["/chat/completions"] }, catalog, { provider: PROVIDER_ID, baseUrl: BASE_URL },
  )!.model);
  return createProvider({
    id: PROVIDER_ID,
    name: "OpenDesign",
    baseUrl: BASE_URL,
    auth: { apiKey: envApiKeyAuth("OpenDesign API key", ["OPEN_DESIGN_API_KEY"]), oauth: openDesignAccountAuth },
    models,
    api: { "openai-completions": openAICompletionsApi() },
  });
}

export const WIDGET_ID = "open-design-usage";
export function storedControlKey(): string | undefined {
  const credential = readStoredCredential(PROVIDER_ID);
  return credential?.type === "oauth" && typeof credential.controlKey === "string" && credential.controlKey
    ? credential.controlKey : undefined;
}
export function widgetLine(usage: OpenDesignUsage, theme: Theme, now = Date.now()): string {
  return buildUsageWidgetLine(usage.windows.map((w) => ({
    window: { used: Number(w.used), cap: Number(w.limit), resetAt: w.resetAt },
    label: windowLabel(w.durationSeconds), seconds: w.durationSeconds,
  })), theme, now);
}
export default function (pi: ExtensionAPI): void {
  pi.registerProvider(buildOpenDesignProvider());
  registerUsage(pi, {
    provider: PROVIDER_ID,
    widgetId: WIDGET_ID,
    missingCredential: "No OpenDesign account credential. Run /login open-design and choose account login; API keys do not expose usage.",
    resolveKey: async () => storedControlKey(),
    credentialIdentity: storedControlKey,
    fetchUsage,
    widgetLine,
  });
}
