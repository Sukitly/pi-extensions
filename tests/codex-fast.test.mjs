import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const compatUrl = pathToFileURL(join(root, "node_modules/@earendil-works/pi-ai/dist/compat.js")).href;
const loader = registerHooks({
	resolve(specifier, context, nextResolve) {
		return nextResolve(specifier === "@earendil-works/pi-ai/compat" ? compatUrl : specifier, context);
	},
});
const { default: codexFastExtension } = await import("../codex-fast.ts");
loader.deregister();

const STATUS_KEY = "model:codex-fast";

// All storage is mocked. Tests never change the real global preference or call a model.
function mockStorage(t, enabled) {
	const storage = {
		text: enabled === undefined ? undefined : JSON.stringify({ enabled }),
		readError: undefined,
		writeError: undefined,
		writes: [],
		publications: [],
		temporaryFiles: new Map(),
		listeners: new Set(),
		paths: [],
	};
	t.mock.method(fs, "readFileSync", (path) => {
		assert.match(path, /codex-fast\.json$/);
		storage.paths.push(path);
		if (storage.readError) throw storage.readError;
		if (storage.text === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
		return storage.text;
	});
	t.mock.method(fs, "mkdirSync", () => {});
	const descriptors = new Map();
	let nextFd = 100;
	t.mock.method(fs, "openSync", (path, flags, mode) => {
		assert.equal(flags, "wx");
		assert.equal(mode, 0o600);
		const fd = nextFd++;
		descriptors.set(fd, path);
		storage.temporaryFiles.set(path, "");
		return fd;
	});
	t.mock.method(fs, "writeFileSync", (fd, text) => {
		assert.ok(descriptors.has(fd), "Write only to an exclusively opened temporary file");
		const path = descriptors.get(fd);
		storage.writes.push({ path, text, options: { mode: 0o600 } });
		storage.temporaryFiles.set(path, storage.writeError ? "{" : text);
		if (storage.writeError) throw storage.writeError;
	});
	t.mock.method(fs, "fsyncSync", fd => { assert.ok(descriptors.has(fd)); });
	t.mock.method(fs, "closeSync", fd => { assert.ok(descriptors.delete(fd)); });
	t.mock.method(fs, "renameSync", (source, target) => {
		assert.equal(dirname(source), dirname(target));
		assert.ok(![...descriptors.values()].includes(source), "Close the complete file before publishing");
		const text = storage.temporaryFiles.get(source);
		assert.equal(typeof JSON.parse(text).enabled, "boolean");
		storage.text = text;
		storage.temporaryFiles.delete(source);
		storage.publications.push({ source, target });
	});
	t.mock.method(fs, "watchFile", (_path, options, listener) => {
		assert.deepEqual(options, { persistent: false, interval: 1000 });
		storage.listeners.add(listener);
	});
	t.mock.method(fs, "unwatchFile", (_path, listener) => {
		storage.listeners.delete(listener);
	});
	return storage;
}

function createSession(provider = "openai-codex", mode = "tui", id = "gpt-6-astra") {
	const handlers = new Map();
	const commands = new Map();
	const providers = new Map();
	const statuses = new Map();
	const notifications = [];
	const colors = [];
	const ctx = {
		mode,
		model: { provider, id },
		ui: {
			theme: { fg: (color, text) => { colors.push(color); return text; } },
			setStatus: (key, text) => text === undefined ? statuses.delete(key) : statuses.set(key, text),
			notify: (message, level) => notifications.push({ message, level }),
		},
	};
	codexFastExtension({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
		registerProvider: (name, config) => providers.set(name, config),
	});
	return {
		ctx, statuses, notifications, colors, providers,
		command: commands.get("fast"),
		emit: (name, event = {}) => handlers.get(name)(event, ctx),
		run: (args) => commands.get("fast").handler(args, ctx),
		request: (payload) => handlers.get("before_provider_request")({ payload }, ctx),
	};
}

test("missing global preference defaults OFF without writing a file or adding a tier", (t) => {
	const storage = mockStorage(t);
	const session = createSession();
	session.emit("session_start");
	const payload = { model: "gpt-6-astra" };
	assert.equal(session.statuses.get(STATUS_KEY), undefined);
	assert.equal(session.request(payload), undefined);
	assert.deepEqual(payload, { model: "gpt-6-astra" });
	assert.equal(storage.writes.length, 0);
});

test("ON persists globally and injects priority without mutating other request fields", async (t) => {
	const storage = mockStorage(t);
	const session = createSession();
	await session.run("on");
	const payload = { model: "gpt-6-astra", reasoning: { effort: "max" }, service_tier: "flex" };
	assert.deepEqual(session.request(payload), { ...payload, service_tier: "priority" });
	assert.equal(payload.service_tier, "flex");
	assert.deepEqual(JSON.parse(storage.text), { enabled: true });
	assert.equal(storage.writes[0].options.mode, 0o600);
	assert.equal(storage.publications.length, 1);
	assert.equal(storage.temporaryFiles.size, 0);
	assert.equal(session.statuses.get(STATUS_KEY), "fast");
	assert.equal(session.colors.at(-1), "warning", "Keep the existing yellow, not dim gray");
	assert.match(session.notifications.at(-1).message, /Higher credit usage/);
});

test("OFF leaves the original payload alone: no default tier and no deletion of others' fields", async (t) => {
	mockStorage(t, true);
	const session = createSession();
	await session.run("off");
	const plain = { model: "gpt-6-astra" };
	const configured = { model: "gpt-6-astra", service_tier: "flex" };
	assert.equal(session.request(plain), undefined);
	assert.equal(session.request(configured), undefined);
	assert.deepEqual(plain, { model: "gpt-6-astra" });
	assert.equal(configured.service_tier, "flex");
	assert.equal(session.statuses.get(STATUS_KEY), undefined);
});

test("bare /fast toggles current persisted state; explicit on/off are idempotent", async (t) => {
	const storage = mockStorage(t);
	const session = createSession();
	for (const [args, expected] of [["", true], ["", false], [" ON ", true], ["on", true], ["off", false], ["off", false]]) {
		await session.run(args);
		assert.equal(JSON.parse(storage.text).enabled, expected, args);
	}
});

test("status and invalid arguments do not write or change the preference", async (t) => {
	const storage = mockStorage(t, true);
	const session = createSession();
	await session.run("status");
	assert.match(session.notifications.at(-1).message, /Fast ON globally/);
	await session.run("on off");
	assert.match(session.notifications.at(-1).message, /Usage:/);
	assert.equal(storage.writes.length, 0);
	assert.deepEqual(JSON.parse(storage.text), { enabled: true });
});

test("already-open sessions re-read the shared preference before each request, without waiting for polling", async (t) => {
	mockStorage(t);
	const a = createSession();
	const b = createSession();
	a.emit("session_start");
	b.emit("session_start");
	await a.run("on");
	assert.equal(b.request({}).service_tier, "priority");
	await b.run("off");
	assert.equal(a.request({}), undefined);
	await a.run("");
	assert.equal(b.request({}).service_tier, "priority");
});

test("new sessions and reloads retain the global setting, not a session-local copy", async (t) => {
	mockStorage(t);
	const first = createSession();
	await first.run("on");
	first.emit("session_shutdown");
	const restored = createSession();
	restored.emit("session_start", { reason: "reload" });
	assert.equal(restored.statuses.get(STATUS_KEY), "fast");
	assert.equal(restored.request({}).service_tier, "priority");
});

test("file-change polling refreshes idle terminals and does not leak watchers across reload/shutdown", (t) => {
	const storage = mockStorage(t, false);
	const session = createSession();
	session.emit("session_start");
	session.emit("session_start");
	assert.equal(storage.listeners.size, 1);
	storage.text = JSON.stringify({ enabled: true });
	for (const listener of storage.listeners) listener();
	assert.equal(session.statuses.get(STATUS_KEY), "fast");
	session.emit("session_shutdown");
	assert.equal(storage.listeners.size, 0);
	assert.equal(session.statuses.has(STATUS_KEY), false);
});

test("other providers are untouched, but may still operate the global switch", async (t) => {
	mockStorage(t, true);
	const session = createSession("anthropic");
	session.emit("session_start");
	assert.equal(session.statuses.has(STATUS_KEY), false);
	assert.equal(session.request({ model: "claude" }), undefined);
	await session.run("off");
	assert.match(session.notifications.at(-1).message, /provider is unaffected/);
	const codex = createSession();
	assert.equal(codex.request({}), undefined);
});

test("all allowlisted Codex models request priority and show the yellow badge", (t) => {
	mockStorage(t, true);
	for (const id of ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra"]) {
		const session = createSession("openai-codex", "tui", id);
		session.emit("session_start");
		const payload = { model: id, reasoning: { effort: "max" } };
		assert.deepEqual(session.request(payload), { ...payload, service_tier: "priority" }, id);
		assert.equal(session.statuses.get(STATUS_KEY), "fast", id);
		assert.equal(session.colors.at(-1), "warning", id);
		session.emit("session_shutdown");
	}
});

test("unlisted Codex IDs are inactive without changing payloads or the global preference", async (t) => {
	const storage = mockStorage(t, true);
	for (const id of ["gpt-5.4", "gpt-5.3-codex-spark", "gpt-5.3-codex", "gpt-6-astra-pro", "gpt-6-astra-unverified-snapshot", "gpt-5.6-sol-extra", "unknown", ""]) {
		const session = createSession("openai-codex", "tui", id);
		session.emit("session_start");
		for (const payload of [{ model: id }, { model: id, service_tier: "flex" }]) {
			const original = structuredClone(payload);
			assert.equal(session.request(payload), undefined, id);
			assert.deepEqual(payload, original, id);
		}
		assert.equal(session.statuses.has(STATUS_KEY), false, id);
		await session.run("status");
		assert.match(session.notifications.at(-1).message, /Fast ON globally.*Fast is inactive.*not in this extension's supported list/);
		session.emit("session_shutdown");
	}
	assert.equal(storage.writes.length, 0);
	assert.deepEqual(JSON.parse(storage.text), { enabled: true });
});

test("allowlisted IDs on other providers still receive no Fast injection or badge", (t) => {
	mockStorage(t, true);
	for (const provider of ["openai", "anthropic", "custom-codex"]) {
		const session = createSession(provider);
		session.emit("session_start");
		assert.equal(session.request({ model: "gpt-6-astra" }), undefined, provider);
		assert.equal(session.statuses.has(STATUS_KEY), false, provider);
		session.emit("session_shutdown");
	}
});

test("unlisted models can still operate the global switch for supported sessions", async (t) => {
	const storage = mockStorage(t);
	const unsupported = createSession("openai-codex", "tui", "gpt-5.3-codex-spark");
	const supported = createSession();
	await unsupported.run("on");
	assert.match(unsupported.notifications.at(-1).message, /Fast ON globally.*Fast is inactive/);
	assert.equal(unsupported.statuses.has(STATUS_KEY), false);
	assert.equal(supported.request({}).service_tier, "priority");
	await unsupported.run("off");
	assert.equal(supported.request({}), undefined);
	assert.deepEqual(JSON.parse(storage.text), { enabled: false });
});

test("unlisted models do not display fast? when global state is unreadable", (t) => {
	const storage = mockStorage(t);
	storage.text = "{";
	const session = createSession("openai-codex", "tui", "gpt-5.3-codex-spark");
	session.emit("session_start");
	assert.equal(session.statuses.has(STATUS_KEY), false);
	assert.equal(session.request({}), undefined);
	assert.match(session.notifications.at(-1).message, /Cannot read/);
});

test("model changes hide or restore the indicator, including later idle refreshes", (t) => {
	const storage = mockStorage(t, true);
	const session = createSession();
	session.emit("session_start");
	for (const model of [
		{ provider: "anthropic", id: "gpt-6-astra" },
		{ provider: "openai-codex", id: "gpt-5.3-codex-spark" },
		{ provider: "openai-codex" },
		undefined,
	]) {
		session.ctx.model = model;
		session.emit("model_select");
		for (const listener of storage.listeners) listener();
		assert.equal(session.statuses.has(STATUS_KEY), false);
		assert.equal(session.request({}), undefined);
	}
	session.ctx.model = { provider: "openai-codex", id: "gpt-6-astra" };
	session.emit("model_select");
	assert.equal(session.statuses.get(STATUS_KEY), "fast");
	assert.equal(session.request({}).service_tier, "priority");
	assert.equal(storage.writes.length, 0);
});

test("headless mode needs no watcher or footer, but still reads global state per request", (t) => {
	const storage = mockStorage(t, false);
	const session = createSession("openai-codex", "rpc");
	session.emit("session_start");
	storage.text = JSON.stringify({ enabled: true });
	assert.equal(session.request({}).service_tier, "priority");
	assert.equal(storage.listeners.size, 0);
	assert.equal(session.statuses.size, 0);
});

test("malformed or unreadable state never silently enables priority", (t) => {
	const storage = mockStorage(t);
	const session = createSession();
	for (const text of ["{", "null", "[]", "{}", '{"enabled":"true"}', '{"enabled":1}']) {
		storage.text = text;
		assert.equal(session.request({}), undefined, text);
		assert.equal(session.statuses.get(STATUS_KEY), "fast?");
	}
	storage.readError = Object.assign(new Error("denied"), { code: "EACCES" });
	assert.equal(session.request({}), undefined);
	const count = session.notifications.length;
	assert.equal(session.request({}), undefined);
	assert.equal(session.notifications.length, count, "Repeated identical read errors are not spammed");
});

test("bare toggle refuses corrupt state; explicit on/off can repair it", async (t) => {
	const storage = mockStorage(t);
	storage.text = "{";
	const session = createSession();
	await session.run("");
	assert.equal(storage.writes.length, 0);
	await session.run("off");
	assert.deepEqual(JSON.parse(storage.text), { enabled: false });
	assert.equal(session.statuses.get(STATUS_KEY), undefined);
});

test("explicit status still answers when a repeated read warning has been deduplicated", async (t) => {
	const storage = mockStorage(t);
	storage.text = "{";
	const session = createSession();
	session.request({});
	const count = session.notifications.length;
	await session.run("status");
	assert.equal(session.notifications.length, count + 1);
	assert.match(session.notifications.at(-1).message, /Fast status unavailable/);
	assert.equal(storage.writes.length, 0);
});

test("partially written temporary files do not publish or change request behavior", async (t) => {
	const storage = mockStorage(t, false);
	storage.writeError = new Error("disk full");
	const session = createSession();
	await session.run("on");
	assert.equal(session.notifications.at(-1).level, "error");
	assert.match(session.notifications.at(-1).message, /Could not save/);
	assert.equal(session.request({}), undefined);
	assert.deepEqual(JSON.parse(storage.text), { enabled: false });
	assert.equal(storage.publications.length, 0);
	assert.deepEqual([...storage.temporaryFiles.values()], ["{"]);
});

test("provider registration overrides only streaming, not models or authentication", (t) => {
	mockStorage(t);
	const session = createSession();
	assert.equal(session.providers.size, 1);
	const config = session.providers.get("openai-codex");
	assert.deepEqual(Object.keys(config).sort(), ["api", "streamSimple"]);
	assert.equal(config.api, "openai-codex-responses");
	assert.equal(typeof config.streamSimple, "function");
});

test("unexpected payloads are left alone rather than turned into malformed requests", (t) => {
	mockStorage(t, true);
	const session = createSession();
	for (const payload of [null, undefined, [], "body", 42]) {
		assert.equal(session.request(payload), undefined);
	}
	assert.match(session.notifications.at(-1).message, /unexpected Codex request payload/);
});

test("command offers on/off/status completion", (t) => {
	mockStorage(t);
	const { command } = createSession();
	assert.deepEqual(command.getArgumentCompletions("o").map((item) => item.value), ["on", "off"]);
	assert.deepEqual(command.getArgumentCompletions("sta"), [{ value: "status", label: "status" }]);
	assert.equal(command.getArgumentCompletions("bad"), null);
});
