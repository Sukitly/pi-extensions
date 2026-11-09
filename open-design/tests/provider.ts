import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai/models";
import { buildChatCatalogIndex, matchGatewayModel } from "../../provider-shared/catalog.ts";
import { getBuiltinProviders, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import extension, { BASE_URL, buildOpenDesignProvider, MODEL_IDS, PROVIDER_ID } from "../src/index.ts";

const provider = buildOpenDesignProvider();
assert.equal(provider.id, PROVIDER_ID);
assert.equal(provider.baseUrl, BASE_URL);
assert.deepEqual(provider.getModels().map((model) => model.id), MODEL_IDS.map(([id]) => id));
assert.ok(provider.getModels().every((model) =>
  model.provider === PROVIDER_ID && model.baseUrl === BASE_URL && model.api === "openai-completions" &&
  Object.values(model.cost).every((cost) => cost === 0),
));
const index = buildChatCatalogIndex(getBuiltinProviders().flatMap((p) => getBuiltinModels(p)));
for (const [id, name] of MODEL_IDS) {
  const expected = matchGatewayModel({ id, name, supported_endpoints: ["/chat/completions"] }, index, { provider: PROVIDER_ID, baseUrl: BASE_URL })!.model;
  const model = provider.getModels().find((m) => m.id === id)!;
  assert.deepEqual(model, expected, "OpenDesign uses the same shared model adapter as Command Code");
  assert.equal(model.reasoning, true);
  assert.ok(model.contextWindow > 128000);
}
let registered: unknown;
extension({ registerProvider: (value: unknown) => { registered = value; }, on: () => {}, registerCommand: () => {} } as never);
assert.equal((registered as typeof provider).id, PROVIDER_ID);

const auth = provider.auth.apiKey!;
assert.equal(auth.name, "OpenDesign API key");
const signal = new AbortController().signal;
const context = (value?: string) => ({ env: async (name: string) => name === "OPEN_DESIGN_API_KEY" ? value : undefined, fileExists: async () => false });
assert.deepEqual(await auth.resolve({ ctx: context("test-key"), signal }), {
  auth: { apiKey: "test-key" }, source: "OPEN_DESIGN_API_KEY",
});
assert.equal(await auth.resolve({ ctx: context(), signal }), undefined);
let promptType = "";
const credential = await auth.login!({ signal, prompt: async (prompt) => { promptType = prompt.type; return "prompted-key"; }, notify: () => {} });
assert.equal(promptType, "secret");
assert.deepEqual(credential, { type: "api_key", key: "prompted-key" });

// Exercise Pi's real transport against a fake fetch, never the real gateway.
const originalFetch = globalThis.fetch;
let observed: { url: string; headers: Headers; body: any } | undefined;
let mode: "text" | "tool" | "error" = "text";
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  observed = { url: request.url, headers: request.headers, body: await request.json() };
  if (mode === "error") return new Response(JSON.stringify({ error: { message: "invalid API key" } }), { status: 401, headers: { "content-type": "application/json" } });
  const delta = mode === "text" ? { role: "assistant", content: "你好" } : {
    role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } }],
  };
  const finish = mode === "text" ? "stop" : "tool_calls";
  const chunks = [
    { id: "mock", object: "chat.completion.chunk", created: 1, model: observed.body.model, choices: [{ index: 0, delta, finish_reason: null }] },
    { id: "mock", object: "chat.completion.chunk", created: 1, model: observed.body.model, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    { id: "mock", object: "chat.completion.chunk", created: 1, model: observed.body.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  ];
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;

try {
  const models = createModels();
  models.setProvider(provider);
  for (const model of provider.getModels()) {
    const stream = models.streamSimple(model, { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] }, { apiKey: "fake-key" });
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.ok(result.content.some((block) => block.type === "text" && block.text === "你好"));
    assert.ok(events.some((event) => event.type === "text_delta"));
    assert.equal(observed?.url, `${BASE_URL}/chat/completions`);
    assert.equal(observed?.headers.get("authorization"), "Bearer fake-key");
    assert.equal(observed?.body.model, model.id);
    assert.equal(observed?.body.stream, true);
  }
  mode = "tool";
  const stream = models.streamSimple(provider.getModels()[0]!, {
    messages: [{ role: "user", content: "read the file", timestamp: Date.now() }],
    tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
  }, { apiKey: "fake-key" });
  const result = await stream.result();
  assert.equal(result.stopReason, "toolUse", result.errorMessage);
  assert.ok(result.content.some((block) => block.type === "toolCall" && block.name === "read" && block.arguments.path === "a.txt"));
  assert.equal(observed?.body.tools[0].function.name, "read");
  mode = "text";
  const followup = await models.streamSimple(provider.getModels()[0]!, {
    messages: [
      { role: "user", content: "read the file", timestamp: Date.now() }, result,
      { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: Date.now() },
    ],
    tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
  }, { apiKey: "fake-key" }).result();
  assert.equal(followup.stopReason, "stop", followup.errorMessage);
  assert.ok(observed?.body.messages.some((message: any) => message.role === "tool" && message.tool_call_id === "call_1"));

  mode = "error";
  const rejected = await models.streamSimple(provider.getModels()[0]!, {
    messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
  }, { apiKey: "fake-key" }).result();
  assert.equal(rejected.stopReason, "error");
  assert.match(rejected.errorMessage ?? "", /invalid API key/i);
} finally {
  globalThis.fetch = originalFetch;
}
console.log("OpenDesign provider tests passed (mock transport only)");
