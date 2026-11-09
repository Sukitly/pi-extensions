// Shared Command Code/OpenDesign usage lifecycle. No credential files or timers.
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

interface UsageConfig<T extends { fetchedAt: number }> {
  provider: string;
  widgetId: string;
  missingCredential: string;
  resolveKey(ctx: ExtensionContext): Promise<string | undefined>;
  // Optional sync identity lets a provider discard data on logout/account switch.
  credentialIdentity?(): string | undefined;
  fetchUsage(key: string, signal: AbortSignal): Promise<T>;
  widgetLine(usage: T, theme: Theme): string;
}
const MIN_REFRESH_MS = 3 * 60_000;
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function registerUsage<T extends { fetchedAt: number }>(pi: ExtensionAPI, config: UsageConfig<T>): void {
  let cached: T | undefined;
  let error: string | undefined;
  let activeProvider: string | null = null;
  let lifecycle = 0;
  let credentialEpoch = 0;
  let identity = config.credentialIdentity?.();
  let flight: { promise: Promise<void>; controller: AbortController; epoch: number } | undefined;
  let lastAttempt = 0;
  let unsubscribeAccounts: (() => void) | undefined;

  function checkIdentity(): void {
    if (!config.credentialIdentity) return;
    const next = config.credentialIdentity();
    if (next !== identity) {
      identity = next; credentialEpoch++; cached = undefined; error = undefined; lastAttempt = 0;
      flight?.controller.abort(); flight = undefined;
    }
  }
  function update(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
      checkIdentity();
      if (activeProvider !== config.provider || (config.credentialIdentity && identity === undefined) || (!cached && !error)) {
        ctx.ui.setWidget(config.widgetId, undefined); return;
      }
      ctx.ui.setWidget(config.widgetId, (_tui, theme) => new Text([
        cached ? config.widgetLine(cached, theme) : "",
        error ? theme.fg("error", `${config.provider} usage: refresh failed${cached ? " (stale data)" : ""} — ${error}`) : "",
      ].filter(Boolean).join("\n"), 0, 0), { placement: "belowEditor" });
    } catch (cause) {
      if (!String(cause).includes("ctx is stale")) console.error(`[${config.provider}] widget: ${message(cause)}`);
    }
  }
  async function refresh(ctx: ExtensionContext, force = false): Promise<void> {
    checkIdentity();
    if (config.credentialIdentity && identity === undefined) return;
    if (flight) return flight.promise;
    if (!force && !error && lastAttempt && Date.now() - lastAttempt < MIN_REFRESH_MS) return;
    const epoch = credentialEpoch;
    const controller = new AbortController();
    lastAttempt = Date.now();
    const work = (async () => {
      try {
        const key = await config.resolveKey(ctx);
        checkIdentity();
        if (epoch !== credentialEpoch || controller.signal.aborted) return;
        if (!key) throw new Error(config.missingCredential);
        const result = await config.fetchUsage(key, controller.signal);
        checkIdentity();
        if (epoch !== credentialEpoch || controller.signal.aborted) return;
        cached = result; error = undefined;
      } catch (cause) {
        if (epoch === credentialEpoch && !controller.signal.aborted) error = message(cause);
      }
    })();
    const current = { promise: work, controller, epoch };
    flight = current;
    try { await work; } finally { if (flight === current) flight = undefined; }
  }
  function background(ctx: ExtensionContext, force = false): void {
    const token = lifecycle;
    void refresh(ctx, force).then(() => {
      if (token === lifecycle && activeProvider === config.provider) update(ctx);
    }).catch(() => {});
  }
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    activeProvider = ctx.model?.provider ?? null;
    unsubscribeAccounts?.();
    unsubscribeAccounts = pi.events?.on("oauth-accounts:changed", (event) => {
      if ((event as { provider?: string } | null)?.provider !== config.provider) return;
      checkIdentity();
      update(ctx);
      if (activeProvider === config.provider) background(ctx, true);
    });
    update(ctx);
    if (activeProvider === config.provider) background(ctx, true);
  });
  pi.on("model_select", (event, ctx) => {
    activeProvider = event.model.provider; lifecycle++;
    update(ctx);
    if (activeProvider === config.provider && ctx.hasUI) background(ctx);
  });
  pi.on("agent_end", (_event, ctx) => {
    if (activeProvider === config.provider && ctx.hasUI) { update(ctx); background(ctx); }
  });
  pi.on("session_shutdown", () => {
    lifecycle++; credentialEpoch++; activeProvider = null; cached = undefined; error = undefined; lastAttempt = 0;
    flight?.controller.abort(); flight = undefined;
    unsubscribeAccounts?.(); unsubscribeAccounts = undefined;
  });

}
