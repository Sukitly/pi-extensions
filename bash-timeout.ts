import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DEFAULT_TIMEOUT_SECONDS = 60;
export const MAX_TIMEOUT_SECONDS = 300;
export const BASH_TIMEOUT_GUIDANCE =
	"Bash timeout policy: timeout is in seconds and defaults to 60 when omitted. " +
	"Explicit values must be finite numbers greater than 0 and at most 300. " +
	"Invalid or excessive values are rejected before execution, not clamped. " +
	"Use the Bash tool's timeout parameter, not the shell `timeout` or `gtimeout` command; those invocations are rejected. " +
	"This also applies to nested Bash tool calls. Do not bypass the limit with background jobs or repeated retries.";

// A conservative lexical guard for direct shell invocations, not a Bash parser
// or a sandbox. Quoted arguments/comments/heredoc bodies are not command names.
export function hasShellTimeout(command: string): boolean {
	const tokens: Array<{ value: string; operator: boolean }> = [];
	const pattern = /[ \t\r]+|\n|#[^\n]*|(?:\d+)?(?:<<-?|>&|<&|>>?|<)|&&|\|\||[;|&(){}]|(?:[^\s;|&(){}<>"'\\`]+|\\[\s\S]|"(?:\\[\s\S]|[^"\\])*"|'[^']*'|`[^`]*`)+/gy;
	const heredocs: Array<{ delimiter: string; stripTabs: boolean }> = [];
	let heredoc: boolean | undefined;
	const unquote = (word: string) => word.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|\\(.)/gs,
		(_match, double, single, escaped) => double !== undefined ? double.replace(/\\(["\\$`])/g, "$1") : single ?? escaped);
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(command)) !== null) {
		const raw = match[0];
		if (/^[ \t\r]+$/.test(raw) || raw.startsWith("#")) continue;
		if (raw === "\n") {
			tokens.push({ value: ";", operator: true });
			for (const doc of heredocs.splice(0)) {
				let end = pattern.lastIndex;
				while (end < command.length) {
					const next = command.indexOf("\n", end);
					const lineEnd = next < 0 ? command.length : next;
					const line = command.slice(end, lineEnd);
					end = next < 0 ? command.length : next + 1;
					if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
				}
				pattern.lastIndex = end;
			}
			continue;
		}
		if (heredoc !== undefined) {
			heredocs.push({ delimiter: unquote(raw), stripTabs: heredoc });
			heredoc = undefined;
		}
		if (/^\d*<<-?$/.test(raw)) heredoc = raw.endsWith("-");
		const operator = /^(?:\d*[<>].*|&&|\|\||[;|&(){}])$/.test(raw);
		// Backticks outside single quotes execute a nested shell command.
		if (raw.startsWith("`") && raw.endsWith("`") && hasShellTimeout(raw.slice(1, -1))) return true;
		tokens.push({ value: operator ? raw : unquote(raw), operator });
	}

	let commandPosition = true;
	let redirectTarget = false;
	for (const [index, token] of tokens.entries()) {
		const word = token.value;
		if (token.operator) {
			if (/^\d*[<>]/.test(word)) redirectTarget = true;
			else { commandPosition = true; redirectTarget = false; }
			continue;
		}
		if (redirectTarget) { redirectTarget = false; continue; }
		if (!commandPosition) continue;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
		// `command -v timeout` is an availability check, not an invocation.
		if (word === "command" && /^-[vV]+$/.test(tokens[index + 1]?.value ?? "")) {
			commandPosition = false;
			continue;
		}
		if (["if", "then", "elif", "else", "while", "until", "do", "!", "time", "command", "exec", "env", "sudo"].includes(word)) continue;
		if (word.startsWith("-")) continue;
		if (/^(?:.*\/)?g?timeout$/.test(word)) return true;
		commandPosition = false;
	}
	return false;
}

export default function bashTimeoutExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		if (event.systemPrompt.includes(BASH_TIMEOUT_GUIDANCE)) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${BASH_TIMEOUT_GUIDANCE}` };
	});

	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return undefined;
		if (typeof event.input.command === "string" && hasShellTimeout(event.input.command)) {
			return {
				block: true,
				reason: "Bash command NOT executed: shell `timeout` / `gtimeout` invocations are not supported by this policy. " +
					"Remove the shell timeout wrapper and use the Bash tool's `timeout` parameter instead, " +
					"in seconds (greater than 0, maximum 300; default 60). " +
					"No search was performed; this is not an empty search result.",
			};
		}
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
