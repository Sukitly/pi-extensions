import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { setTimeout as sleep } from "node:timers/promises";

export const CONTROL_BASE = "https://amr-api.open-design.ai/api/v1";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_WAIT_MS = 10 * 60_000;
// Pi's OAuth credential requires a finite expiry. OpenDesign's device response
// does not document one; this sentinel means unknown, not a vendor promise.
export const UNKNOWN_EXPIRY = Number.MAX_SAFE_INTEGER;

type JsonRecord = Record<string, unknown>;
function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}
function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
async function request(path: string, body: unknown, signal: AbortSignal): Promise<{ status: number; data: JsonRecord }> {
  const response = await fetch(`${CONTROL_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    redirect: "error",
  });
  let data: JsonRecord = {};
  try { data = record(await response.json()); } catch { /* no sensitive response bodies in errors */ }
  return { status: response.status, data };
}
function activationUrl(value: unknown): string {
  const raw = nonempty(value);
  if (!raw) throw new Error("OpenDesign did not provide an activation URL");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("OpenDesign returned an invalid activation URL"); }
  if (url.protocol !== "https:" || url.username || url.password ||
      (url.hostname !== "open-design.ai" && !url.hostname.endsWith(".open-design.ai"))) {
    throw new Error("OpenDesign returned an untrusted activation URL");
  }
  return url.toString();
}

// Keep the fields needed for Pi requests and /accounts identity/switching.
// Device-approval expiresAt is NOT the runtime key's expiry.
export function deviceCredential(payload: unknown): OAuthCredential {
  const data = record(payload);
  const access = nonempty(data.runtimeKey);
  const controlKey = nonempty(data.controlKey);
  if (!access || !controlKey) throw new Error("OpenDesign approval did not return both runtime and control credentials");
  const rawUser = record(data.user);
  const accountId = nonempty(rawUser.id);
  const email = nonempty(rawUser.email);
  const name = nonempty(rawUser.name);
  const controlKeyId = nonempty(data.controlKeyId);
  const user = { ...(accountId ? { id: accountId } : {}), ...(email ? { email } : {}), ...(name ? { name } : {}) };
  const runtimeExpiry = typeof data.runtimeKeyExpiresAt === "string" ? Date.parse(data.runtimeKeyExpiresAt) : NaN;
  return {
    type: "oauth", access, controlKey,
    refresh: nonempty(data.refreshToken) ?? nonempty(data.refresh_token) ?? "",
    // Preserve a supplied refresh token, but do not claim an unverified refresh
    // endpoint exists. The account manager skips refreshable:false credentials.
    refreshable: false,
    expires: Number.isFinite(runtimeExpiry) ? runtimeExpiry : UNKNOWN_EXPIRY,
    ...(controlKeyId ? { controlKeyId } : {}),
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    ...(Object.keys(user).length ? { user } : {}),
  };
}

export async function deviceLogin(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
  const { signal } = interaction;
  signal.throwIfAborted();
  interaction.notify({ type: "info", message: "OpenDesign account login creates device credentials with account/billing access. Local logout may not revoke them at OpenDesign." });
  const started = await request("/cli/device-authorizations", { cliVersion: "pi-open-design/0.2.0", host: "pi", profile: "prod" }, signal);
  if (started.status < 200 || started.status >= 300) throw new Error(`OpenDesign device login failed (HTTP ${started.status})`);
  const deviceId = nonempty(started.data.deviceId);
  const deviceSecret = nonempty(started.data.deviceSecret);
  const userCode = nonempty(started.data.userCode);
  if (!deviceId || !deviceSecret || !userCode) throw new Error("OpenDesign returned an incomplete device authorization");
  const verificationUri = activationUrl(started.data.activationUrl);
  const seconds = Number(started.data.pollIntervalSeconds);
  const interval = Number.isFinite(seconds) && seconds > 0 ? Math.max(2_000, Math.min(seconds * 1_000, 30_000)) : 2_000;
  const expiry = typeof started.data.expiresAt === "string" ? Date.parse(started.data.expiresAt) : NaN;
  const deadline = Math.min(Number.isFinite(expiry) ? expiry : Date.now() + MAX_WAIT_MS, Date.now() + MAX_WAIT_MS);
  if (deadline <= Date.now()) throw new Error("OpenDesign device authorization expired");
  interaction.notify({ type: "device_code", userCode, verificationUri, intervalSeconds: interval / 1000, expiresInSeconds: Math.ceil((deadline - Date.now()) / 1000) });

  while (Date.now() < deadline) {
    await sleep(Math.min(interval, Math.max(0, deadline - Date.now())), undefined, { signal });
    if (Date.now() >= deadline) break;
    const response = await request(`/cli/device-authorizations/${encodeURIComponent(deviceId)}/token`, { deviceSecret }, signal);
    const status = String(response.data.status ?? "").toLowerCase();
    const controlKey = nonempty(response.data.controlKey);
    const runtimeKey = nonempty(response.data.runtimeKey);
    if (controlKey && runtimeKey && response.status >= 200 && response.status < 300) {
      // Pi persists this single credential via its own credential store.
      return deviceCredential(response.data);
    }
    if (controlKey || runtimeKey || status === "approved" || status === "complete" || status === "completed") {
      throw new Error("OpenDesign approval did not return both runtime and control credentials");
    }
    if (["expired", "canceled", "cancelled", "denied", "rejected"].includes(status) || response.status === 401 || response.status === 404) {
      throw new Error("OpenDesign device authorization expired or was denied");
    }
    if (response.status >= 400 && response.status !== 429 && status !== "pending" && status !== "authorization_pending") {
      throw new Error(`OpenDesign device login failed (HTTP ${response.status})`);
    }
  }
  throw new Error("OpenDesign device authorization timed out");
}

export const openDesignAccountAuth: OAuthAuth = {
  name: "OpenDesign account",
  loginLabel: "Sign in with OpenDesign account",
  isSubscription: true,
  login: deviceLogin,
  async refresh() { throw new Error("OpenDesign credential expired; run /login open-design again"); },
  async toAuth(credential) {
    if (!nonempty(credential.access)) throw new Error("OpenDesign runtime credential is missing; run /login open-design again");
    return { apiKey: credential.access };
  },
};
