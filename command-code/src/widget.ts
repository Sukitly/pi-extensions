// Command Code adapter for the shared usage renderer.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatCredits, type CommandCodeUsage } from "./usage.ts";
import { buildUsageWidgetLine } from "../../provider-shared/widget.ts";

export function buildCommandCodeWidgetLine(usage: CommandCodeUsage, theme: Theme, now = Date.now()): string {
  return buildUsageWidgetLine([
    { window: usage.fiveHour, label: "5h", seconds: 5 * 60 * 60 },
    { window: usage.weekly, label: "7d", seconds: 7 * 24 * 60 * 60 },
  ], theme, now, usage.monthlyRemaining === undefined ? [] : [`Monthly: ${formatCredits(usage.monthlyRemaining)} credits left`]);
}
