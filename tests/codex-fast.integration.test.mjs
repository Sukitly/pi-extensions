import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";

const root = join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const compatUrl = pathToFileURL(join(root, "node_modules/@earendil-works/pi-ai/dist/compat.js")).href;
const extensionPath = join(dirname(fileURLToPath(import.meta.url)), "../codex-fast.ts");
const extensionUrl = pathToFileURL(extensionPath).href;
const loader = registerHooks({
	resolve(specifier, context, nextResolve) {
		return nextResolve(specifier === "@earendil-works/pi-ai/compat" ? compatUrl : specifier, context);
	},
});
const { default: codexFastExtension, readFastState, writeFastState } = await import(extensionUrl);
loader.deregister();
const { openAICodexResponsesApi } = await import(compatUrl);
const nativeCodex = openAICodexResponsesApi();
const { generateSummaryWithUsage } = await import(pathToFileURL(join(root, "dist/core/compaction/compaction.js")));
const { generateBranchSummary } = await import(pathToFileURL(join(root, "dist/core/compaction/branch-summarization.js")));

// All filesystem writes are isolated here. Failed files are kept for diagnosis;
// tests never copy real credentials, modify the live preference, or delete files.
function sandbox() {
	const directory = fs.mkdtempSync(join(tmpdir(), "pi-codex-fast-integration-"));
	return { directory, statePath: join(directory, "codex-fast.json") };
}

const fakeToken = `test.${Buffer.from(JSON.stringify({
	"https://api.openai.com/auth": { chatgpt_account_id: "integration-test" },
})).toString("base64url")}.test`;
const model = {
	id: "gpt-5.5", name: "Integration fixture", api: "openai-codex-responses", provider: "openai-codex",
	baseUrl: "https://mock.invalid", reasoning: true, thinkingLevelMap: { max: "max", xhigh: "xhigh" },
	input: ["text"], contextWindow: 10000000, maxTokens: 512,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};
const userMessage = { role: "user", content: "Test", timestamp: 0 };
const context = { systemPrompt: "Integration fixture", messages: [userMessage] };

function harness(directory) {
	const handlers = new Map();
	const commands = new Map();
	const providers = new Map();
	const notifications = [];
	let hookCalls = 0;
	const ctx = {
		mode: "rpc", model,
		ui: { notify: (message, level) => notifications.push({ message, level }) },
	};
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		codexFastExtension({
			on: (name, callback) => handlers.set(name, callback),
			registerCommand: (name, command) => commands.set(name, command),
			registerProvider: (name, config) => providers.set(name, config),
		});
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
	return {
		notifications,
		hookCalls: () => hookCalls,
		run: args => commands.get("fast").handler(args, ctx),
		onPayload: payload => {
			hookCalls++;
			return handlers.get("before_provider_request")({ payload }, ctx);
		},
		stream: providers.get("openai-codex").streamSimple,
	};
}

function mockHttp(returnedTier = "default") {
	const requests = [];
	let responseCallbacks = 0;
	const options = {
		apiKey: fakeToken, transport: "sse", reasoning: "max", maxRetries: 0,
		headers: { "x-integration-test": "preserved" },
		onResponse: () => { responseCallbacks++; },
		fetch: async (_url, request) => {
			const body = request.headers.get("content-encoding") === "zstd"
				? zstdDecompressSync(request.body).toString("utf8") : request.body;
			requests.push(JSON.parse(body));
			assert.equal(request.headers.get("x-integration-test"), "preserved");
			const item = { type: "message", id: "message-test", role: "assistant", content: [{ type: "output_text", text: "Summary." }] };
			const response = {
				id: "response-test", status: "completed", output: [item],
				usage: { input_tokens: 1000000, output_tokens: 1000000, total_tokens: 2000000 },
				...(returnedTier === "missing" ? {} : { service_tier: returnedTier }),
			};
			const events = [
				{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
				{ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
				{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Summary." },
				{ type: "response.output_item.done", output_index: 0, item },
				{ type: "response.completed", response },
			];
			return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
				status: 200, headers: { "content-type": "text/event-stream" },
			});
		},
	};
	return { requests, options, responseCallbacks: () => responseCallbacks };
}

async function resultOf(stream) {
	const result = await stream.result();
	assert.notEqual(result.stopReason, "error", result.errorMessage);
	assert.equal(result.content.find(block => block.type === "text")?.text, "Summary.");
	return result;
}

function waitMessage(child, type) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error(`Child did not send ${type}`)), 20000);
		const onMessage = message => { if (message.type === type) finish(undefined, message); };
		const onExit = code => finish(new Error(`Child exited ${code} before ${type}`));
		const onError = error => finish(error);
		function finish(error, value) {
			clearTimeout(timer);
			child.off("message", onMessage);
			child.off("exit", onExit);
			child.off("error", onError);
			if (error) reject(error); else resolve(value);
		}
		child.on("message", onMessage);
		child.on("exit", onExit);
		child.on("error", onError);
	});
}

