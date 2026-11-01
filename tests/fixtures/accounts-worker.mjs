import { appendFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createTestJiti, loadNativeAuthStorage } from "../runtime.mjs";
import { sharedUsageFetch, digest } from "../../shared/account-coordination.mjs";

const jiti = createTestJiti(import.meta.url);
const mode = process.argv[2];
const dir = process.env.PI_CODING_AGENT_DIR;
const log = (event) => appendFile(join(dir, "requests.log"), `${event}\n`);
const send = (event, data) => process.send({ event, data });
const wait = (expected) => new Promise(resolve => {
	const listener = (message) => { if (message === expected) { process.off("message", listener); resolve(); } };
	process.on("message", listener);
});
// Observe the real service-lock boundary without adding hooks to production code.
if (mode.includes("profile")) {
	const lockfile = createRequire(new URL("../../shared/account-coordination.mjs", import.meta.url))("proper-lockfile");
	const originalLock = lockfile.lock;
	const gate = join(dir, "usage-cache", `${digest("https://api.anthropic.com")}.gate.json`);
	lockfile.lock = (path, ...args) => {
		if (path === gate) send("profile-gate");
		return originalLock(path, ...args);
	};
}
// Fake all HTTP; this fixture never calls a live provider.
let profileCalls = 0;
globalThis.fetch = async (url) => {
	if (!mode.includes("profile") || !String(url).endsWith("/api/oauth/profile")) throw new Error("Unexpected network request in worker");
	profileCalls++;
	send("profile-started");
	if (mode === "sync-profile-held" && profileCalls === 1) await wait("profile-finish");
	return Response.json({ account: { uuid: "profile-A", email: "profile-a@example.com" } });
};
const accounts = mode === "usage" || mode.startsWith("native") ? null : await jiti.import("../../oauth-accounts.ts");
const registry = {
	getProvider: () => ({ auth: { oauth: { refresh: async (credential) => {
		await log(`refresh:${credential.refresh}`);
		send("refreshing");
		if (mode === "switch-fails") throw new Error("invalid_grant: revoked");
		if (mode === "switch-held") await wait("finish");
		else await new Promise(resolve => setTimeout(resolve, 100));
		return { ...credential, access: `${credential.access}-new`, refresh: `${credential.refresh}-new`, expires: Date.now() + 36_000_000 };
	} } } }),
	refresh: async () => {},
};
send("ready");
await wait("go");
try {
	let result;
	if (mode === "usage") {
		const response = await sharedUsageFetch("https://quota.example/usage", { headers: { Authorization: "Bearer worker-secret" } }, async () => {
			await log("usage");
			await new Promise(resolve => setTimeout(resolve, 100));
			return Response.json({ used: 25 });
		});
		result = await response.json();
	} else if (mode.startsWith("native")) {
		const { AuthStorage } = await loadNativeAuthStorage();
		result = await AuthStorage.create(join(dir, "auth.json")).modify(process.argv[3] || "test", async current => {
			send("locked");
			await wait("finish");
			if (mode === "native-replace") return JSON.parse(process.argv[4]);
			return { ...current, access: `${current.access}-native`, refresh: `${current.refresh}-native`, expires: Date.now() + 36_000_000 };
		});
	} else if (mode.startsWith("sync-profile")) {
		result = await accounts.syncLiveToStore();
	} else if (mode === "delete-profile") {
		result = await accounts.deleteAccount(process.argv[3], registry);
	} else if (mode === "caretaker" || mode === "caretaker-profile") {
		result = await accounts.runGlobalCaretaker(registry, { force: true, skipDelay: true });
	} else if (mode === "caretaker-normal") {
		result = await accounts.runGlobalCaretaker(registry, { skipDelay: true });
	} else if (mode === "rename") {
		result = await accounts.renameAccount(process.argv[3], process.argv[4]);
	} else {
		send("switching");
		result = await accounts.switchAccount({ modelRegistry: registry }, process.argv[3]);
	}
	send("done", result);
} catch (error) {
	send("error", String(error.stack));
	process.exitCode = 1;
}
process.disconnect();
