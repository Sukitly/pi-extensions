// Shared usage rendering, extracted unchanged from Command Code.
import type { Theme } from "@earendil-works/pi-coding-agent";

export interface UsageWindow {
  used: number | undefined;
  cap: number | undefined;
  resetAt: number | undefined;
}
export interface WidgetWindow {
  window: UsageWindow;
  label: string;
  seconds: number;
}

function pad2(n: number): string {
	return n.toString().padStart(2, "0");
}

function formatResetTime(resetAt: number | undefined, windowSeconds: number): string {
	if (resetAt === undefined || !Number.isFinite(resetAt)) return "";
	const d = new Date(resetAt);
	const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
	if (windowSeconds < 24 * 60 * 60) return time;
	const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	return `${days[d.getDay()]} ${time}`;
}

function renderBar(pct: number): string {
	const filled = Math.round(pct / 10);
	return `[${"█".repeat(filled)}${"░".repeat(10 - filled)}]`;
}

export function renderWindow(window: UsageWindow, label: string, seconds: number, theme: Theme, now: number): string | undefined {
	if (window.used === undefined || window.cap === undefined || window.cap <= 0) return undefined;
	const pct = Math.max(0, Math.min(100, window.used / window.cap * 100));
	const resetTime = formatResetTime(window.resetAt, seconds);
	let pace = "";
	if (seconds >= 24 * 60 * 60 && window.resetAt !== undefined) {
		const elapsed = now - (window.resetAt - seconds * 1000);
		const expectedPct = Math.min(100, Math.max(0, elapsed / (seconds * 1000) * 100));
		const diff = pct - expectedPct;
		pace = ` ${diff > 0
			? theme.fg("error", `▲${Math.abs(diff).toFixed(1)}%`)
			: theme.fg("success", `▼${Math.abs(diff).toFixed(1)}%`)}`;
	}
	return theme.fg("dim", `${label}: ${renderBar(pct)} ${pct.toFixed(0)}%${resetTime ? ` ~ ${resetTime}` : ""}`) + pace;
}


export function buildUsageWidgetLine(windows: WidgetWindow[], theme: Theme, now = Date.now(), trailing: string[] = []): string {
  const parts = windows.map(({ window, label, seconds }) => renderWindow(window, label, seconds, theme, now))
    .filter((part): part is string => part !== undefined);
  parts.push(...trailing.map((part) => theme.fg("dim", part)));
  return parts.join(theme.fg("dim", " • ")) || theme.fg("dim", "No usage data");
}
