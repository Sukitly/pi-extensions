// Exercise the Command Code widget with Pi's component-factory setWidget contract.
import { match, ok, strictEqual, doesNotMatch } from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import commandCode, { WIDGET_ID } from "../src/index.ts";
import { parseCredits } from "../src/usage.ts";
import { buildCommandCodeWidgetLine } from "../src/widget.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;
const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => void>>();
let usageCommand: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
let widget = "";
let placement = "";
let widgetId = "";

commandCode({
  registerProvider: () => {},
  on: (name: string, handler: (event: any, ctx: ExtensionContext) => void) => {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    return () => {};
  },
  registerCommand: (name: string, command: { handler: typeof usageCommand }) => {
    if (name === "command-code.usage") usageCommand = command.handler;
  },
} as unknown as ExtensionAPI);

ok(usageCommand, "usage command registered");
const ctx = {
  hasUI: true,
  model: { provider: "command-code" },
  modelRegistry: { getApiKeyForProvider: async () => "cc_sk_test" },
  ui: {
    notify: () => {},
    setWidget: (id: string, content: ((tui: unknown, theme: Theme) => { render(width: number): string[] }) | undefined, options?: { placement?: string }) => {
      widgetId = id;
      placement = options?.placement ?? "";
      strictEqual(content === undefined || typeof content === "function", true, "Pi widget accepts a factory, not plain text");
      widget = content ? content({}, theme).render(300).join("\n") : "";
    },
  },
} as unknown as ExtensionCommandContext;

function emit(name: string, event: unknown = {}): void {
  for (const handler of handlers.get(name) ?? []) handler(event, ctx);
}

const originalFetch = globalThis.fetch;
const now = Date.now();
try {
  globalThis.fetch = async () => Response.json({
    windowLimits: {
      fiveHour: { used: 2, cap: 10, resetAt: now + 2 * 60 * 60 * 1000 },
      weekly: { used: 8, cap: 100, resetAt: now + 3 * 24 * 60 * 60 * 1000 },
    },
    credits: { monthlyCredits: 42 },
  });
  emit("session_start");
  await new Promise(resolve => setImmediate(resolve));
  strictEqual(widgetId, WIDGET_ID);
  strictEqual(placement, "belowEditor");
  match(widget, /5h: \[██░{8}\] 20% ~ \d{2}:\d{2}/);
  match(widget, /7d: \[█░{9}\] 8% ~ (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{2}:\d{2} ▼/);
  match(widget, /Monthly: 42 credits left/);
  doesNotMatch(widget, /unknown|resets in/);

  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  await usageCommand("", ctx);
  match(widget, /20%.*8%.*42 credits left/);
  match(widget, /refresh failed \(stale data\).*503/);

  emit("model_select", { model: { provider: "other" } });
  strictEqual(widget, "", "switching provider hides the widget");

  let finishRefresh: ((response: Response) => void) | undefined;
  globalThis.fetch = () => new Promise<Response>(resolve => { finishRefresh = resolve; });
  emit("model_select", { model: { provider: "command-code" } });
  await new Promise(resolve => setImmediate(resolve));
  ok(finishRefresh, "switching back retries after the failure");
  emit("model_select", { model: { provider: "other" } });
  finishRefresh(Response.json({ credits: { monthlyCredits: 99 } }));
  await new Promise(resolve => setImmediate(resolve));
  strictEqual(widget, "", "a late refresh cannot redraw the old provider's widget");

  const monthlyOnly = buildCommandCodeWidgetLine(parseCredits({ credits: { monthlyCredits: 70 } }), theme);
  strictEqual(monthlyOnly, "Monthly: 70 credits left", "missing windows do not fabricate zero-percent bars");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("widget: passed");
