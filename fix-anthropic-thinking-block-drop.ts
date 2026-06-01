/**
 * Workaround for: Anthropic Opus/Sonnet 4.8 returns 400
 *   "thinking or redacted_thinking blocks in the latest assistant message
 *    cannot be modified"
 *
 * Root cause (in pi-ai@0.78.0 dist/providers/anthropic.js):
 *   When converting an assistant message to the Anthropic API payload,
 *   pi-ai unconditionally drops any thinking block whose visible text is
 *   empty -- even when the signature is present. In display:"summarized"
 *   adaptive thinking (default on Opus 4.7+, common on Opus/Sonnet 4.8),
 *   the model frequently produces signed thinking blocks with an empty
 *   summary, especially around tool calls. Opus/Sonnet 4.8 validates
 *   thinking-block structure strictly and 400s when one is missing on
 *   replay; 4.7 was more lenient.
 *
 * This extension intercepts the Anthropic payload just before send,
 * compares each assistant message against the original session-stored
 * AgentMessage, and reinjects any signed empty-text thinking block that
 * pi-ai silently dropped. Same-model only (cross-model thinking drops in
 * pi-ai's transform-messages.js are intentional and we don't touch them).
 *
 * Remove once upstream pi-ai keeps signed thinking blocks regardless of
 * text emptiness. Tracking: anthropics/claude-code#63412 (symptom) plus
 * the pi-ai bug described above.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ANTHROPIC_API = "anthropic-messages";

type AnyContent = Record<string, unknown> & { type: string };

interface AnthropicPayload {
	model?: string;
	messages?: Array<{ role: string; content: AnyContent[] }>;
}

interface SessionAssistant {
	role: "assistant";
	provider?: string;
	api?: string;
	model?: string;
	stopReason?: string;
	content: Array<AnyContent>;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload as AnthropicPayload | undefined;
		const model = ctx.model;
		if (!payload || !Array.isArray(payload.messages) || !model) return;
		if (model.api !== ANTHROPIC_API) return;

		// Collect session assistant messages in branch order, skipping the same
		// ones pi-ai's transform-messages.js skips (errored / aborted turns).
		const sessionAssistants: SessionAssistant[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = (entry as { message?: SessionAssistant }).message;
			if (!msg || msg.role !== "assistant") continue;
			if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;
			sessionAssistants.push(msg);
		}

		// Indices of assistant messages in the payload (compaction may have
		// dropped some prefix; the latest one is always present).
		const payloadAssistantIdxs: number[] = [];
		for (let i = 0; i < payload.messages.length; i++) {
			if (payload.messages[i].role === "assistant") payloadAssistantIdxs.push(i);
		}

		// Align from the tail. Stop if alignment breaks.
		let p = payloadAssistantIdxs.length - 1;
		let s = sessionAssistants.length - 1;
		let totalInjected = 0;

		while (p >= 0 && s >= 0) {
			const payloadMsg = payload.messages[payloadAssistantIdxs[p]];
			const sessionMsg = sessionAssistants[s];

			// Cross-model drops are intentional in pi-ai. Only repair same-model turns.
			const sameModel =
				sessionMsg.provider === model.provider &&
				sessionMsg.api === model.api &&
				sessionMsg.model === model.id;

			if (sameModel) {
				const result = repairContent(sessionMsg.content, payloadMsg.content);
				if (result.injected > 0) {
					payloadMsg.content = result.content;
					totalInjected += result.injected;
				}
			}

			p--;
			s--;
		}

		if (totalInjected > 0) {
			ctx.ui.setStatus(
				"fix-anthropic-thinking",
				`reinjected ${totalInjected} signed thinking block(s)`,
			);
		}
		return payload;
	});
}

/**
 * Walk the session content in order and rebuild the API content array,
 * predicting which blocks pi-ai's anthropic.js kept vs dropped so we can
 * splice the buggy drops back in at the correct positions.
 *
 * If our prediction disagrees with the actual payload (length mismatch
 * after the walk), we abort and leave the payload alone.
 */
function repairContent(
	sessionContent: AnyContent[],
	payloadContent: AnyContent[],
): { content: AnyContent[]; injected: number } {
	const rebuilt: AnyContent[] = [];
	let q = 0;
	let injected = 0;

	const consume = () => {
		if (q < payloadContent.length) {
			rebuilt.push(payloadContent[q]);
			q++;
		}
	};

	for (const sb of sessionContent) {
		if (sb.type === "thinking") {
			const text = typeof sb.thinking === "string" ? (sb.thinking as string) : "";
			const sig = typeof sb.thinkingSignature === "string" ? (sb.thinkingSignature as string) : "";
			const redacted = sb.redacted === true;

			if (redacted) {
				consume(); // pi-ai emits redacted_thinking
			} else if (sig.length > 0) {
				if (text.trim().length === 0) {
					// BUG: pi-ai drops this. Reinject from session.
					rebuilt.push({ type: "thinking", thinking: text, signature: sig });
					injected++;
				} else {
					consume(); // kept as thinking with signature
				}
			} else {
				// Unsigned thinking: dropped if empty, downgraded otherwise.
				if (text.trim().length > 0) consume();
			}
		} else if (sb.type === "text") {
			const text = typeof sb.text === "string" ? (sb.text as string) : "";
			if (text.trim().length > 0) consume(); // empty text dropped by pi-ai
		} else if (sb.type === "toolCall") {
			consume(); // emitted as tool_use
		}
		// Unknown types: leave alignment alone.
	}

	if (q !== payloadContent.length) {
		// Our model of pi-ai's transform diverged from reality (e.g. extension
		// upstream changed). Bail out without modifying the payload.
		return { content: payloadContent, injected: 0 };
	}

	return { content: rebuilt, injected };
}
