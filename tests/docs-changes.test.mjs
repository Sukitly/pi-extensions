import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const tuiUrl = pathToFileURL(join(root, "@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js")).href;
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		return nextResolve(specifier === "@earendil-works/pi-tui" ? tuiUrl : specifier, context);
	},
});
const { default: extension } = await import("../docs-changes.ts");
hooks.deregister();

function fixture(t) {
	const cwd = mkdtempSync(join(tmpdir(), "docs-changes-test-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	function git(...args) {
		const result = spawnSync("git", args, { cwd, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	}
	function write(path, content = "new\n") {
		mkdirSync(dirname(join(cwd, path)), { recursive: true });
		writeFileSync(join(cwd, path), content);
	}
	git("init", "-q");
	git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "Initial");
	return { cwd, git, write };
}

async function render(cwd) {
	const handlers = new Map();
	const calls = [];
	let widget;
	extension({
		on: (name, handler) => handlers.set(name, handler),
		exec: async (command, args) => {
			calls.push(args);
			const result = spawnSync(command, args, { cwd, encoding: "utf8" });
			return { code: result.status, stdout: result.stdout, stderr: result.stderr };
		},
	});
	handlers.get("session_start")({}, {
		cwd,
		hasUI: true,
		ui: { setWidget: (_id, factory) => { widget = factory; } },
	});
	await new Promise((resolve) => setImmediate(resolve));
	const text = widget?.({}, { fg: (_color, value) => value }).render(500).join("\n");
	return { text, calls };
}

for (const directory of ["agent-docs", "docs"]) {
	test(`${directory}: tracked/untracked changes, relative paths and index exclusions`, async (t) => {
		const { cwd, git, write } = fixture(t);
		write(`${directory}/modified.md`, "old\n");
		write(`${directory}/deleted.md`, "old\n");
		git("add", ".");
		git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "Docs");
		write(`${directory}/modified.md`);
		rmSync(join(cwd, directory, "deleted.md"));
		write(`${directory}/staged.md`);
		git("add", `${directory}/staged.md`);
		write(`${directory}/nested/new.md`);
		write(`${directory}/index.md`);
		write(`${directory}/nested/index.md`);
		if (directory === "agent-docs") write("docs/ignored.md");
		const { text, calls } = await render(cwd);
		assert.match(text, /~modified\.md/);
		assert.match(text, /-deleted\.md/);
		assert.match(text, /\+staged\.md/);
		assert.match(text, /\+nested\/new\.md/);
		assert.doesNotMatch(text, /index\.md|ignored\.md|agent-docs\/|docs\//);
		assert.equal(calls.length, 2);
		assert.ok(calls.every((args) => args.at(-1) === `${directory}/`));
	});
}

test("existing empty agent-docs does not fall back to changed docs", async (t) => {
	const { cwd, write } = fixture(t);
	mkdirSync(join(cwd, "agent-docs"));
	write("docs/changed.md");
	const { text, calls } = await render(cwd);
	assert.equal(text, undefined);
	assert.equal(calls.length, 2);
	assert.ok(calls.every((args) => args.at(-1) === "agent-docs/"));
});

test("neither directory exists: widget hidden without Git inspection", async (t) => {
	const { cwd } = fixture(t);
	const { text, calls } = await render(cwd);
	assert.equal(text, undefined);
	assert.deepEqual(calls, []);
});
