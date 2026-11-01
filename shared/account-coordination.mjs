import lockfile from "proper-lockfile";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

export const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
export const digest = (value) => createHash("sha256").update(value).digest("hex");
export async function readJson(path, fallback) {
	try { return JSON.parse(await readFile(path, "utf8")); }
	catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}
export async function writeJson(path, value) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	await rename(temp, path);
}

// Use the SAME lock protocol/path/staleness as Pi's FileAuthStorageBackend.
// A rename alone is not a read-modify-write transaction.
export async function withFileLock(path, fn, { tryOnly = false, signal } = {}) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const deadline = Date.now() + 60_000;
	let release;
	let compromised;
	while (!release) {
		signal?.throwIfAborted();
		try {
			release = await lockfile.lock(path, {
				realpath: false, stale: 30_000, retries: 0,
				onCompromised: (error) => { compromised = error; },
			});
		} catch (error) {
			if (error.code !== "ELOCKED") throw error;
			if (tryOnly) return undefined;
			if (Date.now() >= deadline) throw error;
			await sleep(40 + Math.random() * 80, undefined, { signal });
		}
	}
	const check = () => { if (compromised) throw compromised; };
	try {
		signal?.throwIfAborted();
		const result = await fn(check);
		check();
		return result;
	} finally { await release().catch(() => {}); }
}

const transaction = new AsyncLocalStorage();
export function assertAccountTransaction() {
	const tx = transaction.getStore();
	if (!tx || tx.dir !== agentDir() || !tx.active) throw new Error("Account write outside transaction");
	tx.check();
}
export async function withAccountTransaction(fn) {
	const dir = agentDir();
	const current = transaction.getStore();
	if (current?.dir === dir && current.active) { current.check(); return fn(); }
	// Fixed ordering; Pi itself takes only auth.json.lock. Never call runtime
	// refresh/getAuth/reload while holding this transaction (they acquire it too).
	return withFileLock(join(dir, "oauth-accounts.json"), (checkStore) =>
		withFileLock(join(dir, "auth.json"), (checkAuth) => {
			const tx = { dir, active: true, check: () => { checkStore(); checkAuth(); } };
			return transaction.run(tx, async () => {
				try { return await fn(); } finally { tx.active = false; }
			});
		}));
}

// One caretaker pass per interval across processes, including /new and /reload.
export async function withCaretakerLease(fn, { force = false, signal } = {}) {
	const path = join(agentDir(), "oauth-caretaker.json");
	return withFileLock(path, async (check) => {
		const previous = await readJson(path, {});
		if (Date.now() - (previous.checkedAt || 0) < (force ? 60_000 : 3_600_000)) return;
		check();
		await writeJson(path, { checkedAt: Date.now() });
		return fn();
	}, { tryOnly: true, signal });
}

const USAGE_TTL = 180_000;
function retryDelay(response, failures) {
	const retry = response?.headers?.get?.("retry-after");
	const seconds = retry == null ? NaN : Number(retry);
	const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry || "") - Date.now();
	return Math.max(Math.min(60_000 * 2 ** Math.min(failures - 1, 4), 900_000), Number.isFinite(requested) ? requested : 0);
}
function replay(entry) {
	if (entry.networkError) throw new Error("Usage request failed; waiting for retry cooldown");
	return new Response(entry.body, { status: entry.status, statusText: entry.statusText, headers: entry.headers });
}

// Shared by the account menu AND widget. No credentials in filenames or cache
// contents. Serialize per service as well as deduplicating identical requests.
export async function sharedUsageFetch(url, init = {}, fetchImpl = globalThis.fetch) {
	const headers = new Headers(init.headers);
	const scope = new URL(url).origin;
	const key = digest(JSON.stringify([url, init.method || "GET", init.body || "", headers.get("authorization"), headers.get("chatgpt-account-id")]));
	const root = join(agentDir(), "usage-cache");
	const path = join(root, `${key}.json`);
	const gate = join(root, `${digest(scope)}.gate.json`);
	return withFileLock(gate, async (check) => {
		const cached = await readJson(path, null);
		if (cached && Date.now() < cached.nextAttemptAt) return replay(cached);
		const service = await readJson(gate, {});
		if (Date.now() < (service.blockedUntil || 0)) {
			return new Response("Usage service rate limited; waiting for retry cooldown", { status: 429, headers: { "retry-after": String(Math.ceil((service.blockedUntil - Date.now()) / 1000)) } });
		}
		await sleep(Math.max(0, (service.lastAttemptAt || 0) + 1000 - Date.now()));
		const failures = (cached?.failures || 0) + 1;
		let response;
		let entry;
		try {
			// The caller may have waited on another process. Start its timeout NOW.
			response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) });
			const body = await response.text().catch(error => {
				if (response.ok) throw error;
				return ""; // Preserve HTTP status even when the error body cannot be read.
			});
			if (response.ok) JSON.parse(body); // Do not cache invalid JSON as success.
			entry = {
				body: response.ok ? body : `HTTP ${response.status} (cached failure; waiting for retry cooldown)`,
				status: response.status, statusText: response.statusText,
				headers: { "content-type": "application/json" },
				failures: response.ok ? 0 : failures,
				nextAttemptAt: Date.now() + (response.ok ? USAGE_TTL : retryDelay(response, failures)),
			};
			// Preserve the original error detail only for this caller, not on disk.
			response = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
		} catch (error) {
			entry = { networkError: true, failures, nextAttemptAt: Date.now() + retryDelay(null, failures) };
			check();
			await writeJson(path, entry);
			await writeJson(gate, { ...service, lastAttemptAt: Date.now() });
			throw error;
		}
		check();
		await writeJson(path, entry);
		await writeJson(gate, { lastAttemptAt: Date.now(), blockedUntil: response.status === 429 ? entry.nextAttemptAt : 0 });
		return response;
	});
}

// A quota display must not rotate OAuth credentials. Pi refreshes them on real
// model requests; background quota reads use the current access token only.
export async function getUsageApiKey(registry, provider) {
	const credentials = registry.runtime?.credentials;
	if (credentials?.read) {
		const credential = await credentials.read(provider);
		if (credential?.type === "oauth") {
			if (Date.now() >= credential.expires) throw new Error("OAuth token expired; quota will update after the next model request");
			const oauth = registry.getProvider(provider)?.auth?.oauth;
			if (!oauth?.toAuth) throw new Error("Provider does not expose OAuth credentials for quota queries");
			return (await oauth.toAuth(credential)).apiKey;
		}
	}
	return registry.getApiKeyForProvider(provider);
}
