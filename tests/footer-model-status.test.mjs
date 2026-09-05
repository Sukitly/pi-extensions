import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Exercise the installed FooterComponent/ANSI utilities, without starting Pi,
// running Git, reading the real Fast preference, or requesting a model.
const root = join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const footerUrl = pathToFileURL(join(root, "dist/modes/interactive/components/footer.js")).href;
const tuiUrl = pathToFileURL(join(root, "node_modules/@earendil-works/pi-tui/dist/index.js")).href;
const { getThemeByName, setThemeInstance } = await import(pathToFileURL(join(root, "dist/modes/interactive/theme/theme.js")));
const theme = getThemeByName("dark");
assert.ok(theme);
setThemeInstance(theme);
const { stripTerminalSequences: plain, visibleWidth } = await import(tuiUrl);
const { FooterComponent } = await import(footerUrl);
// The installed package's unbundled barrel references an optional server package.
// Resolve only the runtime exports this extension actually uses for these tests.
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-coding-agent") return nextResolve(footerUrl, context);
		if (specifier === "@earendil-works/pi-tui") return nextResolve(tuiUrl, context);
		return nextResolve(specifier, context);
	},
});
const { default: extension } = await import("../git-diff-stats.ts");
hooks.deregister();

const yellowFast = theme.fg("warning", "fast");
const KEY = "model:codex-fast";

function createFooter({ statuses = new Map([[KEY, yellowFast]]), gitStats = false, model, thinkingLevel = "max", providers = 2 } = {}) {
	const handlers = new Map();
	let component;
	let entryReads = 0;
	const footerData = {
		getGitBranch: () => "feature",
		getExtensionStatuses: () => statuses,
		getAvailableProviderCount: () => providers,
		onBranchChange: () => () => {},
	};
	const ctx = {
		mode: "tui",
		cwd: "/virtual/project",
		model: model ?? { provider: "openai-codex", id: "gpt-6-astra", reasoning: true, contextWindow: 131072 },
		thinkingLevel,
		sessionManager: {
			getEntries: () => { entryReads++; return []; },
			getCwd: () => "/virtual/中文-project",
			getSessionName: () => "display test",
		},
		getContextUsage: () => ({ percent: 12.5, tokens: 16384, contextWindow: 131072 }),
		modelRegistry: { isUsingOAuth: () => false },
		ui: { setFooter: (factory) => { component = factory({ requestRender() {} }, theme, footerData); } },
	};
	extension({
		on: (name, handler) => handlers.set(name, handler),
		exec: async (_command, args) => {
			if (!gitStats) return { code: 1, stdout: "", stderr: "" };
			if (args[0] === "symbolic-ref") return { code: 0, stdout: "origin/main\n" };
			if (args[0] === "merge-base") return { code: 0, stdout: "abc123\n" };
			if (args.includes("--numstat")) return { code: 0, stdout: "2\t1\tfile.ts\n" };
			if (args.includes("--quiet")) return { code: 1, stdout: "" };
			return { code: 0, stdout: "" };
		},
	});
	handlers.get("session_start")({}, ctx);
	const base = new FooterComponent({
		get state() { return { model: ctx.model, thinkingLevel: ctx.thinkingLevel }; },
		sessionManager: ctx.sessionManager,
		getContextUsage: ctx.getContextUsage,
		modelRuntime: { isUsingSubscription: () => false },
	}, { ...footerData, getExtensionStatuses: () => new Map([...statuses].filter(([key]) => !key.startsWith("model:"))) });
	return {
		ctx, statuses, component, base,
		entryReads: () => entryReads,
		render: (width = 120) => component.render(width),
	};
}

test("Fast is yellow after model/thinking, right-aligned, and has no separate status row", () => {
	const f = createFooter();
	const lines = f.render();
	assert.equal(lines.length, 2);
	assert.match(plain(lines[1]), /\(openai-codex\) gpt-6-astra • max • fast$/);
	assert.ok(lines[1].endsWith(yellowFast));
	assert.notEqual(yellowFast, theme.fg("dim", "fast"));
	assert.equal(visibleWidth(lines[1]), 120);
	assert.equal(f.entryReads(), 1, "Do not scan session history twice per render");
	f.component.dispose();
});

test("cwd and usage remain unchanged; badges also render without Git stats", () => {
	const f = createFooter();
	const expected = f.base.render(120);
	const actual = f.render();
	assert.equal(actual[0], expected[0]);
	assert.equal(plain(actual[1]).split(/ {2,}/)[0], plain(expected[1]).split(/ {2,}/)[0]);
	assert.match(plain(actual[1]), / • fast$/);
	f.component.dispose();
});

test("OFF restores the exact built-in layout and other extensions keep their status row", () => {
	const statuses = new Map([[KEY, yellowFast], ["export-dialogue", "Preparing export..."]]);
	const f = createFooter({ statuses });
	const on = f.render();
	assert.equal(on.length, 3);
	assert.equal(plain(on[2]), "Preparing export...");
	assert.ok(!plain(on[2]).includes("fast"));
	statuses.delete(KEY);
	assert.deepEqual(f.render(), f.base.render(120));
	f.component.dispose();
});

test("narrow layouts drop the provider first, then truncate without overflowing", () => {
	const f = createFooter();
	const compact = plain(f.render(52)[1]);
	assert.ok(!compact.includes("(openai-codex)"));
	assert.match(compact, /gpt-6-astra • max • fast$/);
	for (let width = 1; width <= 180; width++) {
		for (const line of f.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${plain(line)}`);
	}
	f.component.dispose();
});

test("when usage leaves no model slot, the original line is kept", () => {
	const f = createFooter();
	assert.deepEqual(f.render(12), f.base.render(12));
	f.component.dispose();
});

test("thinking off and non-reasoning models keep the built-in label semantics", () => {
	const off = createFooter({ thinkingLevel: "off" });
	assert.match(plain(off.render()[1]), /gpt-6-astra • thinking off • fast$/);
	off.component.dispose();
	const simple = createFooter({ model: { provider: "example", id: "simple", reasoning: false }, providers: 1 });
	assert.match(plain(simple.render()[1]), /simple • fast$/);
	assert.ok(!plain(simple.render()[1]).includes("max"));
	simple.component.dispose();
});

test("ANSI badges and wide model names remain within the terminal width", () => {
	const f = createFooter({ model: { provider: "openai-codex", id: "模型-测试", reasoning: true } });
	for (const width of [36, 45, 55, 80, 120]) {
		assert.ok(visibleWidth(f.render(width)[1]) <= width);
	}
	assert.match(plain(f.render()[1]), /模型-测试 • max • fast$/);
	assert.ok(f.render()[1].endsWith(yellowFast));
	f.component.dispose();
});

test("Git diff counts still decorate the cwd while Fast decorates the model row", async () => {
	const f = createFooter({ gitStats: true });
	await new Promise(resolve => setImmediate(resolve));
	const lines = f.render();
	assert.match(plain(lines[0]), /\+2 -1 \*$/);
	assert.match(plain(lines[1]), / • max • fast$/);
	assert.equal(lines.length, 2);
	f.component.dispose();
});

test("unknown Fast state stays yellow inline; empty badges do not add separators", () => {
	const statuses = new Map([[KEY, theme.fg("warning", "fast?")]]);
	const f = createFooter({ statuses });
	assert.ok(f.render()[1].endsWith(theme.fg("warning", "fast?")));
	statuses.set(KEY, "");
	assert.deepEqual(f.render(), f.base.render(120));
	f.component.dispose();
});
