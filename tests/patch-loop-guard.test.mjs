import assert from "node:assert/strict";
import test from "node:test";

import patchLoopGuard, { THRESHOLD } from "../patch-loop-guard.ts";

function load() {
	const handlers = new Map();
	patchLoopGuard({ on: (event, handler) => handlers.set(event, handler) });
	const ctx = { cwd: "/repo" };
	return {
		startSession: () => handlers.get("session_start")({}, ctx),
		edit: (target, { toolName = "edit", isError = false } = {}) =>
			handlers.get("tool_result")(
				{ toolName, isError, input: { path: target }, content: [{ type: "text", text: "ok" }] },
				ctx,
			),
	};
}

test("reminds once when a file crosses the edit threshold", () => {
	const { edit } = load();
	for (let i = 1; i < THRESHOLD; i++) assert.equal(edit("a.ts"), undefined);

	const result = edit("a.ts");
	assert.equal(result.content.length, 2);
	assert.match(result.content[1].text, new RegExp(`modified a\\.ts ${THRESHOLD} times`));

	assert.equal(edit("a.ts"), undefined, "later edits must not repeat the reminder");
});

test("counts a file once regardless of how its path is spelled", () => {
	const { edit } = load();
	assert.equal(edit("a.ts"), undefined);
	assert.equal(edit("/repo/a.ts"), undefined);
	assert.ok(edit("./a.ts"), "relative and absolute paths must share one counter");
});

test("ignores failed edits, other tools, and non-string paths", () => {
	const { edit } = load();
	for (let i = 0; i < THRESHOLD + 2; i++) {
		assert.equal(edit("a.ts", { isError: true }), undefined);
		assert.equal(edit("a.ts", { toolName: "read" }), undefined);
		assert.equal(edit(undefined), undefined);
	}
});

test("counts are per session", () => {
	const { edit, startSession } = load();
	for (let i = 1; i < THRESHOLD; i++) edit("a.ts");
	startSession();
	assert.equal(edit("a.ts"), undefined, "a new session starts the count over");
});
