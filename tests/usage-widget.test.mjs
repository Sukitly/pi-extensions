import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

// Stub only the TUI component; exercise the real fetch, state and lifecycle code.
const source = stripTypeScriptTypes(readFileSync(new URL("../usage-widget.ts", import.meta.url), "utf8"))
	.replace(/^import .*;$/gm, "")
	.replace("export default function", "return function");
const codexKey = `header.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }))}.signature`;
function harness({ provider = "anthropic", key = "sk-test-secret", fetch, credentials } = {}) {
	const handlers = new Map();
	let widget = "";
	const extension = new Function("Text", "fetch", source)(class { constructor(text) { this.text = text; } }, fetch);
	extension({ on: (event, handler) => handlers.set(event, handler) });
	const ctx = {
		hasUI: true, model: { provider },
		modelRegistry: { getApiKeyForProvider: credentials ?? (async () => key) },
		ui: { setWidget: (_id, factory) => { widget = factory ? factory({}, { fg: (_color, text) => text }).text : ""; } },
	};
	return {
		get text() { return widget; },
		async emit(event = "session_start", data = {}) {
			handlers.get(event)(data, ctx);
			await new Promise(resolve => setImmediate(resolve));
		},
	};
}
const success = () => Response.json({ five_hour: { utilization: 25, resets_at: null } });

test("shows HTTP status and API message, redacts credentials and bounds terminal text", async () => {
	const h = harness({ fetch: async () => Response.json({ error: { message: `denied sk-test-secret Bearer another-secret\n\u001b[31m${"x".repeat(500)}` } }, { status: 401, statusText: "Unauthorized" }) });
	await h.emit();
	assert.match(h.text, /anthropic usage: refresh failed.*HTTP 401 Unauthorized: denied/);
	assert.match(h.text, /\[redacted\]/);
	assert.doesNotMatch(h.text, /sk-test-secret|another-secret|[\n\u001b]/);
	assert.ok(h.text.length < 400);
	assert.ok(h.text.endsWith("…"));
});

test("Codex shows non-JSON API errors", async () => {
	const h = harness({ provider: "openai-codex", key: codexKey, fetch: async () => new Response("upstream unavailable", { status: 503 }) });
	await h.emit();
	assert.match(h.text, /openai-codex usage:.*HTTP 503.*upstream unavailable/);
});

test("reports network causes, timeout, invalid JSON and missing credentials", async () => {
	for (const [options, expected] of [
		[{ fetch: async () => { throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") }); } }, /fetch failed.*ECONNRESET/],
		[{ fetch: async () => { throw new DOMException("request timed out", "TimeoutError"); } }, /TimeoutError.*timed out/],
		[{ fetch: async () => new Response("not json") }, /Invalid usage JSON response/],
		[{ key: undefined, credentials: async () => undefined }, /No API credentials/],
		[{ credentials: async () => { throw new Error("credential refresh failed"); } }, /credential refresh failed/],
		[{ provider: "openai-codex", key: "invalid" }, /Missing ChatGPT account ID/],
	]) {
		const h = harness(options);
		await h.emit();
		assert.match(h.text, expected);
	}
});

test("retains old data on failure and clears errors after recovery", async () => {
	let fail = false;
	const h = harness({ fetch: async () => fail ? new Response("rate limited", { status: 429 }) : success() });
	await h.emit();
	assert.match(h.text, /25%/);
	fail = true;
	await h.emit(); // Session start forces a refresh, even with a recent cache.
	assert.match(h.text, /25%/);
	assert.match(h.text, /refresh failed \(stale data\).*HTTP 429.*rate limited/);
	fail = false;
	await h.emit("agent_end");
	assert.match(h.text, /25%/);
	assert.doesNotMatch(h.text, /refresh failed|429/);
});

test("HTTP status survives an unreadable error body", async () => {
	const h = harness({ fetch: async () => ({ ok: false, status: 502, statusText: "Bad Gateway", text: async () => { throw new Error("body failure"); } }) });
	await h.emit();
	assert.match(h.text, /HTTP 502 Bad Gateway/);
});

test("late failures do not overwrite another provider or a shut down session", async () => {
	for (const event of ["model_select", "session_shutdown"]) {
		let reject;
		const h = harness({ fetch: () => new Promise((_resolve, r) => { reject = r; }) });
		await h.emit();
		await h.emit(event, { model: { provider: "unsupported" } });
		reject(new Error("late failure"));
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(h.text, "");
	}
});
