import assert from "node:assert/strict";
import test from "node:test";
import bashTimeoutExtension, { BASH_TIMEOUT_GUIDANCE } from "../bash-timeout.ts";

function hooks() {
	const handlers = new Map();
	bashTimeoutExtension({ on: (name, handler) => handlers.set(name, handler) });
	return handlers;
}

test("omitted timeout defaults to 60 without changing the command", () => {
	const input = { command: "echo ok" };
	assert.equal(hooks().get("tool_call")({ toolName: "bash", input }), undefined);
	assert.deepEqual(input, { command: "echo ok", timeout: 60 });
});

test("valid positive timeouts including the boundary are unchanged", () => {
	const hook = hooks().get("tool_call");
	for (const timeout of [0.1, 1, 60, 120, 299.9, 300]) {
		const input = { command: "echo ok", timeout };
		assert.equal(hook({ toolName: "bash", input }), undefined);
		assert.deepEqual(input, { command: "echo ok", timeout });
	}
});

test("explicit invalid and excessive values block execution without rewriting input", () => {
	const hook = hooks().get("tool_call");
	for (const timeout of [null, 0, -1, NaN, Infinity, -Infinity, "300", false, 300.1, 301, 5000, Number.MAX_VALUE]) {
		const input = { command: "echo MUST_NOT_RUN", timeout };
		const result = hook({ toolName: "bash", input });
		assert.equal(result.block, true);
		assert.match(result.reason, /NOT executed/);
		assert.match(result.reason, /greater than 0 and at most 300/);
		assert.match(result.reason, /60s default/);
		assert.deepEqual(input, { command: "echo MUST_NOT_RUN", timeout });
	}
});

test("nested calls use the same policy and retain no cross-call state", () => {
	const hook = hooks().get("tool_call");
	const event = { toolName: "bash", parentToolCallId: "parent", toolCallId: "parent/1" };
	assert.equal(hook({ ...event, input: { timeout: 5000 } }).block, true);
	assert.equal(hook({ ...event, input: { timeout: 300 } }), undefined);
	const input = { command: "echo nested" };
	assert.equal(hook({ ...event, input }), undefined);
	assert.equal(input.timeout, 60);
});

test("non-Bash tools are untouched", () => {
	const input = { timeout: 5000 };
	assert.equal(hooks().get("tool_call")({ toolName: "read_url", input }), undefined);
	assert.deepEqual(input, { timeout: 5000 });
});

test("prompt guidance is appended once and describes rejection", () => {
	const hook = hooks().get("before_agent_start");
	const result = hook({ systemPrompt: "Existing find policy." });
	assert.equal(result.systemPrompt, `Existing find policy.\n\n${BASH_TIMEOUT_GUIDANCE}`);
	assert.match(result.systemPrompt, /rejected before execution, not clamped/);
	assert.equal(hook(result), undefined);
});

test("no result rewriting or correction tracking hooks remain", () => {
	assert.deepEqual([...hooks().keys()], ["before_agent_start", "tool_call"]);
});