const readerProgram = `
import { registerHooks } from 'node:module';
const loader = registerHooks({ resolve(s, c, next) { return next(s === '@earendil-works/pi-ai/compat' ? process.env.TEST_COMPAT_URL : s, c); } });
const { default: extension } = await import(process.env.TEST_EXTENSION_URL);
loader.deregister();
const handlers = new Map();
extension({ on: (n, h) => handlers.set(n, h), registerCommand() {}, registerProvider() {} });
const ctx = { mode: 'rpc', model: { provider: 'openai-codex' }, ui: { notify() {} } };
let reads = 0, misses = 0, running = true, started = false;
function batch() {
  for (let i = 0; i < 128; i++) {
    const result = handlers.get('before_provider_request')({ payload: {} }, ctx);
    reads++;
    if (result?.service_tier !== 'priority') misses++;
  }
  if (!started) { started = true; process.send({ type: 'started' }); }
  if (running) setImmediate(batch);
  else { process.send({ type: 'done', reads, misses }); process.disconnect(); }
}
process.on('message', m => { if (m.type === 'start') batch(); if (m.type === 'stop') running = false; });
process.send({ type: 'ready' });
`;

test("real concurrent sessions never lose priority while another session repeatedly publishes ON", { timeout: 30000 }, async (t) => {
	const { directory, statePath } = sandbox();
	writeFastState(statePath, true);
	const writer = harness(directory);
	const readers = Array.from({ length: 2 }, () => spawn(process.execPath, ["--input-type=module", "-e", readerProgram], {
		env: { ...process.env, PI_CODING_AGENT_DIR: directory, TEST_COMPAT_URL: compatUrl, TEST_EXTENSION_URL: extensionUrl },
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	}));
	t.after(() => { for (const child of readers) if (child.exitCode === null && !child.killed) child.kill("SIGTERM"); });
	await Promise.all(readers.map(child => waitMessage(child, "ready")));
	const started = readers.map(child => waitMessage(child, "started"));
	readers.forEach(child => child.send({ type: "start" }));
	await Promise.all(started);
	for (let i = 0; i < 500; i++) await writer.run("on");
	const done = readers.map(child => waitMessage(child, "done"));
	readers.forEach(child => child.send({ type: "stop" }));
	for (const result of await Promise.all(done)) {
		assert.ok(result.reads >= 256, `Expected actual concurrent reads, got ${result.reads}`);
		assert.equal(result.misses, 0, JSON.stringify(result));
	}
	assert.deepEqual(readFastState(statePath), { enabled: true });
	assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
	assert.deepEqual(fs.readdirSync(directory), ["codex-fast.json"]);
});

for (const failure of ["partial write", "fsync", "close", "rename"]) {
	test(`${failure} failure preserves the previous real file and leaves the unpublished file inspectable`, (t) => {
		const { directory, statePath } = sandbox();
		writeFastState(statePath, true);
		const original = fs.readFileSync(statePath, "utf8");
		if (failure === "partial write") {
			t.mock.method(fs, "writeFileSync", fd => {
				assert.equal(typeof fd, "number");
				fs.writeSync(fd, '{"enabled":');
				assert.equal(fs.readFileSync(statePath, "utf8"), original, "Partial bytes must never touch the published path");
				throw new Error("injected partial-write failure");
			});
		} else if (failure === "close") {
			const close = fs.closeSync;
			t.mock.method(fs, "closeSync", fd => { close(fd); throw new Error("injected close failure"); });
		} else {
			t.mock.method(fs, failure === "fsync" ? "fsyncSync" : "renameSync", () => { throw new Error(`injected ${failure} failure`); });
		}
		assert.throws(() => writeFastState(statePath, false), /injected.*Unpublished temporary file/);
		t.mock.restoreAll();
		assert.equal(fs.readFileSync(statePath, "utf8"), original);
		assert.deepEqual(readFastState(statePath), { enabled: true });
		assert.equal(fs.readdirSync(directory).filter(name => name.endsWith(".tmp")).length, 1);
	});
}

