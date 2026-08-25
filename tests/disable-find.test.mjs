import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import disableFindExtension, {
	FIND_PROMPT_GUIDANCE,
	isExplicitFindInvocation,
	loadFindPolicyAssets,
	prependFindShimPath,
	shellQuote,
} from "../disable-find.ts";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const extensionDirectory = resolve(testDirectory, "..");

const blockedCommands = [
	"/usr/bin/find . -type f",
	"echo ok && /usr/bin/find . -type f",
	"$(/usr/bin/find . -type f)",
	"sudo /usr/bin/find . -type f",
	"if /usr/bin/find . -type f; then echo ok; fi",
	"if true; then /usr/bin/find . -type f; fi",
	"`/usr/bin/find . -type f`",
];

const allowedCommandText = [
	"find . -type f",
	"rg a; find b .",
	"cat > notes.md <<EOF\nfind the config file first\nEOF",
	"cat > notes.md <<EOF\n/usr/bin/find is documented here\nEOF",
	"git commit -F - <<EOF\nfix search\n\nfind was slow\nEOF",
	"echo 'line1\n/usr/bin/find me\nline3' > a.txt",
	"printf '%s\\n' '/usr/bin/find . -type f'",
	"python3 -c $'\\nfind = 1\\nprint(find)'",
	"python3 -c $'\\npath = \"/usr/bin/find\"\\nprint(path)'",
	"# /usr/bin/find . -type f\necho ok",
];

test("explicit find classifier blocks path-qualified command invocations", () => {
	for (const command of blockedCommands) {
		assert.equal(isExplicitFindInvocation(command), true, command);
	}
});

test("explicit find classifier allows bare find and non-command text", () => {
	for (const command of allowedCommandText) {
		assert.equal(isExplicitFindInvocation(command), false, command);
	}
});

test("policy assets are executable, readable, and share one message", () => {
	const assets = loadFindPolicyAssets(extensionDirectory);
	const result = spawnSync(assets.shimPath, [], { encoding: "utf8" });

	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr.trimEnd(), assets.message);
});

test("missing policy assets fail fast", () => {
	assert.throws(
		() => loadFindPolicyAssets(resolve(extensionDirectory, "missing-assets")),
		/disable-find extension is incomplete/,
	);
});

test("shellQuote preserves literal paths with shell metacharacters", () => {
	const value = "/tmp/a b'c$HOME`echo-no`";
	const result = spawnSync("/bin/bash", ["-c", `value=${shellQuote(value)}; printf %s "$value"`], {
		encoding: "utf8",
	});

	assert.equal(result.status, 0);
	assert.equal(result.stdout, value);
});

test("PATH mutation is idempotent and routes bare find to the shim", () => {
	const assets = loadFindPolicyAssets(extensionDirectory);
	const command = prependFindShimPath("find . -type f", assets.shimDirectory);
	const result = spawnSync("/bin/bash", ["-c", command], { encoding: "utf8" });

	assert.equal(prependFindShimPath(command, assets.shimDirectory), command);
	assert.equal(result.status, 1);
	assert.equal(result.stderr.trimEnd(), assets.message);
});

test("extension declares policy before execution and gates only agent Bash calls", () => {
	const handlers = new Map();
	const pi = {
		on(name, handler) {
			handlers.set(name, handler);
		},
	};
	disableFindExtension(pi);

	const beforeAgentStart = handlers.get("before_agent_start");
	const toolCall = handlers.get("tool_call");
	assert.equal(typeof beforeAgentStart, "function");
	assert.equal(typeof toolCall, "function");

	const promptResult = beforeAgentStart({ systemPrompt: "base prompt" });
	assert.match(promptResult.systemPrompt, new RegExp(FIND_PROMPT_GUIDANCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

	const bashEvent = { toolName: "bash", input: { command: "find . -type f" } };
	assert.equal(toolCall(bashEvent), undefined);
	assert.match(bashEvent.input.command, /pi-disable-find/);

	const explicitEvent = { toolName: "bash", input: { command: "/usr/bin/find . -type f" } };
	const blocked = toolCall(explicitEvent);
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /find is disabled/);

	const nonBashEvent = { toolName: "read", input: { path: "find.txt" } };
	assert.equal(toolCall(nonBashEvent), undefined);
	assert.deepEqual(nonBashEvent.input, { path: "find.txt" });
});
