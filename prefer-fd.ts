/**
 * Prefer fd Extension
 *
 * Replaces Pi's bash tool with one that disables shell invocations of `find`
 * and directs the agent to use `fd` for file-name/path searches or `rg` for
 * content searches.
 *
 * A PATH shim catches ordinary and nested shell invocations. The spawn hook
 * also blocks direct command segments such as `/usr/bin/find`, which bypass
 * PATH lookup.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const interceptedCommandsPath = join(__dirname, "intercepted-commands");

const FIND_DISABLED_MESSAGE = [
	"Error: find is disabled. Use fd instead:",
	"",
	"  File-name/path search: fd PATTERN PATH",
	"  File extension search: fd -e EXT . PATH",
	"  Content search: rg PATTERN PATH",
	"",
].join("\n");

// Match find at the start of a shell segment, including explicit paths such
// as /usr/bin/find. PATH shims cover less direct invocations inside scripts.
const findCommandPattern = /(?:^|\n|[;|&]{1,2}|\$\()\s*(?:\S+\/)?find(?=$|\s|[;|&)])/m;

export default function preferFdExtension(pi: ExtensionAPI) {
	const bashTool = createBashTool(process.cwd(), {
		commandPrefix: `export PATH="${interceptedCommandsPath}:$PATH"`,
		spawnHook: (ctx) => {
			if (findCommandPattern.test(ctx.command)) {
				throw new Error(FIND_DISABLED_MESSAGE);
			}
			return ctx;
		},
	});

	pi.registerTool(bashTool);
}
