import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// PI_TEST_RUNTIME_DIR is the pi-coding-agent package directory, not its node_modules.
// Without it, resolve a project-local installation. Missing dependencies must fail,
// rather than silently skipping the native-auth interoperability tests.
let runtimeDir;
let runtimeRequire;
let createJiti;
let tuiEntry;
try {
	runtimeDir = process.env.PI_TEST_RUNTIME_DIR
		? resolve(process.env.PI_TEST_RUNTIME_DIR)
		: dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
	const manifest = JSON.parse(readFileSync(join(runtimeDir, "package.json"), "utf8"));
	if (manifest.name !== "@earendil-works/pi-coding-agent") throw new Error("Not a pi-coding-agent package directory");
	runtimeRequire = createRequire(join(runtimeDir, "package.json"));
	({ createJiti } = runtimeRequire("jiti"));
	tuiEntry = runtimeRequire.resolve("@earendil-works/pi-tui");
} catch (cause) {
	throw new Error("Account tests require Pi and its dependencies. Install @earendil-works/pi-coding-agent locally or set PI_TEST_RUNTIME_DIR to its package directory (see README.md).", { cause });
}

// Child workers use the exact same installation, including when the parent used
// project-local resolution or a relative configured path.
export const runtimeEnv = { PI_TEST_RUNTIME_DIR: runtimeDir };
export function createTestJiti(url) {
	return createJiti(url, { alias: {
		"@earendil-works/pi-coding-agent": runtimeDir,
		"@earendil-works/pi-tui": tuiEntry,
	} });
}
export async function loadNativeAuthStorage() {
	return import(pathToFileURL(join(runtimeDir, "dist/core/auth-storage.js")).href);
}
