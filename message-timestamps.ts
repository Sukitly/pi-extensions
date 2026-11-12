import type {
	AgentMessage,
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ToolRenderContext,
	ToolRenderResultOptions,
	ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface ToolCompletionRecord {
	completedAt: Date;
	durationMs?: number;
}

const TIMESTAMP_REGEX =
	/(?:\r?\n[\u200B\s]*\x1b\[2m(?:\d{4}-\d{2}-\d{2}\s+|\d{2}-\d{2}\s+)?\d{2}:\d{2}:\d{2}\x1b\[(?:0|22)m|\s*\x1b\[2m(?:\d{4}-\d{2}-\d{2}\s+|\d{2}-\d{2}\s+)?\d{2}:\d{2}:\d{2}\x1b\[(?:0|22)m)$/;

function padZero(value: number): string {
	return value < 10 ? `0${value}` : String(value);
}

export function formatTimestampText(date: Date, referenceDate: Date = new Date()): string {
	const hours = padZero(date.getHours());
	const minutes = padZero(date.getMinutes());
	const seconds = padZero(date.getSeconds());
	const timeString = `${hours}:${minutes}:${seconds}`;

	const isSameDay =
		date.getFullYear() === referenceDate.getFullYear() &&
		date.getMonth() === referenceDate.getMonth() &&
		date.getDate() === referenceDate.getDate();

	if (isSameDay) {
		return timeString;
	}

	const month = padZero(date.getMonth() + 1);
	const day = padZero(date.getDate());
	const isSameYear = date.getFullYear() === referenceDate.getFullYear();

	if (isSameYear) {
		return `${month}-${day} ${timeString}`;
	}

	return `${date.getFullYear()}-${month}-${day} ${timeString}`;
}

export function formatTimestampBadge(date: Date, theme?: Theme): string {
	const text = formatTimestampText(date);
	if (theme) {
		return theme.fg("dim", text);
	}
	return `\x1b[2m${text}\x1b[22m`;
}

function appendTimestampToMarkdown(markdown: string, badge: string): string {
	const trimmed = markdown.trimEnd();
	if (!trimmed) {
		return markdown;
	}

	if (TIMESTAMP_REGEX.test(trimmed)) {
		return markdown;
	}

	return `${trimmed}\n${badge}`;
}

function extractTextOutput(result: any, expanded: boolean, theme?: Theme): string | undefined {
	const content = result?.content;
	if (!Array.isArray(content)) {
		return undefined;
	}
	const textBlocks = content
		.filter((item: any) => item && item.type === "text" && typeof item.text === "string")
		.map((item: any) => item.text);

	const raw = textBlocks.join("\n").trim();
	if (!raw) {
		return undefined;
	}

	const lines = raw.split("\n");
	const maxLines = expanded ? lines.length : 10;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;

	let text = displayLines.map((line: string) => (theme ? theme.fg("toolOutput", line) : line)).join("\n");
	if (remaining > 0 && theme) {
		text += `\n${theme.fg("muted", `... (${remaining} more lines)`)}`;
	}
	return text;
}

class TimestampedResultComponent implements Component {
	private baseComponent: Component | undefined;
	private timeBadge: string;
	private fallbackText?: string;

	constructor(baseComponent: Component | undefined, timeBadge: string, fallbackText?: string) {
		this.baseComponent = baseComponent;
		this.timeBadge = timeBadge;
		this.fallbackText = fallbackText;
	}

	render(width: number): string[] {
		const rawLines = this.baseComponent
			? this.baseComponent.render(width)
			: this.fallbackText
				? new Text(this.fallbackText, 0, 0).render(width)
				: [];

		const hasText = rawLines.some((line) => line.trim().length > 0);
		if (!hasText) {
			return [truncateToWidth(this.timeBadge, width)];
		}

		let targetIndex = -1;
		for (let i = rawLines.length - 1; i >= 0; i--) {
			if (rawLines[i].includes("Took ")) {
				targetIndex = i;
				break;
			}
			if (targetIndex === -1 && rawLines[i].trim().length > 0) {
				targetIndex = i;
			}
		}

		if (targetIndex === -1) {
			return [truncateToWidth(this.timeBadge, width)];
		}

		const result = [...rawLines];
		const targetLine = result[targetIndex].trimEnd();
		const badgeLen = visibleWidth(this.timeBadge);
		const targetLen = visibleWidth(targetLine);

		if (targetLen + 2 + badgeLen <= width) {
			result[targetIndex] = `${targetLine}  ${this.timeBadge}`;
		} else {
			result.splice(targetIndex + 1, 0, this.timeBadge);
		}

		return result.map((line) => truncateToWidth(line, width));
	}

	handleInput?(data: string): void {
		this.baseComponent?.handleInput?.(data);
	}

	handleMouse?(event: any): any {
		return this.baseComponent?.handleMouse?.(event);
	}

	invalidate?(): void {
		this.baseComponent?.invalidate?.();
	}

	dispose?(): void {
		this.baseComponent?.dispose?.();
	}
}

export default function (pi: ExtensionAPI) {
	let activeTheme: Theme | undefined;
	let pendingUserTime: Date | undefined;
	let lastAssistantCompletionTime: Date | undefined;

	const userTimeCache = new Map<string, Date>();
	const assistantTimeCache = new Map<string, Date>();
	const toolCompletionMap = new Map<string, ToolCompletionRecord>();

	function indexHistoricalToolResults(ctx: ExtensionContext): void {
		activeTheme = ctx.ui.theme;
		const entries = ctx.sessionManager.getEntries();
		for (const entry of entries) {
			if (entry.type === "message") {
				const message = entry.message as AgentMessage;
				if (message.role === "toolResult" && message.toolCallId) {
					if (!toolCompletionMap.has(message.toolCallId)) {
						toolCompletionMap.set(message.toolCallId, {
							completedAt: new Date(entry.timestamp),
						});
					}
				}
			}
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		indexHistoricalToolResults(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		indexHistoricalToolResults(ctx);
	});

	pi.on("input", async (event, ctx) => {
		activeTheme = ctx.ui.theme;
		const now = new Date();
		pendingUserTime = now;
		const normalizedText = event.text.trim();
		if (normalizedText) {
			userTimeCache.set(normalizedText, now);
		}
	});

	pi.on("message_start", async (event, ctx) => {
		activeTheme = ctx.ui.theme;
		if (event.message.role === "user") {
			pendingUserTime ||= new Date();
		}
	});

	pi.on("message_end", async (event, ctx) => {
		activeTheme = ctx.ui.theme;
		if (event.message.role === "assistant") {
			lastAssistantCompletionTime = new Date();
		}
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		activeTheme = ctx.ui.theme;
		toolCompletionMap.set(event.toolCallId, {
			completedAt: new Date(),
			durationMs: event.durationMs,
		});
	});

	pi.registerMarkdownTransformer(
		(markdown, context) => {
			const trimmed = markdown.trimEnd();
			if (!trimmed) {
				return markdown;
			}

			if (TIMESTAMP_REGEX.test(trimmed)) {
				return markdown;
			}

			if (context.messageType === "user") {
				let time: Date | undefined;
				if (context.timestamp) {
					time = new Date(context.timestamp);
				} else {
					time = userTimeCache.get(trimmed) ?? pendingUserTime ?? new Date();
				}

				if (context.messageId) {
					const cached = userTimeCache.get(context.messageId);
					if (cached) {
						time = cached;
					} else {
						userTimeCache.set(context.messageId, time);
					}
				}

				const badge = formatTimestampBadge(time, activeTheme);
				return appendTimestampToMarkdown(markdown, badge);
			}

			if (context.messageType === "assistant") {
				if (context.isStreaming) {
					return markdown;
				}

				let time: Date | undefined;
				if (context.timestamp) {
					time = new Date(context.timestamp);
				} else {
					time = lastAssistantCompletionTime ?? new Date();
				}

				if (context.messageId) {
					const cached = assistantTimeCache.get(context.messageId);
					if (cached) {
						time = cached;
					} else {
						assistantTimeCache.set(context.messageId, time);
					}
				}

				const badge = formatTimestampBadge(time, activeTheme);
				return appendTimestampToMarkdown(markdown, badge);
			}

			return markdown;
		},
		{
			messageTypes: ["user", "assistant"],
		},
	);

	pi.registerToolRenderer((_toolName: string, next: () => ToolRenderers | undefined): ToolRenderers | undefined => {
		const base = next();

		return {
			renderShell: base?.renderShell,
			renderCall: base?.renderCall,
			renderResult(
				result: any,
				options: ToolRenderResultOptions,
				theme: Theme,
				context: ToolRenderContext<any, any>,
			): Component {
				activeTheme = theme;

				if (options.isPartial) {
					if (base?.renderResult) {
						return base.renderResult(result, options, theme, context);
					}
					const fallback = extractTextOutput(result, options.expanded, theme);
					return new TimestampedResultComponent(undefined, "", fallback);
				}

				const meta = toolCompletionMap.get(context.toolCallId);
				const completionTime = meta?.completedAt ?? new Date();
				const badge = formatTimestampBadge(completionTime, theme);

				const baseComponent = base?.renderResult
					? base.renderResult(result, options, theme, context)
					: undefined;

				const fallback = baseComponent ? undefined : extractTextOutput(result, options.expanded, theme);
				return new TimestampedResultComponent(baseComponent, badge, fallback);
			},
		};
	});
}
