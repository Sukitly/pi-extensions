import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, copyFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { runtimeEnv } from "./runtime.mjs";

const exec = promisify(execFile);
const probe = path => `const runtime = await import(${JSON.stringify(path)});
const { AuthStorage } = await runtime.loadNativeAuthStorage();
if (typeof AuthStorage.create !== 'function') throw new Error('Missing native auth storage');
if (typeof runtime.createTestJiti(import.meta.url).import !== 'function') throw new Error('Missing Jiti');
console.log('runtime loaded');`;

test("test runtime loader supports an explicitly configured installation", async () => {
	const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", probe(new URL("./runtime.mjs", import.meta.url).href)], {
		env: { ...process.env, ...runtimeEnv }, timeout: 10_000,
	});
	assert.match(stdout, /runtime loaded/);
});

test("test runtime loader resolves project dependencies without a configured path", async t => {
	const dir = await mkdtemp(join(tmpdir(), "pi-test-runtime-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const loader = join(dir, "runtime.mjs");
	await copyFile(new URL("./runtime.mjs", import.meta.url), loader);
	const scope = join(dir, "node_modules", "@earendil-works");
	await mkdir(scope, { recursive: true });
	await symlink(runtimeEnv.PI_TEST_RUNTIME_DIR, join(scope, "pi-coding-agent"), "dir");
	const env = { ...process.env };
	delete env.PI_TEST_RUNTIME_DIR;
	const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", probe(pathToFileURL(loader).href)], {
		cwd: dir, env, timeout: 10_000,
	});
	assert.match(stdout, /runtime loaded/);
});

test("missing configured runtime fails with setup instructions instead of skipping tests", async t => {
	const dir = await mkdtemp(join(tmpdir(), "pi-test-missing-runtime-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await assert.rejects(exec(process.execPath, ["--input-type=module", "-e", probe(new URL("./runtime.mjs", import.meta.url).href)], {
		env: { ...process.env, PI_TEST_RUNTIME_DIR: dir }, timeout: 10_000,
	}), error => {
		assert.match(error.stderr, /Account tests require Pi and its dependencies/);
		assert.match(error.stderr, /PI_TEST_RUNTIME_DIR/);
		return true;
	});
});
