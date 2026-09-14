/**
 * Patch Loop Guard - turns "am I patching the same spot again?" from a judgement
 * call into a counter.
 *
 * Repeatedly patching one file is evidence that the defect is structural rather than
 * on any one line, but noticing that is exactly what a model deep in a patch loop
 * stops doing. This counts successful edit/write calls per file per session and
 * appends a one-time reminder to the tool result once a file crosses the threshold,
 * where the agent cannot miss it.
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const THRESHOLD = 3;

export function reminder(file: string, count: number): string {
	return (
		`[patch-loop-guard] This session has now modified ${file} ${count} times. ` +
		`Editing one spot over and over is evidence the defect is structural, not on any one line. ` +
		`Before editing this file again: state in one sentence what is irreducibly hard about the problem, ` +
		`say how much of this file is not serving that, and give a verdict - fix (this layer has a bug), ` +
		`redesign (the module's design is wrong), refactor (a wrong assumption spread across modules), ` +
		`or rewrite (the requirement was misunderstood). If the verdict is fix, say so in one line and continue.`
	);
}

export default function (pi: ExtensionAPI) {
	const edits = new Map<string, number>();

	pi.on("session_start", () => {
		edits.clear();
	});

	pi.on("tool_result", (event, ctx: ExtensionContext) => {
		if (event.isError) return;
		if (event.toolName !== "edit" && event.toolName !== "write") return;

		const target = event.input.path;
		if (typeof target !== "string") return;
		const file = path.resolve(ctx.cwd, target);

		const count = (edits.get(file) ?? 0) + 1;
		edits.set(file, count);
		// Once per file: after the reminder, repeating it every edit would just be noise.
		if (count !== THRESHOLD) return;

		return {
			content: [
				...event.content,
				{ type: "text" as const, text: reminder(path.relative(ctx.cwd, file) || file, count) },
			],
		};
	});
}
