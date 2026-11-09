import { CONTROL_BASE } from "./auth.ts";

export interface UsageWindow {
  durationSeconds: number;
  used: string;
  limit: string;
  remaining: string;
  percentUsed: number;
  resetAt?: number;
}
export interface OpenDesignUsage {
  workspaceId: string;
  tier?: string;
  windows: UsageWindow[];
  balanceUsd?: string;
  fetchedAt: number;
}
function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function amount(value: unknown): string | undefined {
  const s = typeof value === "number" && Number.isFinite(value) ? String(value) : string(value);
  return s && /^\d+(?:\.\d+)?$/.test(s) && Number.isFinite(Number(s)) ? s : undefined;
}
export function parseUsage(payload: unknown, workspaceId: string, fetchedAt = Date.now()): OpenDesignUsage {
  const body = obj(payload);
  const plan = obj(body.codingPlan);
  if (body.workspaceId !== workspaceId || (plan.workspaceId !== undefined && plan.workspaceId !== workspaceId)) {
    throw new Error("OpenDesign billing returned a different workspace");
  }
  if (!Array.isArray(plan.windows)) throw new Error("OpenDesign billing returned no usage windows");
  const windows: UsageWindow[] = [];
  for (const value of plan.windows) {
    const row = obj(value);
    const durationSeconds = Number(row.durationSeconds);
    const used = amount(row.usedCredits);
    const limit = amount(row.limitCredits);
    const remaining = amount(row.remainingCredits);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !used || !limit || !remaining || Number(limit) <= 0) continue;
    const parsedTime = typeof row.resetsAt === "string" ? Date.parse(row.resetsAt) : NaN;
    windows.push({ durationSeconds, used, limit, remaining,
      percentUsed: Math.max(0, Math.min(100, (1 - Number(remaining) / Number(limit)) * 100)),
      ...(Number.isFinite(parsedTime) ? { resetAt: parsedTime } : {}),
    });
  }
  if (!windows.length) throw new Error("OpenDesign billing returned no usable usage windows");
  windows.sort((a, b) => a.durationSeconds - b.durationSeconds);
  return { workspaceId, tier: string(plan.tier), windows, balanceUsd: amount(body.balanceUsd), fetchedAt };
}
async function get(path: string, key: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(15_000);
  const res = await fetch(`${CONTROL_BASE}${path}`, {
    headers: { accept: "application/json", authorization: `Bearer ${key}` },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: "error",
  });
  if (!res.ok) throw new Error(`OpenDesign usage request failed (HTTP ${res.status})`);
  try { return obj(await res.json()); } catch { throw new Error("OpenDesign usage returned invalid JSON"); }
}
export async function fetchUsage(key: string, signal?: AbortSignal): Promise<OpenDesignUsage> {
  const current = await get("/workspaces/current", key, signal);
  const workspace = string(current.activeWorkspaceId) ?? string(current.workspaceId);
  if (!workspace) throw new Error("OpenDesign did not return an active workspace");
  const billing = await get(`/workspaces/${encodeURIComponent(workspace)}/billing/preflight`, key, signal);
  return parseUsage(billing, workspace);
}
export function windowLabel(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${seconds}s`;
}
export function resetText(resetAt: number | undefined, now = Date.now()): string {
  if (resetAt === undefined) return "unknown";
  const minutes = Math.max(0, Math.ceil((resetAt - now) / 60_000));
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}m`;
}
export function formatUsage(usage: OpenDesignUsage, now = Date.now()): string {
  const lines = [`OpenDesign usage${usage.tier ? ` — ${usage.tier}` : ""}`];
  for (const w of usage.windows) lines.push(`  ${windowLabel(w.durationSeconds)}: ${w.percentUsed.toFixed(1)}% used · ${w.remaining} / ${w.limit} credits remaining · reset ${resetText(w.resetAt, now)}`);
  if (usage.balanceUsd !== undefined) lines.push(`  Balance: $${usage.balanceUsd}`);
  return lines.join("\n");
}
