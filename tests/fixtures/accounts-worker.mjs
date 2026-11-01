import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { createJiti } from "/Users/sukit/.pi/agent/install/releases/1.4.0/node_modules/jiti/lib/jiti.mjs";
import { sharedUsageFetch } from "../../shared/account-coordination.mjs";

const root = "/Users/sukit/.pi/agent/install/releases/1.4.0/node_modules/";
const jiti = createJiti(import.meta.url, { alias: {
	"@earendil-works/pi-coding-agent": `${root}@earendil-works/pi-coding-agent`,
	"@earendil-works/pi-tui": `${root}@earendil-works/pi-tui`,
} });
const mode = process.argv[2];
const dir = process.env.PI_CODING_AGENT_DIR;
const log = (event) => appendFile(join(dir, "requests.log"), `${event}\n`);
const send = (event, data) => process.send({ event, data });
const wait = (expected) => new Promise(resolve => {
	const listener = (message) => { if (message === expected) { process.off("message", listener); resolve(); } };
	process.on("message", listener);
});
// Fake all HTTP; this fixture never calls a live provider.
globalThis.fetch = async () => { throw new Error("Unexpected network request in worker"); };
const accounts = mode === "usage" || mode === "native" ? null : await jiti.import("../../oauth-accounts.ts");
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
	} else if (mode === "native") {
		const { AuthStorage } = await import(`${root}@earendil-works/pi-coding-agent/dist/core/auth-storage.js`);
		result = await AuthStorage.create(join(dir, "auth.json")).modify("test", async current => {
			send("locked");
			await wait("finish");
			return { ...current, access: `${current.access}-native`, refresh: `${current.refresh}-native`, expires: Date.now() + 36_000_000 };
		});
	} else if (mode === "caretaker") {
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
