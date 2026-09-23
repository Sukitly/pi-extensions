import assert from "node:assert/strict";
import test from "node:test";
import extension from "../tps.ts";

function assistant({ input = 0, output = 1, cacheRead = 0, cacheWrite = 0 } = {}) {
	return {
		role: "assistant",
		usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite },
	};
}

function notification(messages) {
	const handlers = new Map();
	const notices = [];
	extension({ on: (name, handler) => handlers.set(name, handler) });
	const originalNow = Date.now;
	let now = 0;
	Date.now = () => now;
	try {
		handlers.get("agent_start")();
		now = 1000;
		handlers.get("agent_end")({ messages }, { hasUI: true, ui: { notify: (text, level) => notices.push({ text, level }) } });
	} finally {
		Date.now = originalNow;
	}
	return notices;
}

test("reports aggregate prompt cache-hit percentage after total, including cache writes in the denominator", () => {
	const notices = notification([
		assistant({ input: 10, output: 5, cacheRead: 80, cacheWrite: 10 }),
		{ role: "toolResult", usage: { input: 1000, cacheRead: 1000 } },
		assistant({ input: 10, output: 5, cacheRead: 10, cacheWrite: 90 }),
	]);
	assert.deepEqual(notices, [{ text: "TPS 10.0 tok/s. out 10, in 20, total 220, cache hit 43%, 1.0s", level: "info" }]);
});

test("omits cache-hit percentage when there are no prompt tokens", () => {
	assert.deepEqual(notification([assistant({ output: 3 })]), [
		{ text: "TPS 3.0 tok/s. out 3, in 0, total 3, 1.0s", level: "info" },
	]);
});

test("distinguishes full hits and near-full partial hits", () => {
	assert.match(notification([assistant({ input: 10 })])[0].text, /cache hit 0%, 1\.0s$/);
	assert.match(notification([assistant({ cacheRead: 10_000 })])[0].text, /total 10,001, cache hit 100%, 1\.0s$/);
	assert.match(notification([assistant({ input: 14, cacheRead: 986 })])[0].text, /cache hit 99%, 1\.0s$/);
	assert.match(notification([assistant({ input: 5, cacheRead: 995 })])[0].text, /cache hit 99\.5%, 1\.0s$/);
	assert.match(notification([assistant({ input: 6, cacheRead: 9_994 })])[0].text, /cache hit 99\.9%, 1\.0s$/);
	assert.match(notification([assistant({ input: 1, cacheRead: Number.MAX_SAFE_INTEGER - 1 })])[0].text, /cache hit 99\.99999999999999%, 1\.0s$/);
});

test("does not notify when the agent produces no output", () => {
	assert.deepEqual(notification([assistant({ input: 10, output: 0, cacheRead: 5 })]), []);
});
