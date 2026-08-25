/**
 * Disable find Extension
 *
 * Blocks agent-initiated shell use of `find` and directs the model to use
 * `fd` for file-name/path searches or `rg` for content searches. Pi's built-in
 * Bash tool remains intact, including the configured shell, command prefix,
 * session cwd, execution backend, and renderer.
 */

import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLICY_MARKER = ": # pi-disable-find";

export const FIND_PROMPT_GUIDANCE =
	"Bash command policy: `find` is disabled. Use `fd` for file-name or path searches and `rg` for content searches.";

export interface FindPolicyAssets {
	shimDirectory: string;
	shimPath: string;
	messagePath: string;
	message: string;
}

export function loadFindPolicyAssets(extensionDirectory = __dirname): FindPolicyAssets {
	const shimDirectory = join(extensionDirectory, "blocked-commands", "find");
	const shimPath = join(shimDirectory, "find");
	const messagePath = join(shimDirectory, "message.txt");

	try {
		accessSync(shimPath, constants.X_OK);
		accessSync(messagePath, constants.R_OK);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`disable-find extension is incomplete. Expected an executable shim at ${shimPath} and a readable message at ${messagePath}. ${detail}`,
		);
	}

	return {
		shimDirectory,
		shimPath,
		messagePath,
		message: readFileSync(messagePath, "utf8").trimEnd(),
	};
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function maskHeredocBodies(command: string): string {
	const lines = command.match(/.*(?:\n|$)/g)?.filter(Boolean) ?? [];
	const pending: Array<{ delimiter: string; stripTabs: boolean }> = [];
	let masked = "";

	for (const line of lines) {
		const hasNewline = line.endsWith("\n");
		const content = hasNewline ? line.slice(0, -1) : line;

		if (pending.length > 0) {
			const current = pending[0];
			const comparable = current.stripTabs ? content.replace(/^\t+/, "") : content;
			masked += " ".repeat(content.length) + (hasNewline ? "\n" : "");
			if (comparable === current.delimiter) pending.shift();
			continue;
		}

		masked += line;
		const heredocPattern = /(?:^|[^<])<<(-?)(?!<)\s*(?:'([^']+)'|"([^"]+)"|([^\s;&|()]+))/g;
		for (const match of content.matchAll(heredocPattern)) {
			const delimiter = match[2] ?? match[3] ?? match[4];
			if (delimiter) pending.push({ delimiter, stripTabs: match[1] === "-" });
		}
	}

	return masked;
}

function maskQuotedTextAndComments(command: string): string {
	let masked = "";
	let quote: "single" | "double" | null = null;
	let comment = false;

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];

		if (comment) {
			if (char === "\n") {
				comment = false;
				masked += "\n";
			} else {
				masked += " ";
			}
			continue;
		}

		if (quote === "single") {
			if (char === "'") quote = null;
			masked += " ";
			continue;
		}

		if (quote === "double") {
			if (char === "\\" && index + 1 < command.length) {
				masked += "  ";
				index += 1;
				continue;
			}
			if (char === '"') quote = null;
			masked += " ";
			continue;
		}

		if (char === "\\" && index + 1 < command.length) {
			masked += "  ";
			index += 1;
			continue;
		}
		if (char === "'") {
			quote = "single";
			masked += " ";
			continue;
		}
		if (char === '"') {
			quote = "double";
			masked += " ";
			continue;
		}
		if (char === "#" && (index === 0 || /\s/.test(command[index - 1]))) {
			comment = true;
			masked += " ";
			continue;
		}
		if (char === "`") {
			masked += ";";
			continue;
		}

		masked += char;
	}

	return masked;
}

const explicitFindPattern =
	/(?:^|\n|[;|&]{1,2}|\$\()\s*(?:(?:if|then|do|else|elif|while|until|time|sudo|command|builtin)\s+)*(?:\S+\/)+find(?=$|\s|[;|&)])/m;

export function isExplicitFindInvocation(command: string): boolean {
	const withoutHeredocBodies = maskHeredocBodies(command);
	const executableText = maskQuotedTextAndComments(withoutHeredocBodies);
	return explicitFindPattern.test(executableText);
}

export function prependFindShimPath(command: string, shimDirectory: string): string {
	if (command.startsWith(`${POLICY_MARKER}\n`)) return command;
	return `${POLICY_MARKER}\nexport PATH=${shellQuote(shimDirectory)}:"$PATH"\n${command}`;
}

export default function disableFindExtension(pi: ExtensionAPI) {
	const assets = loadFindPolicyAssets();

	pi.on("before_agent_start", (event) => {
		if (event.systemPrompt.includes(FIND_PROMPT_GUIDANCE)) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${FIND_PROMPT_GUIDANCE}` };
	});

	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return undefined;

		const input = event.input as { command?: unknown };
		if (typeof input.command !== "string") return undefined;

		if (isExplicitFindInvocation(input.command)) {
			return { block: true, reason: assets.message };
		}

		input.command = prependFindShimPath(input.command, assets.shimDirectory);
		return undefined;
	});
}
