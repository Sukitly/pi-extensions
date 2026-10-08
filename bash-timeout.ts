import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DEFAULT_TIMEOUT_SECONDS = 60;
export const MAX_TIMEOUT_SECONDS = 300;
export const BASH_TIMEOUT_GUIDANCE =
	"Bash timeout policy: timeout is in seconds and defaults to 60 when omitted. " +
	"Explicit values must be finite numbers greater than 0 and at most 300. " +
	"Invalid or excessive values are rejected before execution, not clamped. " +
	"This also applies to nested Bash tool calls. Do not bypass the limit with background jobs or repeated retries.";

export default function bashTimeoutExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		if (event.systemPrompt.includes(BASH_TIMEOUT_GUIDANCE)) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${BASH_TIMEOUT_GUIDANCE}` };
	});

	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return undefined;
		const requested = event.input.timeout;
		if (requested === undefined) {
			event.input.timeout = DEFAULT_TIMEOUT_SECONDS;
			return undefined;
		}
		if (typeof requested !== "number" || !Number.isFinite(requested) ||
			requested <= 0 || requested > MAX_TIMEOUT_SECONDS) {
			const value = typeof requested === "string" ? JSON.stringify(requested) : String(requested);
			return {
				block: true,
				reason: `Bash command NOT executed: invalid timeout ${value}. ` +
					`Timeout must be a finite number of seconds greater than 0 and at most ${MAX_TIMEOUT_SECONDS}. ` +
					`Omit it to use the ${DEFAULT_TIMEOUT_SECONDS}s default, or submit a valid value. ` +
					"Do not repeat the invalid request or bypass the limit with background jobs.",
			};
		}
		return undefined;
	});
}
