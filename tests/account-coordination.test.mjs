import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { runtimeEnv } from "./runtime.mjs";
import { mkdtemp, rm, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sharedUsageFetch, getUsageApiKey, writeJson, digest, withFileLock, withAccountTransaction } from "../shared/account-coordination.mjs";

async function environment(t) {
	const dir = await mkdtemp(join(tmpdir(), "account-coordination-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(dir, { recursive: true, force: true });
	});
	return dir;
}
function worker(t, dir, mode, ...args) {
	const child = fork(new URL("./fixtures/accounts-worker.mjs", import.meta.url), [mode, ...args], {
		env: { ...process.env, ...runtimeEnv, PI_CODING_AGENT_DIR: dir }, stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	const messages = new Map();
	const listeners = new Map();
	let stderr = "";
	child.stderr.on("data", data => { stderr += data; });
	child.on("message", ({ event, data }) => {
		messages.set(event, data);
		listeners.get(event)?.resolve(data);
	});
	const exited = new Promise(resolve => child.on("exit", (code) => {
		for (const [event, listener] of listeners) {
			if (!messages.has(event)) listener.reject(new Error(`Worker exited ${code} before ${event}: ${messages.get("error") || stderr}`));
		}
		resolve(code);
	}));
	t.after(async () => { if (child.exitCode === null) child.kill(); await exited; });
	return {
		send: message => child.send(message),
		wait(event, timeoutMs = 10_000) {
			if (messages.has(event)) return Promise.resolve(messages.get(event));
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					listeners.delete(event);
					reject(new Error(`Worker timed out waiting for ${event}`));
				}, timeoutMs);
				listeners.set(event, {
					resolve: value => { clearTimeout(timer); resolve(value); },
					reject: error => { clearTimeout(timer); reject(error); },
				});
			});
		},
	};
}
const account = (id, expires = Date.now() + 1000) => ({
	id, provider: "test", alias: id, status: "valid", addedAt: Date.now(), lastUsedAt: Date.now(),
	credential: { type: "oauth", access: `access-${id}`, refresh: `refresh-${id}`, expires },
});
async function seed(dir, accounts, active) {
	await writeJson(join(dir, "oauth-accounts.json"), { version: 1, activeAccounts: active ? { test: active.id } : {}, accounts: Object.fromEntries(accounts.map(a => [a.id, a])) });
	await writeJson(join(dir, "auth.json"), active ? { test: active.credential } : {});
}
const json = async path => JSON.parse(await readFile(path, "utf8"));
const requests = async dir => {
	try { return (await readFile(join(dir, "requests.log"), "utf8")).trim().split("\n"); }
	catch (error) { if (error.code === "ENOENT") return []; throw error; }
};

for (const mode of ["sync-profile", "switch-profile", "delete-profile", "caretaker-profile"]) {
	test(`${mode}: blocked identity service does not hold the native auth lock`, { timeout: 20_000 }, async t => {
		const dir = await environment(t);
		const a = account("A", Date.now() + 36_000_000), b = account("B", Date.now() + 36_000_000);
		await seed(dir, [a, b], a);
		await writeJson(join(dir, "auth.json"), { test: a.credential, anthropic: account("unknown").credential });
		const syncing = worker(t, dir, mode, "B"), native = worker(t, dir, "native");
		await Promise.all([syncing.wait("ready"), native.wait("ready")]);
		const gate = join(dir, "usage-cache", `${digest("https://api.anthropic.com")}.gate.json`);
		await withFileLock(gate, async () => {
			syncing.send("go");
			await syncing.wait("profile-gate");
			// Keep the service gate held until native auth has COMPLETED, not just started.
			native.send("go");
			await native.wait("locked", 3_000);
			native.send("finish");
			await native.wait("done", 3_000);
			assert.equal((await json(join(dir, "auth.json"))).test.refresh, "refresh-A-native");
		});
		const result = await syncing.wait("done");
		if (mode === "switch-profile") assert.equal(result.ok, true);
		if (mode === "delete-profile") assert.equal(result, true);
		const store = await json(join(dir, "oauth-accounts.json"));
		assert.ok(Object.values(store.accounts).some(a => a.stableKey === "anthropic:uuid:profile-A"));
	});
}

test("late identity results cannot overwrite a native account switch", { timeout: 20_000 }, async t => {
	const dir = await environment(t);
	const a = { ...account("A"), provider: "anthropic", email: "a@example.com", stableKey: "anthropic:uuid:A" };
	const b = { ...account("B"), provider: "anthropic", email: "b@example.com", stableKey: "anthropic:uuid:B" };
	await writeJson(join(dir, "oauth-accounts.json"), { version: 1, activeAccounts: { anthropic: "A" }, accounts: { A: a, B: b } });
	await writeJson(join(dir, "auth.json"), { anthropic: { ...a.credential, access: "rotated-A", refresh: "rotated-refresh-A" } });
	const syncing = worker(t, dir, "sync-profile-held");
	const native = worker(t, dir, "native-replace", "anthropic", JSON.stringify(b.credential));
	await Promise.all([syncing.wait("ready"), native.wait("ready")]);
	syncing.send("go");
	await syncing.wait("profile-started");
	native.send("go");
	await native.wait("locked", 3_000);
	native.send("finish");
	await native.wait("done");
	syncing.send("profile-finish");
	await syncing.wait("done");
	const store = await json(join(dir, "oauth-accounts.json"));
	assert.equal(store.activeAccounts.anthropic, "B");
	assert.deepEqual(store.accounts.A, a, "the stale A identity must not update the old account");
	assert.equal(Object.keys(store.accounts).length, 2);
	assert.deepEqual((await json(join(dir, "auth.json"))).anthropic, b.credential);
});

