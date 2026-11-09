import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, readStoredCredential, getAgentDir } from "@earendil-works/pi-coding-agent";
import extension, { buildOpenDesignProvider, PROVIDER_ID, storedControlKey, widgetLine } from "../src/index.ts";
import { deviceLogin, deviceCredential, CONTROL_BASE, UNKNOWN_EXPIRY } from "../src/auth.ts";
import { fetchUsage, formatUsage, parseUsage } from "../src/usage.ts";
import { buildCommandCodeWidgetLine } from "../../command-code/src/widget.ts";
import { parseCredits } from "../../command-code/src/usage.ts";
const theme = { fg: (_color: string, value: string) => value } as any;

const directory = mkdtempSync(join(tmpdir(), "pi-open-design-test-"));
const authPath = join(directory, "auth.json");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = directory;
assert.equal(getAgentDir(), directory);
const originalFetch = globalThis.fetch;
const requests: Array<{ url: string; authorization: string | null; body?: any }> = [];
let mode: "login" | "usage" | "unauthorized" | "invalid-url" | "partial" = "login";
const now = Date.now();
const billing = {
  workspaceId: "ws1", balanceUsd: "1.25",
  codingPlan: { workspaceId: "ws1", tier: "go", windows: [
    { durationSeconds: 18000, usedCredits: "200", limitCredits: "1000", remainingCredits: "800", resetsAt: new Date(now + 3600000).toISOString() },
    { durationSeconds: 604800, usedCredits: "400", limitCredits: "2000", remainingCredits: "1600", resetsAt: null },
  ] },
};
try {
  const payload = { runtimeKey: "mapped-runtime", controlKey: "mapped-control", controlKeyId: "control-id", refreshToken: "issued-refresh", expiresAt: new Date(Date.now() + 5000).toISOString(), user: { id: "user-1", email: "one@example.com", name: "One" }, deviceSecret: "not-a-credential", token: "not-a-refresh-token" };
  const mapped = deviceCredential(payload);
  assert.equal(mapped.refresh, "issued-refresh");
  assert.equal(mapped.expires, UNKNOWN_EXPIRY, "device authorization expiry must not expire the runtime key");
  assert.equal(mapped.accountId, "user-1");
  assert.equal(mapped.email, "one@example.com");
  assert.equal(mapped.controlKeyId, "control-id");
  assert.equal(mapped.refreshable, false);
  assert.equal(mapped.deviceSecret, undefined);
  assert.equal(mapped.token, undefined);
  assert.equal(deviceCredential({ runtimeKey: "runtime", controlKey: "control", refresh_token: "snake-refresh" }).refresh, "snake-refresh");
  assert.equal(deviceCredential({ runtimeKey: "runtime", controlKey: "control", runtimeKeyExpiresAt: "2027-01-01T00:00:00Z" }).expires, Date.parse("2027-01-01T00:00:00Z"));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const body = req.method === "POST" ? await req.json() : undefined;
    requests.push({ url: req.url, authorization: req.headers.get("authorization"), body });
    if (req.url === "https://amr-link.open-design.ai/v1/chat/completions") {
      const chunk = { id: "mock", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    if (req.url === `${CONTROL_BASE}/cli/device-authorizations`) return Response.json({
      deviceId: "id/1", deviceSecret: "device-secret", userCode: "123456", activationUrl: mode === "invalid-url" ? "https://evil.example/" : "https://open-design.ai/device", pollIntervalSeconds: 0.001, expiresAt: new Date(Date.now() + 10000).toISOString(),
    });
    if (req.url === `${CONTROL_BASE}/cli/device-authorizations/id%2F1/token`) return Response.json(mode === "partial" ? { controlKey: "control-secret" } : { controlKey: "control-secret", runtimeKey: "runtime-secret", controlKeyId: "key-id", user: { id: "native-user", email: "native@example.com" } });
    if (req.url === `${CONTROL_BASE}/workspaces/current`) return mode === "unauthorized" ? new Response("secret body", { status: 401 }) : Response.json({ activeWorkspaceId: "ws1" });
    if (req.url === `${CONTROL_BASE}/workspaces/ws1/billing/preflight`) return Response.json(billing);
    throw new Error(`unexpected test URL: ${req.url}`);
  }) as typeof fetch;

  const runtime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(buildOpenDesignProvider());
  const notifications: any[] = [];
  const credential = await runtime.login(PROVIDER_ID, "oauth", { prompt: async () => { throw new Error("unexpected prompt"); }, notify: (event) => notifications.push(event) });
  assert.equal(credential.type, "oauth");
  assert.equal(readStoredCredential(PROVIDER_ID, authPath)?.type, "oauth");
  assert.equal((readStoredCredential(PROVIDER_ID, authPath) as any).controlKey, "control-secret");
  assert.equal(storedControlKey(), "control-secret");
  assert.equal((credential as any).expires, UNKNOWN_EXPIRY);
  assert.equal(readStoredCredential(PROVIDER_ID, authPath)?.accountId, "native-user");
  assert.equal(readStoredCredential(PROVIDER_ID, authPath)?.email, "native@example.com");
  assert.equal(readStoredCredential(PROVIDER_ID, authPath)?.controlKeyId, "key-id");
  assert.ok(notifications.some((event) => event.type === "device_code" && event.userCode === "123456"));
  assert.ok(!JSON.stringify(notifications).includes("secret"));
  const resolved = await runtime.getAuth(PROVIDER_ID);
  assert.equal(resolved?.auth.apiKey, "runtime-secret");
  assert.ok(!JSON.stringify(resolved).includes("control-secret"), "control key is never model auth");
  assert.deepEqual(requests[1]?.body, { deviceSecret: "device-secret" });
  const model = runtime.getModel(PROVIDER_ID, "deepseek-v4.1-flash")!;
  const answer = await runtime.streamSimple(model, { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] }).result();
  assert.equal(answer.stopReason, "stop", answer.errorMessage);
  assert.equal(requests.at(-1)?.authorization, "Bearer runtime-secret");
  assert.ok(!JSON.stringify(requests.at(-1)).includes("control-secret"));

  mode = "usage";
  const usage = await fetchUsage("control-secret");
  assert.equal(usage.windows.length, 2);
  assert.ok(Math.abs((usage.windows[0]?.percentUsed ?? 0) - 20) < 1e-9);
  assert.equal(usage.windows[1]?.resetAt, undefined);
  assert.match(widgetLine(usage, theme), /5h: \[██░{8}\] 20%/);
  assert.match(widgetLine(usage, theme), /7d: \[██░{8}\] 20%/);
  const equivalent = parseCredits({ windowLimits: {
    fiveHour: { used: 200, cap: 1000, resetAt: usage.windows[0]!.resetAt },
    weekly: { used: 400, cap: 2000 },
  } });
  assert.equal(widgetLine(usage, theme, now), buildCommandCodeWidgetLine(equivalent, theme, now), "same data renders identically for both providers");
  assert.match(formatUsage(usage), /Balance: \$1.25/);
  assert.ok(requests.slice(-2).every((request) => request.authorization === "Bearer control-secret"));

  const handlers = new Map<string, Function>();
  let widget = "";
  extension({ registerProvider: () => {}, on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: () => {} } as never);
  const ctx = { hasUI: true, model: { provider: PROVIDER_ID }, ui: {
    setWidget: (_id: string, factory: any) => { widget = factory ? factory({}, theme).render(300).join("\n") : ""; },
  } };
  handlers.get("session_start")!({}, ctx);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(widget, /5h:.*20%/);
  handlers.get("model_select")!({ model: { provider: "elsewhere" } }, ctx);
  assert.equal(widget, "");
  handlers.get("session_shutdown")!();
  mode = "usage";

  assert.throws(() => parseUsage({ ...billing, workspaceId: "other" }, "ws1"), /different workspace/);
  assert.throws(() => parseUsage({ workspaceId: "ws1", codingPlan: { windows: [] } }, "ws1"), /no usable/);
  const onlyValid = parseUsage({ ...billing, codingPlan: { ...billing.codingPlan, windows: [billing.codingPlan.windows[0], { durationSeconds: 1, usedCredits: "0", limitCredits: "0", remainingCredits: "0" }] } }, "ws1");
  assert.equal(onlyValid.windows.length, 1);
  mode = "unauthorized";
  await assert.rejects(fetchUsage("control-secret"), (error: Error) => /HTTP 401/.test(error.message) && !error.message.includes("secret"));

  await runtime.logout(PROVIDER_ID);
  assert.equal(readStoredCredential(PROVIDER_ID, authPath), undefined);
  assert.equal(storedControlKey(), undefined);
  assert.equal(await runtime.getAuth(PROVIDER_ID), undefined);
  mode = "invalid-url";
  await assert.rejects(deviceLogin({ signal: new AbortController().signal, notify: () => {}, prompt: async () => "" }), /untrusted/);
  mode = "login";
  const abort = new AbortController();
  const promise = deviceLogin({ signal: abort.signal, notify: () => {}, prompt: async () => "" });
  setTimeout(() => abort.abort(), 30);
  await assert.rejects(promise, /abort/i);
  mode = "partial";
  await assert.rejects(deviceLogin({ signal: new AbortController().signal, notify: () => {}, prompt: async () => "" }), /both runtime and control/);
} finally {
  globalThis.fetch = originalFetch;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(directory, { recursive: true, force: true });
}
console.log("OpenDesign account, native storage and usage tests passed (mock network)");
