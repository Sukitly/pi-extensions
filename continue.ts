import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Send literal quick responses, but never steer or queue one mid-run. */
export default function (pi: ExtensionAPI) {
	const sendWhenIdle = (ctx: ExtensionContext, message: string) => {
		// isIdle() also remains false while Pi is retrying, compacting, or has
		// queued messages, so this cannot accidentally create a follow-up.
		if (!ctx.isIdle()) return;
		pi.sendUserMessage(message);
	};

	pi.registerShortcut("ctrl+j", {
		description: 'Send "continue" when the agent is stopped',
		handler: (ctx) => sendWhenIdle(ctx, "continue"),
	});

	pi.registerShortcut("ctrl+r", {
		description: 'Send "approve" when the agent is stopped',
		handler: (ctx) => sendWhenIdle(ctx, "approve"),
	});
}