test("identity and quota transport refuses to run inside an account transaction", async t => {
	await environment(t);
	let requests = 0;
	await assert.rejects(withAccountTransaction(() => sharedUsageFetch("https://quota.example/usage", {}, async () => {
		requests++;
		return Response.json({});
	})), /outside an account transaction/);
	assert.equal(requests, 0);
});

test("three real processes switching to the same expired account rotate only once", { timeout: 20_000 }, async t => {
	const dir = await environment(t);
	await seed(dir, [account("B")]);
	const workers = Array.from({ length: 3 }, () => worker(t, dir, "switch", "B"));
	await Promise.all(workers.map(w => w.wait("ready")));
	workers.forEach(w => w.send("go"));
	const results = await Promise.all(workers.map(w => w.wait("done")));
	assert.ok(results.every(r => r.ok));
	assert.deepEqual(await requests(dir), ["refresh:refresh-B"]);
	assert.equal((await json(join(dir, "auth.json"))).test.refresh, "refresh-B-new");
});

test("failed token refresh is cooled down across processes and does not replace live credentials", { timeout: 20_000 }, async t => {
	const dir = await environment(t);
	const a = account("A", Date.now() + 36_000_000), b = account("B");
	await seed(dir, [a, b], a);
	const workers = Array.from({ length: 3 }, () => worker(t, dir, "switch-fails", "B"));
	await Promise.all(workers.map(w => w.wait("ready")));
	workers.forEach(w => w.send("go"));
	const results = await Promise.all(workers.map(w => w.wait("done")));
	assert.ok(results.every(result => !result.ok));
	assert.deepEqual(await requests(dir), ["refresh:refresh-B"]);
	assert.equal((await json(join(dir, "auth.json"))).test.refresh, "refresh-A");
	const stored = (await json(join(dir, "oauth-accounts.json"))).accounts.B;
	assert.equal(stored.status, "expired");
	assert.ok(stored.nextRefreshAttemptAt > Date.now());
});

test("native Pi refresh lock and account switch interoperate without restoring the old account", { timeout: 20_000 }, async t => {
	const dir = await environment(t);
	const a = account("A"), b = account("B", Date.now() + 36_000_000);
	await seed(dir, [a, b], a);
	const native = worker(t, dir, "native"), switching = worker(t, dir, "switch", "B");
	await Promise.all([native.wait("ready"), switching.wait("ready")]);
	native.send("go");
	await native.wait("locked");
	switching.send("go");
	await switching.wait("switching");
	native.send("finish");
	await native.wait("done");
	assert.equal((await switching.wait("done")).ok, true);
	const store = await json(join(dir, "oauth-accounts.json"));
	assert.equal(store.accounts.A.credential.refresh, "refresh-A-native");
	assert.equal(store.activeAccounts.test, "B");
	assert.equal((await json(join(dir, "auth.json"))).test.refresh, "refresh-B");
});

test("native Pi mutation waits for an extension refresh transaction", { timeout: 20_000 }, async t => {
	const dir = await environment(t);
	const a = account("A");
	await seed(dir, [a], a);
	const switching = worker(t, dir, "switch-held", "A"), native = worker(t, dir, "native");
	await Promise.all([switching.wait("ready"), native.wait("ready")]);
	switching.send("go");
	await switching.wait("refreshing");
	native.send("go");
	switching.send("finish");
	assert.equal((await switching.wait("done")).ok, true);
	await native.wait("locked");
	native.send("finish");
	await native.wait("done");
	assert.equal((await json(join(dir, "auth.json"))).test.refresh, "refresh-A-new-native");
});

test("caretaker has a cross-process lease and persistent cooldown, normal passes skip active accounts", { timeout: 20_000 }, async t => {
	const dir = await environment(t);
	await seed(dir, [account("A")]);
	const workers = Array.from({ length: 3 }, () => worker(t, dir, "caretaker"));
	await Promise.all(workers.map(w => w.wait("ready")));
	workers.forEach(w => w.send("go"));
	await Promise.all(workers.map(w => w.wait("done")));
	assert.deepEqual(await requests(dir), ["refresh:refresh-A"]);
	// Simulate a short-lived token so only the persistent pass cooldown prevents refresh.
	const a = account("A");
	await seed(dir, [a], a);
	const again = worker(t, dir, "caretaker");
	await again.wait("ready"); again.send("go"); await again.wait("done");
	assert.equal((await requests(dir)).length, 1);
	await rm(join(dir, "oauth-caretaker.json"));
	const normal = worker(t, dir, "caretaker-normal");
	await normal.wait("ready"); normal.send("go"); await normal.wait("done");
	assert.equal((await requests(dir)).length, 1);
});