for (const returnedTier of ["priority", "default", "missing"]) {
	test(`SDK cost matches native serviceTier when the response tier is ${returnedTier}`, async () => {
		const { directory } = sandbox();
		const h = harness(directory);
		await h.run("on");
		const actualHttp = mockHttp(returnedTier);
		const options = { ...actualHttp.options, onPayload: h.onPayload };
		const actual = await resultOf(h.stream(model, context, options));
		const expectedHttp = mockHttp(returnedTier);
		const expected = await resultOf(nativeCodex.stream(model, context, {
			...expectedHttp.options, reasoningEffort: "max", serviceTier: "priority",
		}));
		assert.equal(actualHttp.requests[0].service_tier, "priority");
		assert.equal(expectedHttp.requests[0].service_tier, "priority");
		assert.equal(actual.usage.cost.total, 7.5);
		assert.deepEqual(actual.usage, expected.usage);
		assert.deepEqual(actualHttp.requests[0].reasoning, { effort: "max", summary: "auto" });
		assert.equal(actualHttp.responseCallbacks(), 1);
		assert.equal(options.serviceTier, undefined, "Do not mutate the caller's options");
	});
}

test("OFF preserves an omitted tier and a tier supplied by another hook", async () => {
	const { directory } = sandbox();
	const h = harness(directory);
	await h.run("off");
	const plain = mockHttp();
	const result = await resultOf(h.stream(model, context, { ...plain.options, onPayload: h.onPayload }));
	assert.equal(Object.hasOwn(plain.requests[0], "service_tier"), false);
	assert.equal(result.usage.cost.total, 3);
	const custom = mockHttp();
	const customResult = await resultOf(h.stream(model, context, {
		...custom.options, onPayload: payload => h.onPayload({ ...payload, service_tier: "flex" }) ?? { ...payload, service_tier: "flex" },
	}));
	assert.equal(custom.requests[0].service_tier, "flex");
	assert.equal(customResult.usage.cost.total, 1.5);
});

test("pricing follows the final hook result, including in-place mutations and removal", async () => {
	const { directory } = sandbox();
	const h = harness(directory);
	await h.run("on");
	for (const tier of ["flex", undefined]) {
		const http = mockHttp();
		const result = await resultOf(h.stream(model, context, {
			...http.options,
			onPayload: payload => {
				const { service_tier, ...rest } = h.onPayload(payload);
				return tier ? { ...rest, service_tier: tier } : rest;
			},
		}));
		assert.equal(http.requests[0].service_tier, tier);
		assert.equal(result.usage.cost.total, tier ? 1.5 : 3);
	}
	const mutated = mockHttp();
	const result = await resultOf(h.stream(model, context, {
		...mutated.options, onPayload: payload => { payload.service_tier = "priority"; },
	}));
	assert.equal(mutated.requests[0].service_tier, "priority");
	assert.equal(result.usage.cost.total, 7.5);
});

for (const [name, selectedModel, reasoning] of [
	["thinking off", model, "off"],
	["clamped thinking", { ...model, thinkingLevelMap: { max: null, xhigh: "xhigh" } }, "max"],
	["non-reasoning model", { ...model, reasoning: false }, "high"],
]) {
	test(`adapter preserves native simple-stream request behavior for ${name}`, async () => {
		const h = harness(sandbox().directory);
		const actualHttp = mockHttp();
		const expectedHttp = mockHttp();
		const actual = await resultOf(h.stream(selectedModel, context, {
			...actualHttp.options, reasoning, onPayload: h.onPayload,
		}));
		const expected = await resultOf(nativeCodex.streamSimple(selectedModel, context, {
			...expectedHttp.options, reasoning,
		}));
		assert.deepEqual(actualHttp.requests[0], expectedHttp.requests[0]);
		assert.deepEqual(actual.usage, expected.usage);
	});
}

