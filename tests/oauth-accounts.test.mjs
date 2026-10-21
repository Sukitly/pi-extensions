import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "/Users/sukit/.pi/agent/install/releases/1.3.0/node_modules/jiti/lib/jiti.mjs";

async function createTestEnv() {
	const tempDir = await mkdtemp(join(tmpdir(), "oauth-accounts-test-"));
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = join(tempDir, ".pi", "agent");
	await mkdir(agentDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const jiti = createJiti(import.meta.url, {
		alias: {
			"@earendil-works/pi-coding-agent": "/Users/sukit/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent",
			"@earendil-works/pi-tui": "/Users/sukit/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-tui",
		},
	});

	const mod = await jiti.import("../oauth-accounts.ts");

	const authFile = join(agentDir, "auth.json");
	const accountsFile = join(agentDir, "oauth-accounts.json");

	const cleanup = async () => {
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		await rm(tempDir, { recursive: true, force: true });
	};

	return {
		mod,
		agentDir,
		authFile,
		accountsFile,
		cleanup,
		readAuth: async () => JSON.parse(await readFile(authFile, "utf8")),
		writeAuth: async (data) => writeFile(authFile, JSON.stringify(data, null, 2)),
		readStore: async () => JSON.parse(await readFile(accountsFile, "utf8")),
		writeStore: async (data) => writeFile(accountsFile, JSON.stringify(data, null, 2)),
	};
}

test("initializes empty store gracefully when oauth-accounts.json does not exist", async () => {
	const env = await createTestEnv();
	try {
		const store = await env.mod.loadAccountsStore();
		assert.equal(store.version, 1);
		assert.deepEqual(store.activeAccounts, {});
		assert.deepEqual(store.accounts, {});
	} finally {
		await env.cleanup();
	}
});

test("syncLiveToStore auto-adopts OAuth credentials from auth.json and ignores non-OAuth API keys", async () => {
	const env = await createTestEnv();
	try {
		await env.writeAuth({
			anthropic: {
				type: "oauth",
				access: "access-token-1",
				refresh: "refresh-token-1",
				expires: Date.now() + 3600 * 1000,
			},
			"opencode-go": {
				type: "api_key",
				key: "sk-my-api-key",
			},
		});

		const store = await env.mod.syncLiveToStore();
		assert.equal(Object.keys(store.accounts).length, 1);
		const anthropicAcc = Object.values(store.accounts)[0];
		assert.equal(anthropicAcc.provider, "anthropic");
		assert.equal(anthropicAcc.credential.refresh, "refresh-token-1");
		assert.equal(store.activeAccounts.anthropic, anthropicAcc.id);
		assert.equal(store.activeAccounts["opencode-go"], undefined);
	} finally {
		await env.cleanup();
	}
});

test("lifecycle token rotation: rotated token for active account updates in place without duplicating accounts", async () => {
	const env = await createTestEnv();
	try {
		// Initial login for Anthropic
		await env.writeAuth({
			anthropic: {
				type: "oauth",
				access: "access-token-original",
				refresh: "refresh-token-original",
				expires: Date.now() + 3600 * 1000,
			},
		});
		await env.mod.syncLiveToStore();

		let store = await env.mod.loadAccountsStore();
		assert.equal(Object.keys(store.accounts).length, 1);
		const accountId = store.activeAccounts.anthropic;

		// Model request runs and Pi rotates the token in auth.json to a new refresh token
		await env.writeAuth({
			anthropic: {
				type: "oauth",
				access: "access-token-rotated",
				refresh: "refresh-token-rotated",
				expires: Date.now() + 7200 * 1000,
			},
		});

		// syncLiveToStore runs after agent turn (turn_end / agent_end / opening /accounts)
		await env.mod.syncLiveToStore();

		store = await env.mod.loadAccountsStore();
		// Must NOT create a second account; must update the active account in place!
		assert.equal(Object.keys(store.accounts).length, 1, "Must not duplicate account on token rotation");
		assert.equal(store.accounts[accountId].credential.refresh, "refresh-token-rotated");
		assert.equal(store.accounts[accountId].credential.access, "access-token-rotated");
	} finally {
		await env.cleanup();
	}
});

test("syncLiveToStore with explicit /login detects and adds a new distinct account", async () => {
	const env = await createTestEnv();
	try {
		// Existing account A
		const payloadA = { email: "account-a@example.com" };
		const fakeJwtA = `hdr.${Buffer.from(JSON.stringify(payloadA)).toString("base64")}.sig`;
		await env.writeAuth({
			anthropic: {
				type: "oauth",
				access: fakeJwtA,
				refresh: "refresh-token-A",
				expires: Date.now() + 3600 * 1000,
			},
		});
		await env.mod.syncLiveToStore();

		let store = await env.mod.loadAccountsStore();
		assert.equal(Object.keys(store.accounts).length, 1);
		const accountAId = store.activeAccounts.anthropic;

		// User now runs /login anthropic for account B with different JWT/identity
		env.mod.setPendingLoginProvider("anthropic");
		const payloadB = { email: "account-b@example.com" };
		const fakeJwtB = `hdr.${Buffer.from(JSON.stringify(payloadB)).toString("base64")}.sig`;

		await env.writeAuth({
			anthropic: {
				type: "oauth",
				access: fakeJwtB,
				refresh: "refresh-token-B",
				expires: Date.now() + 7200 * 1000,
			},
		});
		await env.mod.syncLiveToStore();

		store = await env.mod.loadAccountsStore();
		assert.equal(Object.keys(store.accounts).length, 2, "Must keep both account A and account B in pool");
		assert.ok(store.accounts[accountAId], "Account A must still exist");
		assert.equal(store.accounts[accountAId].credential.refresh, "refresh-token-A");

		const accountBId = store.activeAccounts.anthropic;
		assert.notEqual(accountAId, accountBId);
		assert.equal(store.accounts[accountBId].credential.refresh, "refresh-token-B");
	} finally {
		await env.cleanup();
	}
});

test("switchAccount switches active account in auth.json, waits for idle, and preserves other providers", async () => {
	const env = await createTestEnv();
	try {
		const accountA = {
			id: "anthropic-A",
			alias: "work",
			provider: "anthropic",
			credential: { type: "oauth", access: "acc-A", refresh: "ref-A", expires: Date.now() + 1000000 },
			status: "valid",
			addedAt: Date.now(),
			lastUsedAt: Date.now(),
		};
		const accountB = {
			id: "anthropic-B",
			alias: "personal",
			provider: "anthropic",
			credential: { type: "oauth", access: "acc-B", refresh: "ref-B", expires: Date.now() + 1000000 },
			status: "valid",
			addedAt: Date.now(),
			lastUsedAt: Date.now(),
		};

		await env.writeStore({
			version: 1,
			activeAccounts: { anthropic: "anthropic-A" },
			accounts: { "anthropic-A": accountA, "anthropic-B": accountB },
		});

		await env.writeAuth({
			anthropic: accountA.credential,
			"openai-codex": { type: "oauth", access: "openai-token", refresh: "openai-ref", expires: 123456 },
		});

		let waitedForIdle = false;
		const mockCtx = {
			waitForIdle: async () => {
				waitedForIdle = true;
			},
			modelRegistry: {
				getProvider: () => undefined,
				refresh: async () => {},
			},
			ui: { notify: () => {} },
		};

		const res = await env.mod.switchAccount(mockCtx, "anthropic-B");
		assert.equal(res.ok, true);
		assert.equal(waitedForIdle, true, "Must call waitForIdle before switching");

		const auth = await env.readAuth();
		assert.equal(auth.anthropic.access, "acc-B");
		assert.equal(auth.anthropic.refresh, "ref-B");
		assert.equal(auth["openai-codex"].access, "openai-token", "Other providers must be preserved");

		const store = await env.mod.loadAccountsStore();
		assert.equal(store.activeAccounts.anthropic, "anthropic-B");
	} finally {
		await env.cleanup();
	}
});

test("safe deletion: deleting active account removes it from auth.json and prevents resurrection", async () => {
	const env = await createTestEnv();
	try {
		const account = {
			id: "anthropic-live",
			alias: "to-delete",
			provider: "anthropic",
			credential: { type: "oauth", access: "a-del", refresh: "r-del", expires: Date.now() + 1000000 },
			status: "valid",
			addedAt: Date.now(),
			lastUsedAt: Date.now(),
		};

		await env.writeStore({
			version: 1,
			activeAccounts: { anthropic: "anthropic-live" },
			accounts: { "anthropic-live": account },
		});

		await env.writeAuth({
			anthropic: account.credential,
		});

		let refreshedRuntime = false;
		const mockRegistry = {
			refresh: async () => {
				refreshedRuntime = true;
			},
		};

		// Delete the active account
		const deleted = await env.mod.deleteAccount("anthropic-live", mockRegistry);
		assert.equal(deleted, true);
		assert.equal(refreshedRuntime, true);

		// auth.json must have the provider cleared!
		const auth = await env.readAuth();
		assert.equal(auth.anthropic, undefined, "auth.json must be cleared on deleting active account");

		// Run syncLiveToStore (simulating subsequent /accounts menu open)
		await env.mod.syncLiveToStore();

		const store = await env.mod.loadAccountsStore();
		assert.equal(Object.keys(store.accounts).length, 0, "Deleted account must not resurrect");
	} finally {
		await env.cleanup();
	}
});

test("corrupted storage protection: halts writes and throws error on corrupt json or bad schema", async () => {
	const env = await createTestEnv();
	try {
		await writeFile(env.accountsFile, "{ corrupted invalid json ... !!");

		// Must throw error rather than returning empty store and overwriting
		await assert.rejects(async () => {
			await env.mod.loadAccountsStore();
		}, /corrupted/);

		// Verify file on disk was NOT overwritten
		const content = await readFile(env.accountsFile, "utf8");
		assert.equal(content, "{ corrupted invalid json ... !!", "Original corrupt file must not be overwritten");
	} finally {
		await env.cleanup();
	}
});

test("switchAccount pre-flight refresh: blocks switch when revoked (invalid_grant) and protects auth.json", async () => {
	const env = await createTestEnv();
	try {
		const liveAcc = {
			id: "live-id",
			alias: "live",
			provider: "anthropic",
			credential: { type: "oauth", access: "live-acc", refresh: "live-ref", expires: Date.now() + 100000 },
			status: "valid",
			addedAt: Date.now(),
			lastUsedAt: Date.now(),
		};
		const deadAcc = {
			id: "dead-id",
			alias: "dead",
			provider: "anthropic",
			credential: { type: "oauth", access: "dead-acc", refresh: "dead-ref", expires: Date.now() - 5000 },
			status: "valid",
			addedAt: Date.now(),
			lastUsedAt: Date.now(),
		};

		await env.writeStore({
			version: 1,
			activeAccounts: { anthropic: "live-id" },
			accounts: { "live-id": liveAcc, "dead-id": deadAcc },
		});
		await env.writeAuth({ anthropic: liveAcc.credential });

		const mockCtx = {
			modelRegistry: {
				getProvider: () => ({
					auth: {
						oauth: {
							refresh: async () => {
								throw new Error("HTTP 400 invalid_grant: Token has been revoked");
							},
						},
					},
				}),
				refresh: async () => {},
			},
			ui: { notify: () => {} },
		};

		const res = await env.mod.switchAccount(mockCtx, "dead-id");
		assert.equal(res.ok, false);
		assert.match(res.message, /invalid_grant/);

		// auth.json must NOT be overwritten with dead account
		const auth = await env.readAuth();
		assert.equal(auth.anthropic.access, "live-acc");

		const store = await env.mod.loadAccountsStore();
		assert.equal(store.accounts["dead-id"].status, "expired");
	} finally {
		await env.cleanup();
	}
});

test("switchAccount pre-flight refresh: allows switch when refresh has transient network timeout but token is still valid", async () => {
	const env = await createTestEnv();
	try {
		const targetAcc = {
			id: "target-id",
			alias: "target",
			provider: "anthropic",
			// Expires in 3 minutes (triggers pre-flight refresh because < 5 minutes, but STILL VALID)
			credential: { type: "oauth", access: "valid-acc", refresh: "valid-ref", expires: Date.now() + 3 * 60 * 1000 },
			status: "valid",
			addedAt: Date.now(),
			lastUsedAt: Date.now(),
		};

		await env.writeStore({
			version: 1,
			activeAccounts: {},
			accounts: { "target-id": targetAcc },
		});
		await env.writeAuth({});

		const mockCtx = {
			modelRegistry: {
				getProvider: () => ({
					auth: {
						oauth: {
							refresh: async () => {
								throw new Error("Fetch failed: ETIMEDOUT connection timed out");
							},
						},
					},
				}),
				refresh: async () => {},
			},
			ui: { notify: () => {} },
		};

		const res = await env.mod.switchAccount(mockCtx, "target-id");
		// Must allow switch because token is still valid, but with warning note
		assert.equal(res.ok, true);
		assert.match(res.message, /timed out/);

		const auth = await env.readAuth();
		assert.equal(auth.anthropic.access, "valid-acc");

		const store = await env.mod.loadAccountsStore();
		assert.equal(store.accounts["target-id"].status, "valid", "Must not falsely mark as expired on transient network error");
	} finally {
		await env.cleanup();
	}
});

test("concurrency: caretaker async network refresh does not clobber concurrent switchAccount", async () => {
	const env = await createTestEnv();
	try {
		const accountA = {
			id: "acc-A",
			alias: "account-A",
			provider: "anthropic",
			credential: { type: "oauth", access: "a-A", refresh: "r-A", expires: Date.now() + 1000000 },
			status: "valid",
			addedAt: Date.now(),
			lastUsedAt: Date.now(),
		};
		const accountB = {
			id: "acc-B",
			alias: "account-B",
			provider: "anthropic",
			credential: { type: "oauth", access: "a-B", refresh: "r-B", expires: Date.now() + 1000000 },
			status: "valid",
			addedAt: Date.now(),
			lastUsedAt: Date.now(),
		};
		const accountDormant = {
			id: "acc-dormant",
			alias: "dormant-openai",
			provider: "openai-codex",
			credential: { type: "oauth", access: "a-d", refresh: "r-d", expires: Date.now() + 10 * 60 * 1000 },
			status: "valid",
			addedAt: Date.now(),
			lastUsedAt: Date.now(),
		};

		await env.writeStore({
			version: 1,
			activeAccounts: { anthropic: "acc-A" },
			accounts: { "acc-A": accountA, "acc-B": accountB, "acc-dormant": accountDormant },
		});
		await env.writeAuth({ anthropic: accountA.credential });

		// Caretaker refresh has an artificial delay
		const mockRegistry = {
			getProvider: (id) => {
				if (id === "openai-codex") {
					return {
						auth: {
							oauth: {
								refresh: async () => {
									await new Promise((r) => setTimeout(r, 50));
									return { type: "oauth", access: "a-d-new", refresh: "r-d-new", expires: Date.now() + 999999 };
								},
							},
						},
					};
				}
				return undefined;
			},
			refresh: async () => {},
		};

		const mockCtx = {
			modelRegistry: mockRegistry,
			ui: { notify: () => {} },
		};

		// Start Caretaker in background
		const caretakerPromise = env.mod.runGlobalCaretaker(mockRegistry, { force: true });

		// Immediately switch account from A to B while Caretaker is running
		const switchResult = await env.mod.switchAccount(mockCtx, "acc-B");
		assert.equal(switchResult.ok, true);

		// Wait for Caretaker to finish
		await caretakerPromise;

		// Verify Caretaker did NOT revert the active account back to A!
		const store = await env.mod.loadAccountsStore();
		assert.equal(store.activeAccounts.anthropic, "acc-B", "Active account must remain B");

		const auth = await env.readAuth();
		assert.equal(auth.anthropic.access, "a-B", "auth.json must remain B");
	} finally {
		await env.cleanup();
	}
});

test("renameAccount enforces case-insensitive uniqueness within provider", async () => {
	const env = await createTestEnv();
	try {
		const acc1 = {
			id: "acc-1",
			alias: "work",
			provider: "anthropic",
			credential: { type: "oauth", access: "a", refresh: "r", expires: 9999999999 },
			status: "valid",
			addedAt: Date.now(),
			lastUsedAt: Date.now(),
		};
		const acc2 = {
			id: "acc-2",
			alias: "personal",
			provider: "anthropic",
			credential: { type: "oauth", access: "a", refresh: "r", expires: 9999999999 },
			status: "valid",
			addedAt: Date.now(),
			lastUsedAt: Date.now(),
		};

		await env.writeStore({
			version: 1,
			activeAccounts: {},
			accounts: { "acc-1": acc1, "acc-2": acc2 },
		});

		// Attempt to rename acc2 to "WORK" (case-insensitive collision)
		const res = await env.mod.renameAccount("acc-2", "WORK");
		assert.equal(res.ok, false);
		assert.match(res.error, /already exists/i);

		// Valid rename
		const validRes = await env.mod.renameAccount("acc-2", "home");
		assert.equal(validRes.ok, true);

		const store = await env.mod.loadAccountsStore();
		assert.equal(store.accounts["acc-2"].alias, "home");
	} finally {
		await env.cleanup();
	}
});

test("getAccountUsageSummary does not call wham usage for native openai", async () => {
	const env = await createTestEnv();
	try {
		let calledWham = false;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (url) => {
			if (String(url).includes("wham/usage")) {
				calledWham = true;
			}
			return new Response("{}", { status: 200 });
		};

		try {
			const nativeOpenAIAcc = {
				id: "openai-native",
				alias: "native-openai",
				provider: "openai",
				credential: { type: "oauth", access: "tok", refresh: "ref", expires: 9999999 },
				status: "valid",
				addedAt: Date.now(),
				lastUsedAt: Date.now(),
			};
			const summary = await env.mod.getAccountUsageSummary(nativeOpenAIAcc);
			assert.equal(summary, null);
			assert.equal(calledWham, false, "Must NOT call wham usage for native openai");
		} finally {
			globalThis.fetch = originalFetch;
		}
	} finally {
		await env.cleanup();
	}
});

test("formatWindowSeconds formats window seconds accurately", async () => {
	const env = await createTestEnv();
	try {
		assert.equal(env.mod.formatWindowSeconds(604800), "7d");
		assert.equal(env.mod.formatWindowSeconds(86400), "1d");
		assert.equal(env.mod.formatWindowSeconds(18000), "5h");
		assert.equal(env.mod.formatWindowSeconds(3600), "1h");
		assert.equal(env.mod.formatWindowSeconds(300), "5m");
		assert.equal(env.mod.formatWindowSeconds(45), "45s");
	} finally {
		await env.cleanup();
	}
});