test("cross-process store mutations do not lose unrelated renames", { timeout: 20_000 }, async t => {
	const dir = await environment(t);
	await seed(dir, [account("A"), account("B")]);
	const a = worker(t, dir, "rename", "A", "alpha"), b = worker(t, dir, "rename", "B", "beta");
	await Promise.all([a.wait("ready"), b.wait("ready")]);
	a.send("go"); b.send("go");
	await Promise.all([a.wait("done"), b.wait("done")]);
	const store = await json(join(dir, "oauth-accounts.json"));
	assert.equal(store.accounts.A.alias, "alpha");
	assert.equal(store.accounts.B.alias, "beta");
});

test("usage requests deduplicate across three real processes", { timeout: 20_000 }, async t => {
	const dir = await environment(t);
	const workers = Array.from({ length: 3 }, () => worker(t, dir, "usage"));
	await Promise.all(workers.map(w => w.wait("ready")));
	workers.forEach(w => w.send("go"));
	const results = await Promise.all(workers.map(w => w.wait("done")));
	assert.deepEqual(results, [{ used: 25 }, { used: 25 }, { used: 25 }]);
	assert.deepEqual(await requests(dir), ["usage"]);
	for (const file of await readdir(join(dir, "usage-cache"))) {
		assert.doesNotMatch(await readFile(join(dir, "usage-cache", file), "utf8"), /worker-secret/);
		assert.equal((await stat(join(dir, "usage-cache", file))).mode & 0o777, 0o600);
	}
});

test("429 Retry-After gates other accounts and retries without persisting secret error text", async t => {
	const dir = await environment(t);
	let calls = 0;
	const fetch = async () => { calls++; return new Response("secret-token", { status: 429, headers: { "retry-after": "600" } }); };
	for (const token of ["secret-token", "secret-token", "another-account"]) {
		const response = await sharedUsageFetch("https://quota.example/usage", { headers: { Authorization: `Bearer ${token}` } }, fetch);
		assert.equal(response.status, 429);
	}
	assert.equal(calls, 1);
	const gate = await json(join(dir, "usage-cache", `${digest("https://quota.example")}.gate.json`));
	assert.ok(gate.blockedUntil > Date.now() + 590_000);
	for (const file of await readdir(join(dir, "usage-cache"))) {
		assert.doesNotMatch(await readFile(join(dir, "usage-cache", file), "utf8"), /secret-token|another-account/);
	}
});

test("network failures and invalid JSON are cooled down, then retry with increasing backoff", async t => {
	const dir = await environment(t);
	let calls = 0;
	const fetch = async () => { calls++; throw new Error("offline"); };
	const url = "https://quota.example/usage";
	await assert.rejects(sharedUsageFetch(url, {}, fetch), /offline/);
	await assert.rejects(sharedUsageFetch(url, {}, fetch), /cooldown/);
	assert.equal(calls, 1);
	const root = join(dir, "usage-cache");
	const file = (await readdir(root)).find(name => !name.includes(".gate."));
	const entry = await json(join(root, file));
	await writeJson(join(root, file), { ...entry, nextAttemptAt: 0 });
	await writeJson(join(root, `${digest("https://quota.example")}.gate.json`), {});
	await assert.rejects(sharedUsageFetch(url, {}, fetch), /offline/);
	const second = await json(join(root, file));
	assert.equal(second.failures, 2);
	assert.ok(second.nextAttemptAt > Date.now() + 119_000);
	await assert.rejects(sharedUsageFetch("https://other.example/usage", {}, async () => new Response("not json")));
	await assert.rejects(sharedUsageFetch("https://other.example/usage", {}, async () => { throw new Error("must not retry"); }), /cooldown/);
});

test("different credentials cannot reuse another account's successful quota", async t => {
	await environment(t);
	let calls = 0;
	const fetch = async () => Response.json({ used: ++calls });
	const get = async token => (await sharedUsageFetch("https://quota.example/usage", { headers: { Authorization: token } }, fetch)).json();
	assert.deepEqual(await get("account-a"), { used: 1 });
	assert.deepEqual(await get("account-b"), { used: 2 });
	assert.deepEqual(await get("account-a"), { used: 1 });
});

test("usage authentication never refreshes OAuth, including expired credentials", async () => {
	let expires = Date.now() + 1_000;
	const registry = {
		runtime: { credentials: { read: async () => ({ type: "oauth", access: "access", expires }) } },
		getProvider: () => ({ auth: { oauth: { toAuth: credential => ({ apiKey: credential.access }) } } }),
		getApiKeyForProvider: () => { throw new Error("must not refresh"); },
	};
	assert.equal(await getUsageApiKey(registry, "test"), "access");
	expires = Date.now() - 1;
	await assert.rejects(getUsageApiKey(registry, "test"), /expired/);
});
