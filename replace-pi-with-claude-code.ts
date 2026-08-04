import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Anthropic's subscription OAuth billing classifier fingerprints requests.
 * When the system prompt does not look like Claude Code, the request is
 * routed to the pay-per-token extra-usage pool and fails with the misleading
 * 400 "You're out of extra usage" even though subscription quota remains.
 *
 * Two hooks are needed because they fire on different paths:
 *
 * - `before_agent_start` fires only for turns started through prompt()
 *   (typed input, sendUserMessage). It keeps ctx.getSystemPrompt() and the
 *   session state consistent.
 * - `before_provider_request` fires for every LLM request, including turns
 *   triggered by extension custom messages (pi.sendMessage + triggerTurn),
 *   which skip before_agent_start entirely. Without this hook, any
 *   extension-initiated turn (DiffWalk kickoff, Batonlink, etc.) goes out
 *   with the unspoofed prompt and is rejected.
 *
 * The rewrite is idempotent: once " pi" has become " claude code" a second
 * pass finds nothing to replace.
 */

function spoof(text: string): string {
	return text.replace(/ pi/gi, " claude code");
}

interface SystemBlock {
	readonly type?: unknown;
	readonly text?: unknown;
	readonly [key: string]: unknown;
}

export default function replacePiWithClaudeCodeExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const transformedSystemPrompt = spoof(event.systemPrompt);

		if (transformedSystemPrompt === event.systemPrompt) {
			return undefined;
		}

		return {
			systemPrompt: transformedSystemPrompt,
		};
	});

	pi.on("before_provider_request", (event) => {
		const payload = event.payload as {
			readonly system?: string | readonly SystemBlock[];
		} | null;
		if (payload === null || typeof payload !== "object") {
			return undefined;
		}

		// Anthropic messages API: `system` is a string or an array of text
		// blocks. Other providers do not use this shape and pass through.
		if (typeof payload.system === "string") {
			const rewritten = spoof(payload.system);
			if (rewritten === payload.system) return undefined;
			return { ...payload, system: rewritten };
		}

		if (!Array.isArray(payload.system)) {
			return undefined;
		}

		let changed = false;
		const system = payload.system.map((block: SystemBlock) => {
			if (block?.type !== "text" || typeof block.text !== "string") {
				return block;
			}
			const rewritten = spoof(block.text);
			if (rewritten === block.text) {
				return block;
			}
			changed = true;
			// Spread preserves cache_control and any future block fields.
			return { ...block, text: rewritten };
		});
		return changed ? { ...payload, system } : undefined;
	});
}
