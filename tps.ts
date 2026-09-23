import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	const role = (message as { role?: unknown }).role;
	return role === "assistant";
}

// Round the prompt cache-read share without showing 100% for a partial hit.
function formatCacheHitPercent(cacheRead: number, promptTokens: number): string | null {
	if (promptTokens === 0) return null;
	const missed = promptTokens - cacheRead;
	if (missed === 0) return "100";

	// Compare integer thresholds to avoid floating-point rounding near 100%.
	const quotient = Math.floor(promptTokens / 200);
	const remainder = promptTokens % 200;
	let lower = 0;
	let upper = 100;
	while (lower < upper) {
		const candidate = Math.floor((lower + upper + 1) / 2);
		const factor = candidate * 2 - 1;
		const threshold = factor * quotient + Math.ceil((factor * remainder) / 200);
		if (cacheRead >= threshold) lower = candidate;
		else upper = candidate - 1;
	}
	if (lower < 100) return String(lower);

	let places = 1;
	let scaledDoubleGap = missed * 200;
	const denominatorTens = Math.floor(promptTokens / 10);
	while (scaledDoubleGap <= denominatorTens) {
		scaledDoubleGap *= 10;
		places++;
	}
	const denominatorOnes = promptTokens % 10;
	let roundedLoss = 5;
	for (let loss = 1; loss < 5; loss++) {
		const factor = loss * 2 + 1;
		if (scaledDoubleGap <= factor * denominatorTens + Math.floor((factor * denominatorOnes) / 10)) {
			roundedLoss = loss;
			break;
		}
	}
	return `99.${"9".repeat(places - 1)}${10 - roundedLoss}`;
}

export default function (pi: ExtensionAPI) {
	let agentStartMs: number | null = null;

	pi.on("agent_start", () => {
		agentStartMs = Date.now();
	});

	pi.on("agent_end", (event, ctx) => {
		if (!ctx.hasUI) return;
		if (agentStartMs === null) return;

		const elapsedMs = Date.now() - agentStartMs;
		agentStartMs = null;
		if (elapsedMs <= 0) return;

		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let totalTokens = 0;

		for (const message of event.messages) {
			if (!isAssistantMessage(message)) continue;
			input += message.usage.input || 0;
			output += message.usage.output || 0;
			cacheRead += message.usage.cacheRead || 0;
			cacheWrite += message.usage.cacheWrite || 0;
			totalTokens += message.usage.totalTokens || 0;
		}

		if (output <= 0) return;

		const elapsedSeconds = elapsedMs / 1000;
		const tokensPerSecond = output / elapsedSeconds;
		const cacheHit = formatCacheHitPercent(cacheRead, input + cacheRead + cacheWrite);
		const message = `TPS ${tokensPerSecond.toFixed(1)} tok/s. out ${output.toLocaleString()}, in ${input.toLocaleString()}, total ${totalTokens.toLocaleString()}${cacheHit === null ? "" : `, cache hit ${cacheHit}%`}, ${elapsedSeconds.toFixed(1)}s`;
		ctx.ui.notify(message, "info");
	});
}
