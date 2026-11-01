import { DynamicBorder, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { withAccountTransaction, assertAccountTransaction, assertOutsideAccountTransaction, withCaretakerLease, sharedUsageFetch } from "./shared/account-coordination.mjs";

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}
function getAccountsFile(): string {
	return join(getAgentDir(), "oauth-accounts.json");
}
function getAuthFile(): string {
	return join(getAgentDir(), "auth.json");
}
const MESSAGE_TYPE = "oauth-accounts";

// Pre-emptive refresh thresholds:
// 1. When switching to an account: refresh if it expires within 5 minutes (or is expired)
const SWITCH_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;
// 2. Background caretaker: refresh dormant accounts if they expire within 3 hours
// Actual thresholds are deterministically staggered per account (2.5–4.5 hours).
// 3. Periodic background check interval: 1 hour
const CARETAKER_INTERVAL_MS = 60 * 60 * 1000;
// 4. Usage cache TTL: 3 minutes
const USAGE_CACHE_TTL_MS = 3 * 60 * 1000;

export interface OAuthCredentialPayload {
	type: "oauth";
	access: string;
	refresh: string;
	expires: number;
	[key: string]: unknown;
}

export interface StoredAccount {
	id: string; // unique internal id
	alias: string; // user-friendly display name (e.g. "work", "personal")
	provider: string; // "anthropic", "openai-codex", "kimi-coding", etc.
	credential: OAuthCredentialPayload;
	stableKey?: string; // stable account identifier (e.g. provider:uuid:... or provider:account:...)
	email?: string;
	accountId?: string;
	addedAt: number;
	lastUsedAt: number;
	lastRefreshedAt?: number;
	nextRefreshAttemptAt?: number;
	refreshFailures?: number;
	status: "valid" | "expired";
	statusError?: string;
	lastRefreshError?: string;
}

export interface AccountsStore {
	version: 1;
	activeAccounts: Record<string, string>; // providerId -> accountId
	accounts: Record<string, StoredAccount>; // accountId -> StoredAccount
}

type AuthFile = Record<string, unknown>;

interface UsageBucket {
	utilization: number;
	resets_at: string | null;
}

interface UsageResponse {
	five_hour: UsageBucket | null;
	seven_day: UsageBucket | null;
}

interface CodexWindow {
	used_percent: number;
	reset_at: number;
	limit_window_seconds?: number;
}

interface CodexUsageResponse {
	rate_limit?: {
		primary_window?: CodexWindow | null;
		secondary_window?: CodexWindow | null;
	} | null;
}

// Shared account/auth transaction, re-entrant only within the owning async operation.
export const storeLock = { run: withAccountTransaction };

const usageCache = new Map<string, { summary: string; fetchedAt: number }>();
let caretakerTimer: NodeJS.Timeout | null = null;
let caretakerController: AbortController | null = null;
let isCaretakerRunning = false;
let pendingLoginProvider: string | null = null;
let pendingLoginVersion = 0;

export function setPendingLoginProvider(provider: string | null): void {
	pendingLoginProvider = provider;
	pendingLoginVersion++;
}

// ============================================================================
// File IO & Store Management
// ============================================================================

async function ensureDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	try {
		await chmod(dir, 0o700);
	} catch {}
}

async function writePrivateJson(path: string, data: unknown): Promise<void> {
	await ensureDir(dirname(path));
	const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
	const content = `${JSON.stringify(data, null, 2)}\n`;
	await writeFile(tempPath, content, { mode: 0o600 });
	await rename(tempPath, path);
	try {
		await chmod(path, 0o600);
	} catch {}
}

export async function readCurrentAuth(): Promise<AuthFile> {
	try {
		const raw = await readFile(getAuthFile(), "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object") return {};
		return parsed as AuthFile;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`Failed to read ${getAuthFile()}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function writeCurrentAuth(auth: AuthFile): Promise<void> {
	await storeLock.run(async () => {
		assertAccountTransaction();
		await writePrivateJson(getAuthFile(), auth);
	});
}

export async function loadAccountsStore(): Promise<AccountsStore> {
	const path = getAccountsFile();
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {
				version: 1,
				activeAccounts: {},
				accounts: {},
			};
		}
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`Failed to load ${path}: file contains corrupted JSON. Halting write operations to prevent data loss. Cause: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Failed to load ${path}: file does not contain a JSON object. Halting write operations to prevent data loss.`);
	}
	const store = parsed as Partial<AccountsStore>;
	if (store.version !== 1 || typeof store.accounts !== "object") {
		throw new Error(`Failed to load ${path}: unsupported version (${store.version}) or invalid schema. Halting write operations to prevent data loss.`);
	}
	return {
		version: 1,
		activeAccounts: store.activeAccounts || {},
		accounts: store.accounts || {},
	};
}

export async function saveAccountsStore(store: AccountsStore): Promise<void> {
	await storeLock.run(async () => {
		assertAccountTransaction();
		await writePrivateJson(getAccountsFile(), store);
	});
}

// ============================================================================
// Token & Identity Helpers
// ============================================================================

function isOAuthCredential(entry: unknown): entry is OAuthCredentialPayload {
	if (!entry || typeof entry !== "object") return false;
	const e = entry as Record<string, unknown>;
	return (
		e.type === "oauth" &&
		typeof e.access === "string" &&
		e.access.length > 0 &&
		typeof e.refresh === "string" &&
		e.refresh.length > 0
	);
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		return JSON.parse(Buffer.from(parts[1], "base64").toString("utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function extractIdentityFromToken(token: string): { email?: string; accountId?: string } {
	const payload = decodeJwtPayload(token);
	if (!payload) return {};

	let email = typeof payload.email === "string" && payload.email ? payload.email : undefined;
	const openaiProfile = payload["https://api.openai.com/profile"];
	if (!email && openaiProfile && typeof openaiProfile === "object") {
		const pe = (openaiProfile as { email?: unknown }).email;
		if (typeof pe === "string" && pe) email = pe;
	}

	const auth = payload["https://api.openai.com/auth"];
	let accountId: string | undefined;
	if (auth && typeof auth === "object") {
		const aid = (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id;
		if (typeof aid === "string" && aid) accountId = aid;
	}
	return { email, accountId };
}

const profileCache = new Map<string, { email?: string; displayName?: string; uuid?: string }>();

async function fetchAnthropicProfile(token: string): Promise<{ email?: string; displayName?: string; uuid?: string } | null> {
	assertOutsideAccountTransaction();
	if (!token) return null;
	const cached = profileCache.get(token);
	if (cached) return cached;

	try {
		const response = await sharedUsageFetch("https://api.anthropic.com/api/oauth/profile", {
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${token}`,
				"anthropic-beta": "oauth-2025-04-20",
			},
			signal: AbortSignal.timeout(6000),
		});
		if (!response.ok) return null;
		const data = (await response.json()) as { account?: { email?: string; display_name?: string; uuid?: string } };
		const result = {
			email: data.account?.email,
			displayName: data.account?.display_name,
			uuid: data.account?.uuid,
		};
		profileCache.set(token, result);
		return result;
	} catch {
		return null;
	}
}