test("concurrent streams keep their pricing options request-local", async () => {
	const h = harness(sandbox().directory);
	const http = mockHttp();
	const sharedOptions = {
		...http.options,
		onPayload: async payload => {
			await new Promise(resolve => setImmediate(resolve));
			return { ...payload, service_tier: payload.instructions === "priority" ? "priority" : "flex" };
		},
	};
	const [priority, flex] = await Promise.all([
		resultOf(h.stream(model, { ...context, systemPrompt: "priority" }, sharedOptions)),
		resultOf(h.stream(model, { ...context, systemPrompt: "flex" }, sharedOptions)),
	]);
	assert.equal(priority.usage.cost.total, 7.5);
	assert.equal(flex.usage.cost.total, 1.5);
	assert.equal(sharedOptions.serviceTier, undefined);
});

test("native compaction summaries and branch summaries bypass Fast even while the global switch is ON", async () => {
	const h = harness(sandbox().directory);
	await h.run("on");
	const http = mockHttp();
	const streamFn = (m, c, options) => {
		assert.equal(options.onPayload, undefined);
		return h.stream(m, c, { ...http.options, ...options });
	};
	// Manual and automatic compaction share Pi's default summary implementation.
	for (const previousSummary of [undefined, "Previous summary"]) {
		const result = await generateSummaryWithUsage(
			[userMessage], model, 16384, fakeToken, http.options.headers, undefined,
			undefined, previousSummary, "max", streamFn,
		);
		assert.equal(result.text, "Summary.");
	}
	const branch = await generateBranchSummary([
		{ type: "message", id: "entry-test", parentId: null, timestamp: new Date(0).toISOString(), message: userMessage },
	], { model, apiKey: fakeToken, headers: http.options.headers, streamFn });
	assert.ok(branch.summary.includes("Summary."));
	assert.equal(http.requests.length, 3);
	assert.ok(http.requests.every(request => !Object.hasOwn(request, "service_tier")));
	assert.equal(h.hookCalls(), 0);
});

function cli(directory, command, mode = "print") {
	const result = spawnSync("pi", [
		"--offline", ...(mode === "json" ? ["--mode", "json"] : ["-p"]),
		"--no-session", "--no-extensions", "-e", extensionPath,
		"--no-skills", "--no-prompt-templates", "--no-approve", "--no-tools",
		"--provider", "openai-codex", "--model", "gpt-5.5", "--api-key", fakeToken, command,
	], {
		cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: directory, PI_OFFLINE: "1" },
		encoding: "utf8", timeout: 20000,
	});
	assert.equal(result.error, undefined, result.error?.message);
	if (mode === "json") {
		for (const line of result.stdout.trim().split("\n").filter(Boolean)) assert.doesNotThrow(() => JSON.parse(line));
	}
	return result;
}

for (const mode of ["print", "json"]) {
	test(`actual ${mode} CLI reports status and successful writes without polluting stdout`, { timeout: 60000 }, () => {
		const { directory, statePath } = sandbox();
		const status = cli(directory, "/fast status", mode);
		assert.equal(status.status, 0, status.stderr);
		assert.match(status.stderr, /Fast OFF globally for agent-loop Codex requests/);
		if (mode === "print") assert.equal(status.stdout, "");
		const on = cli(directory, "/fast on", mode);
		assert.equal(on.status, 0, on.stderr);
		assert.match(on.stderr, /Fast ON globally/);
		assert.deepEqual(readFastState(statePath), { enabled: true });
	});

	test(`actual ${mode} CLI reports publication failure and exits nonzero`, { timeout: 30000 }, () => {
		const { directory, statePath } = sandbox();
		// A directory at the target makes rename fail even when tests run as root.
		fs.mkdirSync(statePath);
		const result = cli(directory, "/fast on", mode);
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /Could not save Fast mode/);
		assert.ok(fs.statSync(statePath).isDirectory());
		assert.ok(!result.stderr.includes("Fast ON globally"));
	});

	test(`actual ${mode} CLI gives unreadable status and invalid arguments a nonzero exit`, { timeout: 60000 }, () => {
		const { directory, statePath } = sandbox();
		fs.writeFileSync(statePath, "{");
		const status = cli(directory, "/fast status", mode);
		assert.equal(status.status, 1, status.stderr);
		assert.match(status.stderr, /Fast status unavailable/);
		const invalid = cli(directory, "/fast invalid", mode);
		assert.equal(invalid.status, 1, invalid.stderr);
		assert.match(invalid.stderr, /Usage:/);
	});
}
