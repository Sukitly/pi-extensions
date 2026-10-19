import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

// Stub only the TUI component; exercise the real fetch, state and lifecycle code.
const source = stripTypeScriptTypes(readFileSync(new URL("../usage-widget.ts", import.meta.url), "utf8"))
	.replace(/^import .*;$/gm, "")
	.replace("export default function", "return function");
const codexKey = `header.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }))}.signature`;
function harness({ provider = "anthropic", key = "sk-test-secret", fetch, credentials, oauth = false, hasUI = true } = {}) {
	const handlers = new Map();
	let widget = "";
	const extension = new Function("Text", "fetch", source)(class { constructor(text) { this.text = text; } }, fetch);
	extension({ on: (event, handler) => handlers.set(event, handler) });
	const ctx = {
		hasUI, model: { provider },
		modelRegistry: {
			getApiKeyForProvider: credentials ?? (async () => key),
			isUsingOAuth: () => oauth,
		},
		ui: { setWidget: (_id, factory) => { widget = factory ? factory({}, { fg: (_color, text) => text }).text : ""; } },
	};
	return {
		get text() { return widget; },
		setOAuth(value) { oauth = value; },
		async emit(event = "session_start", data = {}) {
			if (event === "model_select") ctx.model = data.model;
			handlers.get(event)(data, ctx);
			await new Promise(resolve => setImmediate(resolve));
		},
	};
}
const success = () => Response.json({ five_hour: { utilization: 25, resets_at: null } });

test("native OpenAI subscription shows an unavailable notice without resolving or sending credentials", async () => {
	let requests = 0;
	let credentialReads = 0;
	const h = harness({
		provider: "openai", oauth: true,
		credentials: async () => { credentialReads++; return codexKey; },
		fetch: async () => { requests++; return success(); },
	});
	for (const [event, data] of [
		["session_start", {}],
		["agent_end", {}],
		["model_select", { model: { provider: "openai" } }],
	]) {
		await h.emit(event, data);
		assert.match(h.text, /OpenAI subscription: quota query unavailable/);
		assert.match(h.text, /https:\/\/chatgpt\.com\/settings\/usage/);
		assert.doesNotMatch(h.text, /refresh failed|\d+%|5h:|7d:/);
	}
	assert.equal(requests, 0);
	assert.equal(credentialReads, 0);
});

test("OpenAI API keys and non-interactive sessions stay hidden without usage requests", async () => {
	let requests = 0;
	let credentialReads = 0;
	for (const options of [{ oauth: false }, { oauth: true, hasUI: false }]) {
		const h = harness({
			provider: "openai", ...options,
			credentials: async () => { credentialReads++; return codexKey; },
			fetch: async () => { requests++; return success(); },
		});
		await h.emit();
		await h.emit("agent_end");
		await h.emit("model_select", { model: { provider: "openai" } });
		assert.equal(h.text, "");
	}
	assert.equal(requests, 0);
	assert.equal(credentialReads, 0);
});

test("model switching isolates native OpenAI notices from cached legacy Codex quota", async () => {
	let requests = 0;
	const h = harness({
		provider: "openai-codex", key: codexKey, oauth: true,
		fetch: async () => {
			requests++;
			return Response.json({ rate_limit: { primary_window: { used_percent: 37, reset_at: 0 } } });
		},
	});
	await h.emit();
	assert.match(h.text, /5h:.*37%/);
	await h.emit("model_select", { model: { provider: "openai" } });
	assert.match(h.text, /quota query unavailable/);
	assert.doesNotMatch(h.text, /37%|5h:/);
	await h.emit("model_select", { model: { provider: "unsupported" } });
	assert.equal(h.text, "");
	await h.emit("model_select", { model: { provider: "openai-codex" } });
	assert.match(h.text, /5h:.*37%/);
	assert.equal(requests, 1);
});

