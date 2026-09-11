import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";

// Exercise the actual Git helpers without loading the footer's Pi/TUI runtime.
const source = readFileSync(new URL("../git-diff-stats.ts", import.meta.url), "utf8");
const helpers = source.slice(source.indexOf("async function git("), source.indexOf("function countLines("));
const resolveDiffBase = new Function("readFileSync", "isAbsolute", "join", "EXEC_TIMEOUT_MS",
	stripTypeScriptTypes(helpers) + "\nreturn resolveDiffBase;",
)(readFileSync, isAbsolute, join, 5000);
const pi = {
	async exec(command, args, options) {
		const result = spawnSync(command, args, { cwd: options.cwd, timeout: options.timeout, encoding: "utf8" });
		return { code: result.status, stdout: result.stdout, stderr: result.stderr };
	},
};

function repo(t) {
	const cwd = mkdtempSync(join(tmpdir(), "diff-stats-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const git = (...args) => {
		const result = spawnSync("git", args, { cwd, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	git("init", "-b", "main");
	git("config", "user.name", "Test");
	git("config", "user.email", "test@example.invalid");
	git("config", "commit.gpgsign", "false");
	const commit = (file, text) => {
		writeFileSync(join(cwd, file), text);
		git("add", file);
		git("commit", "-m", file);
		return git("rev-parse", "HEAD");
	};
	const fork = commit("shared", "original\n");
	git("checkout", "-b", "feature");
	commit("local", "local\n");
	git("checkout", "main");
	const upstream = commit("upstream", "upstream\nmore upstream\n");
	git("checkout", "feature");
	return { cwd, git, commit, fork, upstream };
}

async function stats(cwd) {
	const base = await resolveDiffBase(pi, cwd, "main");
	return (await pi.exec("git", ["diff", "--numstat", base, "--"], { cwd, timeout: 5000 })).stdout.trim();
}

test("ordinary branch, pending merge, commit, and abort preserve local-only counts", async (t) => {
	const { cwd, git, fork, upstream } = repo(t);
	assert.equal(await resolveDiffBase(pi, cwd, "main"), fork);
	assert.equal(await stats(cwd), "1\t0\tlocal");
	git("merge", "--no-ff", "--no-commit", "main");
	assert.equal(await resolveDiffBase(pi, cwd, "main"), upstream);
	assert.equal(await stats(cwd), "1\t0\tlocal");
	git("merge", "--abort");
	assert.equal(await resolveDiffBase(pi, cwd, "main"), fork);
	assert.equal(await stats(cwd), "1\t0\tlocal");
	git("merge", "--no-ff", "--no-commit", "main");
	const pending = await stats(cwd);
	git("commit", "-m", "merge");
	assert.equal(await stats(cwd), pending);
});

test("resolved conflict has identical counts before and after merge commit", async (t) => {
	const { cwd, git, commit } = repo(t);
	commit("shared", "feature version\n");
	git("checkout", "main");
	commit("shared", "upstream version\n");
	git("checkout", "feature");
	const merge = await pi.exec("git", ["merge", "--no-commit", "main"], { cwd, timeout: 5000 });
	assert.equal(merge.code, 1);
	writeFileSync(join(cwd, "shared"), "resolved version\n");
	git("add", "shared");
	const pending = await stats(cwd);
	assert.equal(pending, "1\t0\tlocal\n1\t1\tshared");
	git("commit", "-m", "resolve");
	assert.equal(await stats(cwd), pending);
});

test("octopus merge reads later heads and retains another feature's unique work", async (t) => {
	const { cwd, git, commit, fork, upstream } = repo(t);
	git("checkout", "-b", "other", fork);
	const other = commit("other", "other work\n");
	git("checkout", "feature");
	git("merge", "--no-ff", "--no-commit", "other", "main");
	const mergePath = git("rev-parse", "--git-path", "MERGE_HEAD");
	const path = isAbsolute(mergePath) ? mergePath : join(cwd, mergePath);
	assert.deepEqual(new Set(readFileSync(path, "utf8").trim().split("\n")), new Set([other, upstream]));
	// Ensure the upstream head is second, regardless of Git's chosen order.
	writeFileSync(path, `${other}\n${upstream}\n`);
	assert.equal(await resolveDiffBase(pi, cwd, "main"), upstream);
	assert.equal(await stats(cwd), "1\t0\tlocal\n1\t0\tother");
	git("commit", "-m", "octopus");
	assert.equal(await stats(cwd), "1\t0\tlocal\n1\t0\tother");
});

test("merging only another feature does not advance to unmerged upstream", async (t) => {
	const { cwd, git, commit, fork } = repo(t);
	git("checkout", "-b", "other", fork);
	commit("other", "other work\n");
	git("checkout", "feature");
	git("merge", "--no-ff", "--no-commit", "other");
	assert.equal(await resolveDiffBase(pi, cwd, "main"), fork);
	assert.equal(await stats(cwd), "1\t0\tlocal\n1\t0\tother");
});

test("incomparable bases conservatively retain the HEAD-side base", async (t) => {
	const { cwd, git, commit, fork, upstream } = repo(t);
	git("checkout", "-b", "side", fork);
	const side = commit("side", "side work\n");
	git("checkout", "main");
	git("merge", "--no-ff", "-m", "integrate side", "side");
	git("checkout", "-b", "from-upstream", upstream);
	commit("own", "own work\n");
	git("merge", "--no-ff", "--no-commit", side);
	assert.equal(await resolveDiffBase(pi, cwd, "main"), upstream);
});

test("linked worktree and nested cwd locate the correct MERGE_HEAD", async (t) => {
	const { cwd, git, upstream } = repo(t);
	const linked = join(cwd, "linked");
	git("worktree", "add", "-b", "linked-feature", linked, "feature");
	const result = await pi.exec("git", ["merge", "--no-ff", "--no-commit", "main"], { cwd: linked, timeout: 5000 });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(await resolveDiffBase(pi, linked, "main"), upstream);
	const nested = mkdtempSync(join(linked, "nested-"));
	assert.equal(await resolveDiffBase(pi, nested, "main"), upstream);
	assert.equal(await stats(linked), "1\t0\tlocal");
});

test("missing base and unrelated history keep HEAD fallback", async (t) => {
	const { cwd, git, commit } = repo(t);
	assert.equal(await resolveDiffBase(pi, cwd, null), "HEAD");
	assert.equal(await resolveDiffBase(pi, cwd, "missing-ref"), "HEAD");
	git("checkout", "--orphan", "unrelated");
	git("rm", "-rf", ".");
	commit("unrelated", "new root\n");
	assert.equal(await resolveDiffBase(pi, cwd, "main"), "HEAD");
});