export function computeStableKey(provider: string, identity: { uuid?: string; accountId?: string; email?: string }): string | undefined {
	if (identity.uuid) return `${provider}:uuid:${identity.uuid}`;
	if (identity.accountId) return `${provider}:account:${identity.accountId}`;
	if (identity.email) return `${provider}:email:${identity.email.toLowerCase()}`;
	return undefined;
}

export function getAccountCaretakerThresholdMs(account: StoredAccount): number {
	const BASE_THRESHOLD_MS = 2.5 * 60 * 60 * 1000; // 2.5 hours
	const MAX_JITTER_MS = 2 * 60 * 60 * 1000; // up to 2 hours
	let hash = 0;
	for (let i = 0; i < account.id.length; i++) {
		hash = ((hash << 5) - hash + account.id.charCodeAt(i)) | 0;
	}
	const ratio = Math.abs(hash % 1000) / 1000;
	return BASE_THRESHOLD_MS + ratio * MAX_JITTER_MS;
}

export function isRateLimitError(error: unknown): boolean {
	const msg = String(error instanceof Error ? error.message : error).toLowerCase();
	return (
		msg.includes("429") ||
		msg.includes("rate limit") ||
		msg.includes("too many requests") ||
		msg.includes("slow_down")
	);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

function randomJitterMs(minSeconds = 6, maxSeconds = 15): number {
	const s = minSeconds + Math.random() * (maxSeconds - minSeconds);
	return Math.round(s * 1000);
}

export function isFatalOAuthError(error: unknown): boolean {
	const msg = String(error instanceof Error ? error.message : error).toLowerCase();
	return (
		msg.includes("invalid_grant") ||
		msg.includes("unauthorized_client") ||
		msg.includes("invalid_client") ||
		msg.includes("token has been revoked") ||
		msg.includes("token revoked") ||
		msg.includes("400 invalid_grant") ||
		msg.includes("401 unauthorized") ||
		msg.includes("status 400") ||
		msg.includes("status 401") ||
		msg.includes("status 403")
	);
}

function fingerprintToken(token: string): string {
	return createHash("sha256").update(token).digest("hex").slice(0, 10);
}

function formatRelativeTime(ms: number): string {
	const diff = ms - Date.now();
	if (diff <= 0) return "expired";
	const mins = Math.floor(diff / (60 * 1000));
	if (mins < 60) return `in ${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `in ${hours}h`;
	const days = Math.floor(hours / 24);
	return `in ${days}d`;
}

export function generateUniqueAlias(store: AccountsStore, provider: string, preferred: string): string {
	const existing = new Set(
		Object.values(store.accounts)
			.filter((a) => a.provider === provider)
			.map((a) => a.alias.toLowerCase()),
	);
	if (!existing.has(preferred.toLowerCase())) return preferred;
	let idx = 2;
	while (existing.has(`${preferred}-${idx}`.toLowerCase())) {
		idx++;
	}
	return `${preferred}-${idx}`;
}

export async function ensureAccountIdentity(account: StoredAccount): Promise<boolean> {
	let modified = false;

	if (!account.email || !account.stableKey) {
		if (account.provider === "anthropic") {
			const prof = await fetchAnthropicProfile(account.credential.access);
			if (prof) {
				if (prof.email && !account.email) {
					account.email = prof.email;
					modified = true;
				}
				const sk = computeStableKey(account.provider, prof);
				if (sk && account.stableKey !== sk) {
					account.stableKey = sk;
					modified = true;
				}
				if (prof.email && (account.alias.endsWith("-default") || account.alias.startsWith("anthropic-"))) {
					account.alias = prof.email;
					modified = true;
				}
			}
		} else if (account.provider === "openai-codex" || account.provider === "openai") {
			const identity = extractIdentityFromToken(account.credential.access);
			if (identity.email && !account.email) {
				account.email = identity.email;
				modified = true;
			}
			if (identity.accountId && !account.accountId) {
				account.accountId = identity.accountId;
				modified = true;
			}
			const sk = computeStableKey(account.provider, identity);
			if (sk && account.stableKey !== sk) {
				account.stableKey = sk;
				modified = true;
			}
			if (identity.email && (account.alias.endsWith("-default") || account.alias.startsWith("openai-"))) {
				account.alias = identity.email;
				modified = true;
			}
		} else if (account.provider === "antigravity") {
			const credEmail = (account.credential as any).email || (account.credential as any).accountId;
			if (typeof credEmail === "string" && credEmail.includes("@")) {
				account.email = credEmail;
				account.stableKey = `${account.provider}:email:${credEmail.toLowerCase()}`;
				if (account.alias.endsWith("-default")) {
					account.alias = credEmail;
				}
				modified = true;
			}
		}
	} else if (account.alias.endsWith("-default") && account.email) {
		account.alias = account.email;
		modified = true;
	}

	return modified;
}

// ============================================================================
// Usage Fetching (Anthropic & OpenAI Codex)
// ============================================================================

export function formatWindowSeconds(seconds: number): string {
	const DAY_SECONDS = 24 * 3600;
	const HOUR_SECONDS = 3600;
	if (seconds >= DAY_SECONDS && seconds % DAY_SECONDS === 0) return `${seconds / DAY_SECONDS}d`;
	if (seconds >= HOUR_SECONDS && seconds % HOUR_SECONDS === 0) return `${seconds / HOUR_SECONDS}h`;
	if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

interface WindowUsageItem {
	label: string;
	percent: number;
}

async function fetchAnthropicUsage(token: string): Promise<UsageResponse | null> {
	try {
		const response = await sharedUsageFetch("https://api.anthropic.com/api/oauth/usage", {
			method: "GET",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				"anthropic-beta": "oauth-2025-04-20",
			},
			signal: AbortSignal.timeout(8000),
		});
		if (!response.ok) return null;
		return (await response.json()) as UsageResponse;
	} catch {
		return null;
	}
}

async function fetchCodexUsage(token: string, accountId: string | undefined): Promise<WindowUsageItem[] | null> {
	if (!accountId) return null;
	try {
		const userAgent = typeof navigator !== "undefined" ? `pi (${navigator.platform || "unknown"})` : "pi";
		const response = await sharedUsageFetch("https://chatgpt.com/backend-api/wham/usage", {
			method: "GET",
			headers: {
				Accept: "*/*",
				Authorization: `Bearer ${token}`,
				"chatgpt-account-id": accountId,
				originator: "pi",
				"User-Agent": userAgent,
			},
			signal: AbortSignal.timeout(8000),
		});
		if (!response.ok) return null;
		const data = (await response.json()) as CodexUsageResponse;
		const items: WindowUsageItem[] = [];

		if (data.rate_limit?.primary_window && Number.isFinite(data.rate_limit.primary_window.used_percent)) {
			const win = data.rate_limit.primary_window;
			const label = win.limit_window_seconds ? formatWindowSeconds(win.limit_window_seconds) : "7d";
			items.push({ label, percent: Math.round(win.used_percent) });
		}
		if (data.rate_limit?.secondary_window && Number.isFinite(data.rate_limit.secondary_window.used_percent)) {
			const win = data.rate_limit.secondary_window;
			const label = win.limit_window_seconds ? formatWindowSeconds(win.limit_window_seconds) : "window";
			items.push({ label, percent: Math.round(win.used_percent) });
		}
		return items.length > 0 ? items : null;
	} catch {
		return null;
	}
}

async function fetchAnthropicUsageItems(token: string): Promise<WindowUsageItem[] | null> {
	const data = await fetchAnthropicUsage(token);
	if (!data) return null;
	const items: WindowUsageItem[] = [];
	if (data.five_hour && Number.isFinite(data.five_hour.utilization)) {
		items.push({ label: "5h", percent: Math.round(data.five_hour.utilization) });
	}
	if (data.seven_day && Number.isFinite(data.seven_day.utilization)) {
		items.push({ label: "7d", percent: Math.round(data.seven_day.utilization) });
	}
	return items.length > 0 ? items : null;
}

export async function getAccountUsageSummary(account: StoredAccount): Promise<string | null> {
	if (Date.now() >= account.credential.expires) return null;
	const cacheKey = `${account.id}:${fingerprintToken(account.credential.access)}`;
	const cached = usageCache.get(cacheKey);
	if (cached && Date.now() - cached.fetchedAt < USAGE_CACHE_TTL_MS) {
		return cached.summary;
	}

	let items: WindowUsageItem[] | null = null;
	if (account.provider === "anthropic") {
		items = await fetchAnthropicUsageItems(account.credential.access);
	} else if (account.provider === "openai-codex") {
		// Strictly legacy openai-codex only; native openai does not support wham usage
		const aid = account.accountId || extractIdentityFromToken(account.credential.access).accountId;
		items = await fetchCodexUsage(account.credential.access, aid);
	}

	if (!items || items.length === 0) return null;

	const summary = items.map((it) => `${it.label} ${it.percent}%`).join(" · ");
	usageCache.set(cacheKey, { summary, fetchedAt: Date.now() });
	return summary;
}

// ============================================================================
// Core Synchronization & Switch Logic
// ============================================================================

export async function resolveLiveIdentity(
	providerId: string,
	credential: OAuthCredentialPayload,
): Promise<{ email?: string; accountId?: string; uuid?: string }> {
	const fromJwt = extractIdentityFromToken(credential.access);
	let email = fromJwt.email;
	let accountId = fromJwt.accountId;
	let uuid: string | undefined;

	if (providerId === "anthropic") {
		const prof = await fetchAnthropicProfile(credential.access);
		if (prof) {
			if (prof.email) email = prof.email;
			if (prof.uuid) uuid = prof.uuid;
		}
	} else if (providerId === "antigravity") {
		const credEmail = (credential as any).email || (credential as any).accountId;
		if (typeof credEmail === "string" && credEmail.includes("@")) {
			email = credEmail;
		}
	}

	return { email, accountId, uuid };
}

/**
 * Finds which account an incoming live credential belongs to.
 * Matches by:
 * 1. Exact refresh token
 * 2. Stable key (uuid, accountId, email)
 * 3. Fallback to active account if identity does not conflict and this was not an explicit /login
 */
function matchAccountForCredential(
	store: AccountsStore,
	providerId: string,
	rawCred: OAuthCredentialPayload,
	liveIdentity: { uuid?: string; accountId?: string; email?: string },
	isExplicitLogin: boolean,
): StoredAccount | undefined {
	const providerAccounts = Object.values(store.accounts).filter((a) => a.provider === providerId);
	if (providerAccounts.length === 0) return undefined;

	// 1. Exact refresh token match
	const byRefresh = providerAccounts.find((a) => a.credential.refresh === rawCred.refresh);
	if (byRefresh) return byRefresh;

	// 2. Stable identity match
	const liveStableKey = computeStableKey(providerId, liveIdentity);
	if (liveStableKey) {
		const byStableKey = providerAccounts.find((a) => a.stableKey === liveStableKey);
		if (byStableKey) return byStableKey;
	}
	if (liveIdentity.uuid) {
		const byUuid = providerAccounts.find((a) => a.stableKey?.includes(`uuid:${liveIdentity.uuid}`));
		if (byUuid) return byUuid;
	}
	if (liveIdentity.accountId) {
		const byAccountId = providerAccounts.find((a) => a.accountId === liveIdentity.accountId);
		if (byAccountId) return byAccountId;
	}
	if (liveIdentity.email) {
		const byEmail = providerAccounts.find(
			(a) => a.email && a.email.toLowerCase() === liveIdentity.email!.toLowerCase(),
		);
		if (byEmail) return byEmail;
	}

	// If explicit /login occurred, and it didn't match any existing account by token or identity,
	// it is definitely a NEW account!
	if (isExplicitLogin) {
		return undefined;
	}

	// 3. If NOT an explicit /login, check if it is a rotated token for the active account
	const activeId = store.activeAccounts[providerId];
	const activeAcc = activeId ? store.accounts[activeId] : undefined;
	if (activeAcc) {
		// If activeAcc already has an identity, and live identity is different -> definitely different account!
		if (activeAcc.email && liveIdentity.email && activeAcc.email.toLowerCase() !== liveIdentity.email.toLowerCase()) {
			return undefined;
		}
		if (activeAcc.accountId && liveIdentity.accountId && activeAcc.accountId !== liveIdentity.accountId) {
			return undefined;
		}
		if (activeAcc.stableKey && liveStableKey && activeAcc.stableKey !== liveStableKey) {
			return undefined;
		}

		// Ensure it doesn't conflict with another known account's email/accountId
		const conflictsOther = providerAccounts.some(
			(a) =>
				a.id !== activeAcc.id &&
				((liveIdentity.email && a.email?.toLowerCase() === liveIdentity.email.toLowerCase()) ||
					(liveIdentity.accountId && a.accountId === liveIdentity.accountId)),
		);
		if (!conflictsOther) {
			return activeAcc;
		}
	}

	return undefined;
}

/**
 * Syncs any newly rotated tokens from current auth.json back into the
 * corresponding active account in oauth-accounts.json, or auto-adopts newly
 * logged-in accounts seamlessly.
 */
type LiveIdentity = Awaited<ReturnType<typeof resolveLiveIdentity>>;

/**
 * Prepare identity outside ALL account locks, then validate the snapshot under
 * both locks before syncing or executing a credential mutation. Callbacks must
 * not call this wrapper again: rotation and persistence stay in the locked phase.
 */
async function withSyncedAccounts<T>(fn: (store: AccountsStore) => Promise<T>): Promise<T> {
	assertOutsideAccountTransaction();
	for (let attempt = 0; attempt < 5; attempt++) {
		const snapshot = await storeLock.run(async () => ({
			auth: await readCurrentAuth(),
			store: await loadAccountsStore(),
			loginProvider: pendingLoginProvider,
			loginVersion: pendingLoginVersion,
		}));
		const identities = new Map<string, LiveIdentity>();
		for (const [provider, credential] of Object.entries(snapshot.auth)) {
			if (!isOAuthCredential(credential)) continue;
			const known = Object.values(snapshot.store.accounts).some(
				account => account.provider === provider && account.credential.refresh === credential.refresh,
			);
			if (!known) identities.set(provider, await resolveLiveIdentity(provider, credential));
		}
		const result = await storeLock.run(async () => {
			const auth = await readCurrentAuth();
			const store = await loadAccountsStore();
			// Includes store state and login generation: never use an identity
			// lookup against a changed account mapping or a later explicit login.
			if (!isDeepStrictEqual(auth, snapshot.auth) || !isDeepStrictEqual(store, snapshot.store) ||
				pendingLoginVersion !== snapshot.loginVersion) return { retry: true } as const;
			await syncLiveToStoreLocked(auth, store, identities, snapshot.loginProvider, snapshot.loginVersion);
			return { retry: false, value: await fn(store) } as const;
		});
		if (!result.retry) return result.value;
	}
	throw new Error("Credentials changed repeatedly during account synchronization; retry the operation");
}

export async function syncLiveToStore(): Promise<AccountsStore> {
	return withSyncedAccounts(async store => store);
}

// No identity/profile/quota network work is permitted in this phase.
async function syncLiveToStoreLocked(
	auth: AuthFile,
	store: AccountsStore,
	identities: Map<string, LiveIdentity>,
	loginProvider: string | null,
	loginVersion: number,
): Promise<AccountsStore> {
	assertAccountTransaction();
	let modified = false;

	for (const [providerId, rawCred] of Object.entries(auth)) {
		if (!isOAuthCredential(rawCred)) continue;

		// FAST-PATH: If this exact refresh token already exists in store, match immediately with zero network requests!
		const providerAccounts = Object.values(store.accounts).filter((a) => a.provider === providerId);
		const byRefresh = providerAccounts.find((a) => a.credential.refresh === rawCred.refresh);

		if (byRefresh) {
			if (store.activeAccounts[providerId] !== byRefresh.id) {
				store.activeAccounts[providerId] = byRefresh.id;
				modified = true;
			}
			if (
				byRefresh.credential.access !== rawCred.access ||
				byRefresh.credential.expires !== rawCred.expires
			) {
				byRefresh.credential = { ...byRefresh.credential, ...rawCred };
				byRefresh.status = "valid";
				byRefresh.statusError = undefined;
				byRefresh.lastRefreshError = undefined;
				byRefresh.nextRefreshAttemptAt = 0;
				byRefresh.refreshFailures = 0;
				byRefresh.lastUsedAt = Date.now();
				modified = true;
			}
			continue;
		}

		// Identity was prepared outside the transaction for this exact snapshot.
		const isExplicitLogin = loginProvider === providerId || loginProvider === "__any__";
		const liveIdentity = identities.get(providerId);
		if (!liveIdentity) throw new Error("Missing prepared account identity");
		const liveStableKey = computeStableKey(providerId, liveIdentity);
		const matched = matchAccountForCredential(store, providerId, rawCred, liveIdentity, isExplicitLogin);

		if (matched) {
			// Matched existing account: update tokens
			if (store.activeAccounts[providerId] !== matched.id) {
				store.activeAccounts[providerId] = matched.id;
				modified = true;
			}
			if (
				matched.credential.refresh !== rawCred.refresh ||
				matched.credential.access !== rawCred.access ||
				matched.credential.expires !== rawCred.expires
			) {
				matched.credential = { ...matched.credential, ...rawCred };
				matched.status = "valid";
				matched.statusError = undefined;
				matched.lastRefreshError = undefined;
				matched.nextRefreshAttemptAt = 0;
				matched.refreshFailures = 0;
				matched.lastUsedAt = Date.now();
				modified = true;
			}
			if (!matched.email && liveIdentity.email) {
				matched.email = liveIdentity.email;
				modified = true;
			}
			if (!matched.stableKey && liveStableKey) {
				matched.stableKey = liveStableKey;
				modified = true;
			}
			if (matched.alias.endsWith("-default") && liveIdentity.email) {
				matched.alias = liveIdentity.email;
				modified = true;
			}
			if (isExplicitLogin) {
				loginProvider = null;
			}
		} else {
			// Brand new account from /login or fresh external setup!
			const id = `${providerId}-${fingerprintToken(rawCred.refresh)}`;
			const preferredAlias = liveIdentity.email || `${providerId}-default`;
			const alias = generateUniqueAlias(store, providerId, preferredAlias);
			const stableKey = computeStableKey(providerId, liveIdentity);

			const newAcc: StoredAccount = {
				id,
				alias,
				provider: providerId,
				credential: rawCred,
				stableKey,
				email: liveIdentity.email,
				accountId: liveIdentity.accountId,
				addedAt: Date.now(),
				lastUsedAt: Date.now(),
				status: "valid",
			};

			store.accounts[id] = newAcc;
			store.activeAccounts[providerId] = id;
			modified = true;

			if (isExplicitLogin) {
				loginProvider = null;
			}
		}
	}

	if (modified) {
		await saveAccountsStore(store);
	}
	if (pendingLoginVersion === loginVersion && pendingLoginProvider !== loginProvider) {
		setPendingLoginProvider(loginProvider);
	}
	return store;
}

/**
 * Refreshes an account's token using the native provider implementation.
 */
type RefreshResult = { success: boolean; credential?: OAuthCredentialPayload; error?: string; fatal?: boolean; unsupported?: boolean };

// All refresh entry points share the same transaction as Pi's native auth store.
// Re-read after locking, and persist rotated credentials before releasing the lock.
async function refreshSingleAccount(account: StoredAccount, modelRegistry: any): Promise<RefreshResult> {
	return withSyncedAccounts(store => refreshAccountLocked(account, modelRegistry, store));
}

async function refreshAccountLocked(
	account: StoredAccount,
	modelRegistry: any,
	store: AccountsStore,
): Promise<RefreshResult> {
	assertAccountTransaction();
	const target = store.accounts[account.id];
	if (!target) return { success: false, error: "Account was deleted" };
	if ((target.credential.refresh !== account.credential.refresh || target.credential.access !== account.credential.access) &&
		target.credential.expires > Date.now() + SWITCH_REFRESH_THRESHOLD_MS) {
		return { success: true, credential: target.credential };
	}
	if (Date.now() < (target.nextRefreshAttemptAt ?? 0)) {
		return { success: false, fatal: isFatalOAuthError(target.statusError || ""), error: target.lastRefreshError || target.statusError || "Refresh cooldown active" };
	}
	if ((target.lastRefreshedAt ?? 0) > Date.now() - 60_000 && target.credential.expires > Date.now() + SWITCH_REFRESH_THRESHOLD_MS) {
		return { success: true, credential: target.credential };
	}
	const provider = modelRegistry?.getProvider?.(target.provider);
	const refreshFn = provider?.auth?.oauth?.refresh;
	if (typeof refreshFn !== "function") {
		const error = `Provider "${target.provider}" does not expose OAuth refresh`;
		if (Date.now() >= target.credential.expires) {
			target.status = "expired";
			target.statusError = error;
			await saveAccountsStore(store);
		}
		return { success: false, unsupported: true, error };
	}

	let result: RefreshResult;
	try {
		// Start the timeout after acquiring the lock, not while waiting for another process.
		const refreshed = (await refreshFn(target.credential, AbortSignal.timeout(15_000))) as OAuthCredentialPayload;
		if (!refreshed?.access || !refreshed?.refresh || !Number.isFinite(refreshed.expires)) {
			throw new Error("Invalid credential returned from provider refresh");
		}
		result = { success: true, credential: { ...target.credential, ...refreshed, type: "oauth" } };
	} catch (error) {
		result = { success: false, error: error instanceof Error ? error.message : String(error), fatal: isFatalOAuthError(error) };
	}
	if (result.success && result.credential) {
		target.credential = result.credential;
		target.status = "valid";
		target.statusError = undefined;
		target.lastRefreshError = undefined;
		target.refreshFailures = 0;
		target.nextRefreshAttemptAt = 0;
		target.lastRefreshedAt = Date.now();
		if (store.activeAccounts[target.provider] === target.id) {
			const auth = await readCurrentAuth();
			auth[target.provider] = result.credential;
			await writeCurrentAuth(auth);
		}
	} else {
		target.refreshFailures = (target.refreshFailures ?? 0) + 1;
		target.nextRefreshAttemptAt = Date.now() + Math.min(60_000 * 2 ** Math.min(target.refreshFailures - 1, 6), 3_600_000);
		target.lastRefreshError = result.error;
		if (result.fatal || Date.now() >= target.credential.expires) {
			target.status = "expired";
			target.statusError = result.error;
		}
	}
	await saveAccountsStore(store);
	return result;
}

/** One pass per hour across all processes; normal passes only refresh dormant accounts. */
export async function runGlobalCaretaker(
	modelRegistry: any,
	options: { force?: boolean; signal?: AbortSignal; skipDelay?: boolean } = {},
): Promise<{ refreshed: string[]; failed: string[]; skipped: string[] }> {
	const empty = { refreshed: [] as string[], failed: [] as string[], skipped: [] as string[] };
	if (isCaretakerRunning) return empty;
	isCaretakerRunning = true;
	try {
		return (await withCaretakerLease(async () => {
			const report = { refreshed: [] as string[], failed: [] as string[], skipped: [] as string[] };
			const trippedProviders = new Set<string>();
			const attemptedProviders = new Set<string>();
			const initialStore = await syncLiveToStore();
			for (const snapshot of Object.values(initialStore.accounts)) {
				if (options.signal?.aborted) break;
				if (trippedProviders.has(snapshot.provider)) {
					report.failed.push(`${snapshot.provider}/${snapshot.alias}: Rate limit circuit breaker active; skipped.`);
					continue;
				}
				if (!options.skipDelay && attemptedProviders.has(snapshot.provider)) {
					await sleep(randomJitterMs(6, 15), options.signal);
				}
				if (options.signal?.aborted) break;
				await withSyncedAccounts(async latest => {
					if (options.signal?.aborted) return;
					const account = latest.accounts[snapshot.id];
					if (!account) return;
					if ((!options.force && latest.activeAccounts[account.provider] === account.id) ||
						(!options.force && Date.now() + getAccountCaretakerThresholdMs(account) < account.credential.expires) ||
						Date.now() < (account.nextRefreshAttemptAt ?? 0) ||
						(account.lastRefreshedAt ?? 0) > Date.now() - 60_000) {
						report.skipped.push(account.alias);
						return;
					}
					attemptedProviders.add(account.provider);
					// Once rotation starts, finish persistence even if the session closes.
					const result = await refreshAccountLocked(account, modelRegistry, latest);
					if (result.success) report.refreshed.push(`${account.provider}/${account.alias}`);
					else if (result.unsupported) report.skipped.push(account.alias);
					else {
						report.failed.push(`${account.provider}/${account.alias}: ${result.error}`);
						if (isRateLimitError(result.error)) trippedProviders.add(account.provider);
					}
				});
			}
			return report;
		}, options)) ?? empty;
	} finally {
		isCaretakerRunning = false;
	}
}

/**
 * Safe Account Switch:
 * 1. Waits for agent to be idle (prevents breaking in-flight streaming).
 * 2. Synchronizes live auth.json back to active slot.
 * 3. Pre-flight check & refresh target account if expiring.
 * 4. Writes target account into auth.json[provider].
 * 5. Reloads ModelRuntime.
 */
async function reloadRuntime(modelRegistry: any): Promise<void> {
	// Must run OUTSIDE the auth transaction: runtime reload takes auth.json.lock.
	try { modelRegistry?.runtime?.credentials?.store?.reload?.(); } catch {}
	try { await modelRegistry?.refresh?.({ allowNetwork: false }); } catch {}
}

export async function switchAccount(
	ctx: ExtensionCommandContext | ExtensionContext,
	targetAccountId: string,
): Promise<{ ok: boolean; message: string }> {
	if (typeof (ctx as any)?.waitForIdle === "function") await (ctx as any).waitForIdle();
	const result = await withSyncedAccounts(async store => {
		const target = store.accounts[targetAccountId];
		if (!target) return { ok: false, message: `Account "${targetAccountId}" not found.` };
		let warningNote = "";
		if (Date.now() + SWITCH_REFRESH_THRESHOLD_MS >= target.credential.expires) {
			const refreshed = await refreshAccountLocked(target, (ctx as any).modelRegistry, store);
			if (refreshed.success && refreshed.credential) {
				target.credential = refreshed.credential;
			} else if (refreshed.fatal || Date.now() >= target.credential.expires) {
				return { ok: false, message: `Account "${target.alias}" authorization failed (${refreshed.error}). Please re-authenticate via /login.` };
			} else {
				warningNote = " (Refresh unavailable; using valid access token)";
			}
		}
		// The locked refresh persisted status/backoff; re-read before selecting the account.
		const latest = await loadAccountsStore();
		const selected = latest.accounts[target.id];
		selected.lastUsedAt = Date.now();
		latest.activeAccounts[target.provider] = selected.id;
		const auth = await readCurrentAuth();
		auth[target.provider] = selected.credential;
		// auth is authoritative; syncLiveToStore can recover if the following store write fails.
		await writeCurrentAuth(auth);
		await saveAccountsStore(latest);
		lastKnownActiveAccountByProvider.set(target.provider, selected.id);
		const display = selected.email && selected.alias !== selected.email
			? `${selected.alias} (${selected.email})` : (selected.email || selected.alias);
		return { ok: true, message: `Account: ${display}${warningNote}` };
	});
	if (result.ok) await reloadRuntime((ctx as any).modelRegistry);
	return result;
}

/**
 * Deletes an account. If the deleted account is currently active in auth.json:
 * - Cleans up auth.json[providerId] so syncLiveToStore will not resurrect it.
 * - Triggers modelRegistry.refresh() to reflect logout.
 */
export async function deleteAccount(accountId: string, modelRegistry?: any): Promise<boolean> {
	const removed = await withSyncedAccounts(async store => {
		const acc = store.accounts[accountId];
		if (!acc) return false;

		const providerId = acc.provider;
		const wasActive = store.activeAccounts[providerId] === accountId;

		delete store.accounts[accountId];
		if (wasActive) {
			delete store.activeAccounts[providerId];

			const auth = await readCurrentAuth();
			if (auth[providerId]) {
				delete auth[providerId];
				await writeCurrentAuth(auth);
			}

		}

		await saveAccountsStore(store);
		return true;
	});
	if (removed) await reloadRuntime(modelRegistry);
	return removed;
}

/**
 * Renames an account with provider-scoped alias uniqueness check (case-insensitive).
 */
export async function renameAccount(accountId: string, newAlias: string): Promise<{ ok: boolean; error?: string }> {
	return storeLock.run(async () => {
		const store = await loadAccountsStore();
		const acc = store.accounts[accountId];
		if (!acc) return { ok: false, error: "Account not found." };

		const trimmed = newAlias.trim();
		if (!trimmed) return { ok: false, error: "Alias cannot be empty." };

		const conflict = Object.values(store.accounts).find(
			(a) => a.provider === acc.provider && a.id !== acc.id && a.alias.toLowerCase() === trimmed.toLowerCase(),
		);
		if (conflict) {
			return { ok: false, error: `Account with alias "${trimmed}" already exists for ${acc.provider}.` };
		}

		acc.alias = trimmed;
		await saveAccountsStore(store);
		return { ok: true };
	});
}

// ============================================================================
// Interactive TUI Components
// ============================================================================

function createSelectList(
	items: SelectItem[],
	theme: { fg(name: string, text: string): string },
	done: (value: string | null) => void,
): SelectList {
	const selectList = new SelectList(
		items,
		Math.min(items.length, 12),
		{
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
		{
			minPrimaryColumnWidth: 28,
			maxPrimaryColumnWidth: 38,
		},
	);
	selectList.onSelect = (item) => done(item.value);
	selectList.onCancel = () => done(null);
	return selectList;
}

async function showCustomSelect(
	ctx: { ui: { custom<T>(factory: (tui: any, theme: any, keybindings: any, done: (value: T) => void) => any): Promise<T> } },
	title: string,
	items: SelectItem[],
	onReady?: (updateItems: (items: SelectItem[]) => void) => void,
): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		let currentItems = items;
		let container = new Container();
		let selectList = createSelectList(currentItems, theme, done);

		const rebuild = (nextItems: SelectItem[], preserveSelectedValue?: string | null) => {
			currentItems = nextItems;
			container = new Container();
			container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
			container.addChild(new Text(theme.fg("accent", theme.bold(title))));
			selectList = createSelectList(currentItems, theme, done);
			if (preserveSelectedValue) {
				const nextIndex = currentItems.findIndex((item) => item.value === preserveSelectedValue);
				if (nextIndex >= 0) selectList.setSelectedIndex(nextIndex);
			}
			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")));
			container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		};

		rebuild(currentItems);

		const updateItems = (nextItems: SelectItem[]) => {
			const selectedValue = selectList.getSelectedItem()?.value ?? null;
			rebuild(nextItems, selectedValue);
			container.invalidate();
			tui.requestRender();
		};
		if (onReady) onReady(updateItems);

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

function formatAccountItemDescription(account: StoredAccount, usageSummary?: string): string {
	const statusBadge =
		account.status === "valid"
			? `valid (${formatRelativeTime(account.credential.expires)})`
			: `✕ expired`;
	const parts: string[] = [];
	if (account.email && account.alias !== account.email) {
		parts.push(account.email);
	}
	parts.push(statusBadge);
	if (usageSummary) {
		parts.push(usageSummary);
	}
	return parts.join("  ·  ");
}

async function runInteractiveMenu(ctx: ExtensionCommandContext): Promise<void> {
	for (;;) {
		const store = await syncLiveToStore();
		const auth = await readCurrentAuth();

		const providerAccounts = new Map<string, StoredAccount[]>();
		for (const acc of Object.values(store.accounts)) {
			const list = providerAccounts.get(acc.provider) || [];
			list.push(acc);
			providerAccounts.set(acc.provider, list);
		}

		const allProviders = new Set<string>([
			...providerAccounts.keys(),
			...Object.keys(auth).filter((p) => isOAuthCredential(auth[p])),
		]);

		if (allProviders.size === 0) {
			ctx.ui.notify("No OAuth credentials found. Use /login to sign in to a provider first.", "warning");
			return;
		}

		const menuItems: SelectItem[] = [];
		for (const provider of Array.from(allProviders).sort()) {
			const accounts = providerAccounts.get(provider) || [];
			const activeId = store.activeAccounts[provider];
			const activeAcc = accounts.find((a) => a.id === activeId);
			const activeDesc = activeAcc ? `active: ${activeAcc.email || activeAcc.alias}` : "no active account";
			menuItems.push({
				label: `${provider} (${accounts.length} account${accounts.length > 1 ? "s" : ""})`,
				value: `provider:${provider}`,
				description: activeDesc,
			});
		}

		menuItems.push({
			label: "↻ Check & refresh all accounts now",
			value: "action:refresh_all",
			description: "Run global caretaker to keep all accounts alive",
		});

		const selectedAction = await showCustomSelect(ctx, "OAuth Accounts Manager", menuItems);
		if (!selectedAction) return;

		if (selectedAction === "action:refresh_all") {
			ctx.ui.notify("Checking and refreshing dormant accounts...", "info");
			const report = await runGlobalCaretaker((ctx as any).modelRegistry, { force: true });
			const msg = `Caretaker finished: ${report.refreshed.length} refreshed, ${report.failed.length} failed, ${report.skipped.length} valid.`;
			ctx.ui.notify(msg, report.failed.length > 0 ? "warning" : "info");
			continue;
		}

		if (selectedAction.startsWith("provider:")) {
			const providerId = selectedAction.slice("provider:".length);
			const res = await runProviderAccountsMenu(ctx, providerId);
			if (res === "exit") return;
		}
	}
}

async function runProviderAccountsMenu(ctx: ExtensionCommandContext, providerId: string): Promise<"exit" | void> {
	for (;;) {
		const store = await loadAccountsStore();
		const accounts = Object.values(store.accounts).filter((a) => a.provider === providerId);
		const activeId = store.activeAccounts[providerId];

		const buildItems = (): SelectItem[] => {
			const items: SelectItem[] = [];
			for (const acc of accounts) {
				const isActive = acc.id === activeId;
				const displayTitle = acc.email || acc.alias;
				const label = isActive ? `● ${displayTitle} (active)` : `○ ${displayTitle}`;
				const cachedUsage = usageCache.get(`${acc.id}:${fingerprintToken(acc.credential.access)}`)?.summary;
				items.push({
					label,
					value: `acc:${acc.id}`,
					description: formatAccountItemDescription(acc, cachedUsage),
				});
			}
			return items;
		};

		let menuOpen = true;
		const selected = await showCustomSelect(ctx, `Accounts for ${providerId}:`, buildItems(), (updateItems) => {
			// Do not enqueue a burst for every account. Stop scheduling when the menu closes.
			void (async () => {
				for (const acc of accounts) {
					if (!menuOpen) break;
					try {
						if (await ensureAccountIdentity(acc)) {
							await storeLock.run(async () => {
								const latest = await loadAccountsStore();
								if (latest.accounts[acc.id]) {
									latest.accounts[acc.id].email = acc.email;
									latest.accounts[acc.id].alias = acc.alias;
									latest.accounts[acc.id].stableKey = acc.stableKey;
									await saveAccountsStore(latest);
								}
							});
						}
						if (!menuOpen) break;
						await getAccountUsageSummary(acc);
						if (menuOpen) updateItems(buildItems());
					} catch { /* Quota/identity enrichment is best-effort. */ }
				}
			})();
		}).finally(() => { menuOpen = false; });

		if (!selected) return;

		if (selected.startsWith("acc:")) {
			const accId = selected.slice("acc:".length);
			const acc = store.accounts[accId];
			if (!acc) continue;
			const res = await runAccountActionMenu(ctx, acc);
			if (res === "exit") return "exit";
		}
	}
}

async function runAccountActionMenu(ctx: ExtensionCommandContext, account: StoredAccount): Promise<"exit" | void> {
	const store = await loadAccountsStore();
	const isActive = store.activeAccounts[account.provider] === account.id;

	const actions: SelectItem[] = [];
	if (!isActive) {
		actions.push({
			label: "⚡ Switch to this account",
			value: "switch",
			description: `Make "${account.alias}" the active credential for ${account.provider}`,
		});
	}
	actions.push({
		label: "↻ Refresh token now",
		value: "refresh",
		description: "Test and extend token validity immediately",
	});
	actions.push({
		label: "✎ Rename alias",
		value: "rename",
		description: `Change display name (currently: ${account.alias})`,
	});
	actions.push({
		label: "🗑 Delete account",
		value: "delete",
		description: isActive ? "Log out and remove this active account" : "Remove this account from the pool",
	});

	const choice = await showCustomSelect(ctx, `Account: ${account.provider} / ${account.alias}`, actions);
	if (!choice) return;

	if (choice === "switch") {
		const res = await switchAccount(ctx, account.id);
		if (res.ok) {
			ctx.ui.notify(res.message);
			return "exit";
		} else {
			ctx.ui.notify(res.message, "error");
		}
	} else if (choice === "refresh") {
		ctx.ui.notify(`Refreshing "${account.alias}"...`, "info");
		const res = await refreshSingleAccount(account, (ctx as any).modelRegistry);
		if (res.success) {
			await reloadRuntime((ctx as any).modelRegistry);
			ctx.ui.notify("Token refreshed successfully.", "info");
		} else {
			ctx.ui.notify(`Refresh failed: ${res.error}`, res.fatal ? "error" : "warning");
		}
	} else if (choice === "rename") {
		const newAlias = await ctx.ui.input("Enter new alias:", account.alias);
		if (newAlias && newAlias.trim()) {
			const res = await renameAccount(account.id, newAlias.trim());
			if (res.ok) {
				ctx.ui.notify(`Renamed to "${newAlias.trim()}".`, "info");
			} else {
				ctx.ui.notify(res.error || "Failed to rename.", "error");
			}
		}
	} else if (choice === "delete") {
		const confirmMsg = isActive
			? `"${account.alias}" is currently ACTIVE. Deleting it will log out of ${account.provider}. Proceed?`
			: `Are you sure you want to remove "${account.alias}" from ${account.provider}?`;
		const confirm = await ctx.ui.confirm("Delete account", confirmMsg);
		if (confirm) {
			await deleteAccount(account.id, (ctx as any).modelRegistry);
			ctx.ui.notify(`Removed account "${account.alias}".`, "info");
		}
	}
}

// ============================================================================
// CLI Command Handlers
// ============================================================================

function printAccountList(store: AccountsStore): string[] {
	const lines: string[] = [];
	const providers = new Set(Object.values(store.accounts).map((a) => a.provider));

	if (providers.size === 0) {
		return ["No accounts configured in pool. Use /login to log into an account."];
	}

	for (const provider of Array.from(providers).sort()) {
		lines.push(`\n[${provider}]`);
		const accounts = Object.values(store.accounts).filter((a) => a.provider === provider);
		const activeId = store.activeAccounts[provider];
		for (const acc of accounts) {
			const marker = acc.id === activeId ? "● [ACTIVE]" : "○";
			const exp = formatRelativeTime(acc.credential.expires);
			const email = acc.email ? `(${acc.email})` : "";
			const status = acc.status === "valid" ? `valid (exp ${exp})` : `EXPIRED: ${acc.statusError || "invalid_grant"}`;
			lines.push(`  ${marker} ${acc.alias} ${email}  ·  ${status}`);
		}
	}
	return lines;
}

// ============================================================================
// Extension Lifecycle & Registration
// ============================================================================

const lastKnownActiveAccountByProvider = new Map<string, string>();

export default function (pi: ExtensionAPI) {
	// When another window switches the account on disk, notify the user on turn start
	pi.on("turn_start", async (_event, ctx) => {
		try {
			const store = await syncLiveToStore();
			const activeModel = (ctx as any).model;
			const provider = activeModel?.provider;
			if (provider) {
				const currentActiveId = store.activeAccounts[provider];
				const prevActiveId = lastKnownActiveAccountByProvider.get(provider);
				if (currentActiveId && prevActiveId && currentActiveId !== prevActiveId) {
					const acc = store.accounts[currentActiveId];
					if (acc) {
						const displayAccount = acc.email && acc.alias !== acc.email
							? `${acc.alias} (${acc.email})`
							: (acc.email || acc.alias);
						ctx.ui?.notify(`Account: ${displayAccount}`);
					}
				}
				if (currentActiveId) {
					lastKnownActiveAccountByProvider.set(provider, currentActiveId);
				}
			}
		} catch {}
	});

	// Sync live tokens on turn_end and agent_end to capture in-flight token rotations
	pi.on("turn_end", async () => {
		await syncLiveToStore().catch(() => {});
	});

	pi.on("agent_end", async () => {
		await syncLiveToStore().catch(() => {});
	});

	// Capture user typing /login to prepare safe capture of new accounts
	pi.on("input", async (event) => {
		const text = event.text.trim();
		if (text.startsWith("/login")) {
			await syncLiveToStore().catch(() => {});
			const parts = text.split(/\s+/);
			setPendingLoginProvider(parts[1]?.toLowerCase() || "__any__");
		}
	});

	// Auto-sync on session start and launch background caretaker
	pi.on("session_start", async (_event, ctx) => {
		try {
			const store = await syncLiveToStore();
			for (const [prov, accId] of Object.entries(store.activeAccounts)) {
				lastKnownActiveAccountByProvider.set(prov, accId);
			}
		} catch {}

		caretakerController?.abort();
		const controller = new AbortController();
		caretakerController = controller;
		const registry = (ctx as any).modelRegistry;
		const run = () => {
			if (!controller.signal.aborted) void runGlobalCaretaker(registry, { signal: controller.signal }).catch(() => {});
		};
		run();
		if (caretakerTimer) clearInterval(caretakerTimer);
		caretakerTimer = setInterval(run, CARETAKER_INTERVAL_MS);
	});

	pi.on("session_shutdown", () => {
		caretakerController?.abort();
		caretakerController = null;
		if (caretakerTimer) {
			clearInterval(caretakerTimer);
			caretakerTimer = null;
		}
	});

	const commandHandler = async (argsString: string, ctx: ExtensionCommandContext) => {
		const args = argsString.trim().split(/\s+/).filter(Boolean);
		const subcommand = args[0]?.toLowerCase();

		if (!subcommand) {
			if (!ctx.hasUI) {
				const store = await syncLiveToStore();
				const output = printAccountList(store);
				pi.sendMessage({
					customType: MESSAGE_TYPE,
					content: output.join("\n"),
					display: true,
				});
				return;
			}
			await runInteractiveMenu(ctx);
			return;
		}

		if (subcommand === "list" || subcommand === "ls") {
			const store = await syncLiveToStore();
			const output = printAccountList(store);
			pi.sendMessage({
				customType: MESSAGE_TYPE,
				content: output.join("\n"),
				display: true,
			});
			return;
		}

		if (subcommand === "check" || subcommand === "refresh") {
			ctx.ui?.notify("Checking and refreshing all accounts...", "info");
			const report = await runGlobalCaretaker((ctx as any).modelRegistry, { force: true });
			const lines = [
				"Account Caretaker Report:",
				`  Refreshed: ${report.refreshed.length > 0 ? report.refreshed.join(", ") : "none"}`,
				`  Failed:    ${report.failed.length > 0 ? report.failed.join(", ") : "none"}`,
				`  Valid:     ${report.skipped.length > 0 ? report.skipped.join(", ") : "none"}`,
			];
			pi.sendMessage({
				customType: MESSAGE_TYPE,
				content: lines.join("\n"),
				display: true,
			});
			return;
		}

		if (subcommand === "switch") {
			const provider = args[1]?.toLowerCase();
			const alias = args[2];
			if (!provider || !alias) {
				ctx.ui?.notify("Usage: /accounts switch <provider> <alias>", "warning");
				return;
			}
			const store = await syncLiveToStore();
			const target = Object.values(store.accounts).find(
				(a) => a.provider.toLowerCase() === provider && a.alias.toLowerCase() === alias.toLowerCase(),
			);
			if (!target) {
				ctx.ui?.notify(`Account with alias "${alias}" not found for provider "${provider}".`, "error");
				return;
			}
			const res = await switchAccount(ctx, target.id);
			if (res.ok) {
				ctx.ui?.notify(res.message, "info");
			} else {
				ctx.ui?.notify(res.message, "error");
			}
			return;
		}

		if (subcommand === "rename") {
			const provider = args[1]?.toLowerCase();
			const oldAlias = args[2];
			const newAlias = args[3];
			if (!provider || !oldAlias || !newAlias) {
				ctx.ui?.notify("Usage: /accounts rename <provider> <old_alias> <new_alias>", "warning");
				return;
			}
			const store = await syncLiveToStore();
			const target = Object.values(store.accounts).find(
				(a) => a.provider.toLowerCase() === provider && a.alias.toLowerCase() === oldAlias.toLowerCase(),
			);
			if (!target) {
				ctx.ui?.notify(`Account "${oldAlias}" not found for provider "${provider}".`, "error");
				return;
			}
			const res = await renameAccount(target.id, newAlias);
			if (res.ok) {
				ctx.ui?.notify(`Renamed "${oldAlias}" to "${newAlias.trim()}".`, "info");
			} else {
				ctx.ui?.notify(res.error || "Rename failed.", "error");
			}
			return;
		}

		if (subcommand === "remove" || subcommand === "rm" || subcommand === "delete") {
			const provider = args[1]?.toLowerCase();
			const alias = args[2];
			if (!provider || !alias) {
				ctx.ui?.notify("Usage: /accounts remove <provider> <alias>", "warning");
				return;
			}
			const store = await syncLiveToStore();
			const target = Object.values(store.accounts).find(
				(a) => a.provider.toLowerCase() === provider && a.alias.toLowerCase() === alias.toLowerCase(),
			);
			if (!target) {
				ctx.ui?.notify(`Account "${alias}" not found for provider "${provider}".`, "error");
				return;
			}
			await deleteAccount(target.id, (ctx as any).modelRegistry);
			ctx.ui?.notify(`Removed account "${alias}" from ${provider}.`, "info");
			return;
		}

		ctx.ui?.notify(`Unknown subcommand "${subcommand}". Usage: /accounts [list|switch|rename|check|remove]`, "warning");
	};

	pi.registerCommand("accounts", {
		description: "Manage and switch multiple OAuth accounts with background keep-alive",
		getArgumentCompletions: async (prefix: string) => {
			const subcommands = [
				{ value: "list", label: "list", description: "List all accounts in pool" },
				{ value: "switch", label: "switch", description: "Switch active account (/accounts switch <provider> <alias>)" },
				{ value: "rename", label: "rename", description: "Rename an account alias (/accounts rename <provider> <old> <new>)" },
				{ value: "check", label: "check", description: "Run background keep-alive check and refresh now" },
				{ value: "remove", label: "remove", description: "Delete an account from pool" },
			];
			if (!prefix) return subcommands;
			const parts = prefix.trimStart().split(/\s+/);
			if (parts.length <= 1) {
				return subcommands.filter((c) => c.value.startsWith(parts[0]));
			}
			if (parts[0] === "switch" || parts[0] === "remove" || parts[0] === "rename") {
				const store = await loadAccountsStore();
				if (parts.length === 2) {
					const providers = Array.from(new Set(Object.values(store.accounts).map((a) => a.provider)));
					return providers.filter((p) => p.startsWith(parts[1])).map((p) => ({ value: `${parts[0]} ${p}` }));
				}
				if (parts.length === 3) {
					const provider = parts[1].toLowerCase();
					const aliases = Object.values(store.accounts)
						.filter((a) => a.provider.toLowerCase() === provider)
						.map((a) => a.alias);
					return aliases.filter((a) => a.startsWith(parts[2])).map((a) => ({ value: `${parts[0]} ${parts[1]} ${a}` }));
				}
			}
			return null;
		},
		handler: commandHandler,
	});
}