test("OpenAI notices follow OAuth login and logout without caching the auth mode", async () => {
	const h = harness({ provider: "openai", oauth: true });
	await h.emit();
	assert.match(h.text, /quota query unavailable/);
	h.setOAuth(false);
	await h.emit("agent_end");
	assert.equal(h.text, "");
	h.setOAuth(true);
	await h.emit("model_select", { model: { provider: "openai" } });
	assert.match(h.text, /quota query unavailable/);
});

test("late Anthropic refresh cannot replace an OpenAI subscription notice", async () => {
	let resolve;
	const h = harness({ oauth: true, fetch: () => new Promise(r => { resolve = r; }) });
	await h.emit();
	await h.emit("model_select", { model: { provider: "openai" } });
	resolve(success());
	await new Promise(r => setImmediate(r));
	assert.match(h.text, /quota query unavailable/);
	assert.doesNotMatch(h.text, /25%/);
});

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

const antigravityQuotaPayload = {
	groups: [
		{
			displayName: "Gemini Models",
			buckets: [
				{
					bucketId: "gemini-weekly",
					displayName: "Weekly Limit Remaining",
					window: "weekly",
					resetTime: "2026-10-21T02:26:06Z",
					remainingFraction: 0.77342427,
				},
				{
					bucketId: "gemini-5h",
					displayName: "Five Hour Limit Remaining",
					window: "5h",
					resetTime: "2026-10-14T12:26:06Z",
					remainingFraction: 0.37902868,
				},
			],
		},
		{
			displayName: "Claude and GPT models",
			buckets: [
				{
					bucketId: "3p-weekly",
					displayName: "Weekly Limit Remaining",
					window: "weekly",
					resetTime: "2026-10-21T06:01:23Z",
					remainingFraction: 0.4792164,
				},
				{
					bucketId: "3p-5h",
					displayName: "Five Hour Limit Remaining",
					window: "5h",
					resetTime: "2026-10-14T11:01:23Z",
					remainingFraction: 0,
				},
			],
		},
	],
};

test("antigravity shows gemini usage and switches to claude usage when model changes", async () => {
	let requests = 0;
	let lastUrl = "";
	let lastHeaders = {};
	const h = harness({
		provider: "antigravity",
		key: JSON.stringify({ token: "ya29.test-secret-token", projectId: "test-project" }),
		fetch: async (url, options) => {
			requests++;
			lastUrl = url;
			lastHeaders = options?.headers ?? {};
			return Response.json(antigravityQuotaPayload);
		},
	});

	await h.emit("session_start", { model: { id: "gemini-3.8-flash", provider: "antigravity" } });
	assert.match(lastUrl, /retrieveUserQuotaSummary/);
	assert.equal(lastHeaders.Authorization, "Bearer ya29.test-secret-token");
	assert.match(lastHeaders["User-Agent"], /antigravity\/cli/);
	assert.match(h.text, /5h:.*62%/);
	assert.match(h.text, /7d:.*23%/);
	assert.equal(requests, 1);

	// Switch to Claude model in antigravity: should use cached groups without extra network call
	await h.emit("model_select", { model: { id: "claude-sonnet-4-6", provider: "antigravity" } });
	assert.match(h.text, /5h:.*100%/);
	assert.match(h.text, /7d:.*52%/);
	assert.equal(requests, 1);

	// Switch back to Gemini model: should return to Gemini usage immediately
	await h.emit("model_select", { model: { id: "gemini-3.7-flash", provider: "antigravity" } });
	assert.match(h.text, /5h:.*62%/);
	assert.match(h.text, /7d:.*23%/);
	assert.equal(requests, 1);
});

test("antigravity retries fallback endpoints on network failure", async () => {
	const calledUrls = [];
	const h = harness({
		provider: "antigravity",
		key: "ya29.raw-token",
		fetch: async (url) => {
			calledUrls.push(url);
			if (url.includes("daily-cloudcode-pa")) {
				throw new TypeError("daily endpoint network error");
			}
			return Response.json(antigravityQuotaPayload);
		},
	});
	await h.emit("session_start", { model: { id: "gemini-3.8-flash", provider: "antigravity" } });
	assert.equal(calledUrls.length, 2);
	assert.match(calledUrls[0], /daily-cloudcode-pa\.googleapis\.com/);
	assert.match(calledUrls[1], /cloudcode-pa\.googleapis\.com/);
	assert.match(h.text, /5h:.*62%/);
});

