import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const source = stripTypeScriptTypes(readFileSync(new URL("../message-timestamps.ts", import.meta.url), "utf8"))
	.replace(/^import .*;$/gm, "")
	.replace(/^export default function/gm, "function default_1")
	.replace(/^export function /gm, "function ");

const mockVisibleWidth = (str) => str.replace(/\x1b\[[0-9;]*m/g, "").length;
const mockTruncateToWidth = (str, width) => {
	let len = 0;
	let out = "";
	for (const ch of str) {
		len++;
		if (len > width) break;
		out += ch;
	}
	return out;
};

class MockText {
	constructor(text) {
		this.text = text;
	}
	render(width) {
		const lines = [];
		for (const raw of this.text.split("\n")) {
			let current = raw;
			while (current.length > width) {
				lines.push(current.slice(0, width));
				current = current.slice(width);
			}
			lines.push(current);
		}
		return lines;
	}
}

const moduleFactory = new Function(
	"Text",
	"visibleWidth",
	"truncateToWidth",
	`${source}\nreturn { default: default_1, formatTimestampText, formatTimestampBadge };`,
);
const { default: extension, formatTimestampText, formatTimestampBadge } = moduleFactory(
	MockText,
	mockVisibleWidth,
	mockTruncateToWidth,
);

test("formatTimestampText formats time correctly for today, same year, and across years", () => {
	const ref = new Date(2026, 4, 20, 12, 0, 0);

	const sameDay = new Date(2026, 4, 20, 9, 5, 8);
	assert.equal(formatTimestampText(sameDay, ref), "09:05:08");

	const differentDay = new Date(2026, 3, 15, 14, 30, 0);
	assert.equal(formatTimestampText(differentDay, ref), "04-15 14:30:00");

	const differentYear = new Date(2025, 11, 31, 23, 59, 59);
	assert.equal(formatTimestampText(differentYear, ref), "2025-12-31 23:59:59");
});

test("user message receives newline timestamp and avoids duplicate timestamp on re-render", async () => {
	const handlers = new Map();
	let registeredTransformer;

	const piMock = {
		on: (event, handler) => handlers.set(event, handler),
		registerMarkdownTransformer: (transformer) => {
			registeredTransformer = transformer;
		},
		registerToolRenderer: () => {},
	};

	extension(piMock);

	const ctxMock = {
		ui: { theme: undefined },
		sessionManager: { getEntries: () => [] },
	};

	await handlers.get("input")({ text: "Hello agent" }, ctxMock);

	const renderedOnce = registeredTransformer("Hello agent", {
		messageType: "user",
		isStreaming: false,
		availableWidth: 80,
	});

	assert.match(renderedOnce, /^Hello agent\n\x1b\[2m\d{2}:\d{2}:\d{2}\x1b\[22m$/);

	const renderedTwice = registeredTransformer(renderedOnce, {
		messageType: "user",
		isStreaming: false,
		availableWidth: 80,
	});

	assert.equal(renderedTwice, renderedOnce);
});

test("assistant message suppresses timestamp during streaming and appends newline timestamp on completion", async () => {
	const handlers = new Map();
	let registeredTransformer;

	const piMock = {
		on: (event, handler) => handlers.set(event, handler),
		registerMarkdownTransformer: (transformer) => {
			registeredTransformer = transformer;
		},
		registerToolRenderer: () => {},
	};

	extension(piMock);

	const streamingRender = registeredTransformer("Streaming output...", {
		messageType: "assistant",
		isStreaming: true,
		availableWidth: 80,
	});
	assert.equal(streamingRender, "Streaming output...");

	const ctxMock = {
		ui: { theme: undefined },
		sessionManager: { getEntries: () => [] },
	};
	await handlers.get("message_end")({ message: { role: "assistant" } }, ctxMock);

	const completedRender = registeredTransformer("Streaming output...", {
		messageType: "assistant",
		isStreaming: false,
		availableWidth: 80,
	});
	assert.match(completedRender, /^Streaming output\.\.\.\n\x1b\[2m\d{2}:\d{2}:\d{2}\x1b\[22m$/);
});

test("tool renderer keeps timestamp on the same line as Took or status text", async () => {
	let toolRendererResolver;

	const piMock = {
		on: () => {},
		registerMarkdownTransformer: () => {},
		registerToolRenderer: (resolver) => {
			toolRendererResolver = resolver;
		},
	};

	extension(piMock);

	const baseRenderers = {
		renderCall: () => ({ render: () => ["$ echo hi"] }),
		renderResult: () => ({ render: () => ["", "Took 0.1s"] }),
	};

	const resolved = toolRendererResolver("bash", () => baseRenderers);

	const partialComponent = resolved.renderResult(
		{ content: [{ type: "text", text: "" }] },
		{ isPartial: true, expanded: false },
		undefined,
		{ toolCallId: "call_1" },
	);
	assert.deepEqual(partialComponent.render(80), ["", "Took 0.1s"]);

	const completedComponent = resolved.renderResult(
		{ content: [{ type: "text", text: "" }] },
		{ isPartial: false, expanded: false },
		undefined,
		{ toolCallId: "call_1" },
	);
	const completedLines = completedComponent.render(80);
	assert.equal(completedLines.length, 2);
	assert.equal(completedLines[0], "");
	assert.match(completedLines[1], /^Took 0\.1s  \x1b\[2m\d{2}:\d{2}:\d{2}\x1b\[22m$/);
});

test("tool renderer wraps fallback long lines and ensures rendered lines never exceed terminal width", async () => {
	let toolRendererResolver;

	const piMock = {
		on: () => {},
		registerMarkdownTransformer: () => {},
		registerToolRenderer: (resolver) => {
			toolRendererResolver = resolver;
		},
	};

	extension(piMock);

	const resolved = toolRendererResolver("google_search", () => undefined);

	const longLine = "A".repeat(300);
	const completedComponent = resolved.renderResult(
		{ content: [{ type: "text", text: longLine }] },
		{ isPartial: false, expanded: false },
		undefined,
		{ toolCallId: "call_search_1" },
	);

	const width = 117;
	const lines = completedComponent.render(width);
	for (const line of lines) {
		assert.ok(mockVisibleWidth(line) <= width, `Line length ${mockVisibleWidth(line)} exceeds terminal width ${width}`);
	}
});