test("antigravity redacts ya29 tokens on subscription failure", async () => {
	const token = "ya29.a0AWY7Ckm-secret12345";
	const h = harness({
		provider: "antigravity",
		key: JSON.stringify({ token, projectId: "proj" }),
		fetch: async () => Response.json({
			error: { message: `denied ${token} Bearer ${token} license required (#3501)` },
		}, { status: 403, statusText: "Forbidden" }),
	});
	await h.emit("session_start", { model: { id: "gemini-3.8-flash", provider: "antigravity" } });
	assert.match(h.text, /antigravity usage: refresh failed.*HTTP 403 Forbidden.*license required/);
	assert.match(h.text, /\[redacted\]/);
	assert.doesNotMatch(h.text, new RegExp(token));
});

const opencodeGoUsagePayload = {
	usage: {
		rolling: {
			status: "ok",
			percent: 15,
			resetsAt: "2026-10-19T10:47:30.000Z",
		},
		weekly: {
			status: "ok",
			percent: 42,
			resetsAt: "2026-10-26T00:00:00.000Z",
		},
		monthly: {
			status: "ok",
			percent: 60,
			resetsAt: "2026-11-19T05:36:40.000Z",
		},
	},
};

test("opencode-go shows 5h, 7d and 30d usage windows", async () => {
	let requests = 0;
	let lastUrl = "";
	let lastHeaders = {};
	const key = "oc_sk_90102cca9a62_testKey123456";
	const h = harness({
		provider: "opencode-go",
		key,
		fetch: async (url, options) => {
			requests++;
			lastUrl = url;
			lastHeaders = options?.headers ?? {};
			return Response.json(opencodeGoUsagePayload);
		},
	});

	await h.emit("session_start", { model: { id: "claude-haiku-5-5", provider: "opencode-go" } });
	assert.match(lastUrl, /opencode\.ai\/zen\/go\/v1\/usage/);
	assert.equal(lastHeaders.Authorization, `Bearer ${key}`);
	assert.match(h.text, /5h:.*15%/);
	assert.match(h.text, /7d:.*42%/);
	assert.match(h.text, /30d:.*60%/);
	assert.equal(requests, 1);
});

test("opencode-go retries fallback endpoint on network failure", async () => {
	const calledUrls = [];
	const h = harness({
		provider: "opencode-go",
		key: "oc_sk_test",
		fetch: async (url) => {
			calledUrls.push(url);
			if (url.includes("/zen/go/v1/usage")) {
				throw new TypeError("zen endpoint network error");
			}
			return Response.json(opencodeGoUsagePayload);
		},
	});
	await h.emit("session_start", { model: { id: "claude-haiku-5-5", provider: "opencode-go" } });
	assert.equal(calledUrls.length, 2);
	assert.match(calledUrls[0], /zen\/go\/v1\/usage/);
	assert.match(calledUrls[1], /inference\/go\/v1\/usage/);
	assert.match(h.text, /5h:.*15%/);
	assert.match(h.text, /7d:.*42%/);
	assert.match(h.text, /30d:.*60%/);
});

test("opencode-go redacts oc_sk_ tokens on failure", async () => {
	const token = "oc_sk_90102cca9a62_secretToken";
	const h = harness({
		provider: "opencode-go",
		key: token,
		fetch: async () => Response.json({
			error: { message: `invalid token ${token} Bearer ${token}` },
		}, { status: 401, statusText: "Unauthorized" }),
	});
	await h.emit("session_start", { model: { id: "claude-haiku-5-5", provider: "opencode-go" } });
	assert.match(h.text, /opencode-go usage: refresh failed.*HTTP 401 Unauthorized.*invalid token/);
	assert.match(h.text, /\[redacted\]/);
	assert.doesNotMatch(h.text, new RegExp(token));
});
