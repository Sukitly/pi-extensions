import { DynamicBorder, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { access, chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const BACKUP_DIR = join(homedir(), ".pi", "agent", "auth-backups");
const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");
const MESSAGE_TYPE = "auth-backup";
const NAME_RE = /^[a-zA-Z0-9._-]+$/;

type AuthFile = Record<string, unknown>;

interface BackupInfo {
	name: string;
	path: string;
	createdAtMs: number;
	mtimeMs: number;
	providers: string[];
}

interface UsageBucket {
	utilization: number;
	resets_at: string | null;
}

interface UsageResponse {
	five_hour: UsageBucket | null;
	seven_day: UsageBucket | null;
	seven_day_opus?: UsageBucket | null;
}

interface CodexWindow {
	used_percent: number;
	reset_at: number;
}

interface CodexUsageResponse {
	rate_limit?: {
		primary_window?: CodexWindow | null;
		secondary_window?: CodexWindow | null;
	} | null;
}

const NEW_BACKUP_VALUE = "__new__";
const ACTION_BACKUP_HERE = "__action_backup_here__";
const ACTION_RESTORE = "__action_restore__";
const ACTION_DELETE = "__action_delete__";
const ACTION_CANCEL = "__action_cancel__";
const USAGE_CACHE_TTL_MS = 3 * 60 * 1000;
const latestUsageByBackupName = new Map<string, { summary: string; fetchedAt: number }>();

function isValidBackupName(name: string): boolean {
	return NAME_RE.test(name);
}

function backupPath(name: string): string {
	return join(BACKUP_DIR, `${name}.json`);
}

function formatTimestamp(timestamp: number): string {
	const d = new Date(timestamp);
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function summarizeProviders(data: AuthFile): string[] {
	return Object.keys(data).sort();
}

function formatProviders(providers: string[]): string {
	return providers.length > 0 ? providers.join(", ") : "empty";
}

function buildBackupDescription(info: BackupInfo, usageSummary?: string): string {
	const parts = [`created ${formatTimestamp(info.createdAtMs)}`];
	if (usageSummary) {
		parts.push(usageSummary);
	} else {
		parts.push(formatProviders(info.providers));
	}
	return parts.join("  ·  ");
}

function buildBackupConfirmMessage(info: BackupInfo, usageSummary?: string): string {
	return `${info.name} · ${buildBackupDescription(info, usageSummary)}`;
}

function getFreshUsageSummary(name: string): string | undefined {
	const cached = latestUsageByBackupName.get(name);
	if (!cached) return undefined;
	if (Date.now() - cached.fetchedAt > USAGE_CACHE_TTL_MS) return undefined;
	return cached.summary;
}

function unixSecondsToIso(timestamp: number | null | undefined): string | null {
	if (!timestamp || !Number.isFinite(timestamp)) return null;
	return new Date(timestamp * 1000).toISOString();
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		return JSON.parse(atob(parts[1])) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function extractCodexAccountId(token: string): string | null {
	const payload = decodeJwtPayload(token);
	const auth = payload?.["https://api.openai.com/auth"];
	if (!auth || typeof auth !== "object") return null;
	const accountId = (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id;
	return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

function normalizeCodexUsage(data: CodexUsageResponse): UsageResponse {
	return {
		five_hour: data.rate_limit?.primary_window
			? {
				utilization: data.rate_limit.primary_window.used_percent,
				resets_at: unixSecondsToIso(data.rate_limit.primary_window.reset_at),
			}
			: null,
		seven_day: data.rate_limit?.secondary_window
			? {
				utilization: data.rate_limit.secondary_window.used_percent,
				resets_at: unixSecondsToIso(data.rate_limit.secondary_window.reset_at),
			}
			: null,
	};
}

function formatUsagePercent(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return "--";
	return `${Math.round(value)}%`;
}

function formatProviderUsage(label: string, usage: UsageResponse | null): string {
	if (!usage) return `${label} --`;
	return `${label} 5h ${formatUsagePercent(usage.five_hour?.utilization)} 7d ${formatUsagePercent(usage.seven_day?.utilization)}`;
}

function getApiKeyEntry(entry: unknown): string | null {
	if (!entry || typeof entry !== "object") return null;
	const key = (entry as { key?: unknown }).key;
	return typeof key === "string" && key.length > 0 && !key.startsWith("!") ? key : null;
}

function getOAuthAccessEntry(entry: unknown): string | null {
	if (!entry || typeof entry !== "object") return null;
	const access = (entry as { access?: unknown }).access;
	return typeof access === "string" && access.length > 0 ? access : null;
}

function isOAuthEntry(entry: unknown): boolean {
	if (!entry || typeof entry !== "object") return false;
	const access = (entry as { access?: unknown }).access;
	const refresh = (entry as { refresh?: unknown }).refresh;
	return typeof access === "string" && access.length > 0 && typeof refresh === "string" && refresh.length > 0;
}

function getAnthropicToken(auth: AuthFile): string | null {
	return getOAuthAccessEntry(auth["anthropic"]);
}

function getCodexToken(auth: AuthFile): string | null {
	return getOAuthAccessEntry(auth["openai-codex"]);
}

async function fetchAnthropicUsage(token: string): Promise<UsageResponse | null> {
	try {
		const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
			method: "GET",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				"anthropic-beta": "oauth-2025-04-20",
			},
			signal: AbortSignal.timeout(10000),
		});
		if (!response.ok) return null;
		return (await response.json()) as UsageResponse;
	} catch {
		return null;
	}
}

async function fetchCodexUsage(token: string): Promise<UsageResponse | null> {
	try {
		const accountId = extractCodexAccountId(token);
		if (!accountId) return null;
		const userAgent = typeof navigator !== "undefined" ? `pi (${navigator.platform || "unknown"})` : "pi";
		const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
			method: "GET",
			headers: {
				Accept: "*/*",
				Authorization: `Bearer ${token}`,
				"chatgpt-account-id": accountId,
				originator: "pi",
				"User-Agent": userAgent,
			},
			signal: AbortSignal.timeout(10000),
		});
		if (!response.ok) return null;
		return normalizeCodexUsage((await response.json()) as CodexUsageResponse);
	} catch {
		return null;
	}
}

async function buildUsageSummary(info: BackupInfo): Promise<string | null> {
	const auth = await readBackup(info.name);
	const parts: string[] = [];
	if (isOAuthEntry(auth["anthropic"])) {
		parts.push(formatProviderUsage("anthropic", await fetchAnthropicUsage(getAnthropicToken(auth) ?? "")));
	}
	if (isOAuthEntry(auth["openai-codex"])) {
		parts.push(formatProviderUsage("codex", await fetchCodexUsage(getCodexToken(auth) ?? "")));
	}
	return parts.length > 0 ? parts.join("  ·  ") : null;
}

async function ensureBackupDir(): Promise<void> {
	await mkdir(BACKUP_DIR, { recursive: true });
	try {
		await chmod(join(homedir(), ".pi", "agent"), 0o700);
	} catch {}
	try {
		await chmod(BACKUP_DIR, 0o700);
	} catch {}
}

async function readJsonFile(path: string, missingValue: AuthFile): Promise<AuthFile> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`Expected JSON object in ${path}`);
		}
		return parsed as AuthFile;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return missingValue;
		throw error;
	}
}

async function writeJsonAtomic(path: string, data: AuthFile): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
	const content = `${JSON.stringify(data, null, 2)}\n`;
	await writeFile(tempPath, content, { mode: 0o600 });
	await rename(tempPath, path);
	try {
		await chmod(path, 0o600);
	} catch {}
}

async function readCurrentAuth(): Promise<AuthFile> {
	return readJsonFile(AUTH_FILE, {});
}

async function readBackup(name: string): Promise<AuthFile> {
	return readJsonFile(backupPath(name), {});
}

async function backupExists(name: string): Promise<boolean> {
	try {
		await access(backupPath(name), fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function listBackups(): Promise<BackupInfo[]> {
	await ensureBackupDir();
	const entries = await readdir(BACKUP_DIR, { withFileTypes: true });
	const infos = await Promise.all(
		entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
			.map(async (entry) => {
				const path = join(BACKUP_DIR, entry.name);
				const [data, fileStat] = await Promise.all([readJsonFile(path, {}), stat(path)]);
				return {
					name: basename(entry.name, ".json"),
					path,
					createdAtMs: fileStat.birthtimeMs || fileStat.mtimeMs,
					mtimeMs: fileStat.mtimeMs,
					providers: summarizeProviders(data),
				} satisfies BackupInfo;
			}),
	);
	return infos.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function backupAuth(name: string, overwrite: boolean): Promise<void> {
	await ensureBackupDir();
	if (!overwrite && (await backupExists(name))) {
		throw new Error(`Auth backup already exists: ${name}`);
	}
	const auth = await readCurrentAuth();
	await writeJsonAtomic(backupPath(name), auth);
}

async function restoreBackup(name: string): Promise<void> {
	const backup = await readBackup(name);
	if (!(await backupExists(name))) {
		throw new Error(`Auth backup not found: ${name}`);
	}
	await writeJsonAtomic(AUTH_FILE, backup);
}

async function deleteBackup(name: string): Promise<void> {
	if (!(await backupExists(name))) {
		throw new Error(`Auth backup not found: ${name}`);
	}
	await rm(backupPath(name));
}

function validateName(name: string | null): string {
	if (!name) throw new Error("Auth backup name required");
	if (!isValidBackupName(name)) {
		throw new Error(`Invalid auth backup name: ${name}. Use only letters, numbers, dot, underscore, and hyphen.`);
	}
	return name;
}

function sendOutput(pi: ExtensionAPI, title: string, lines: string[]): void {
	pi.sendMessage({
		customType: MESSAGE_TYPE,
		content: [title, ...lines].join("\n"),
		display: true,
	});
}

function requireInteractive(ctx: { hasUI: boolean }): void {
	if (!ctx.hasUI) throw new Error("This command requires interactive UI.");
}

function toSelectItem(backup: BackupInfo, usageSummary?: string): SelectItem {
	return {
		label: backup.name,
		value: backup.name,
		description: buildBackupDescription(backup, usageSummary),
	};
}

async function promptForNewBackupName(ctx: { ui: { input(title: string, placeholder?: string): Promise<string | undefined> } }): Promise<string> {
	const name = validateName((await ctx.ui.input("New auth backup name:", "auth-backup-name"))?.trim() ?? null);
	if (await backupExists(name)) {
		throw new Error(`Auth backup already exists: ${name}`);
	}
	return name;
}

async function showSelectList(
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

function createSelectList(items: SelectItem[], theme: { fg(name: string, text: string): string }, done: (value: string | null) => void): SelectList {
	const selectList = new SelectList(
		items,
		Math.min(items.length, 10),
		{
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
		{
			minPrimaryColumnWidth: 28,
			maxPrimaryColumnWidth: 28,
		},
	);
	selectList.onSelect = (item) => done(item.value);
	selectList.onCancel = () => done(null);
	return selectList;
}

async function selectBackupTarget(
	ctx: {
		ui: {
			custom<T>(factory: (tui: any, theme: any, keybindings: any, done: (value: T) => void) => any): Promise<T>;
			input(title: string, placeholder?: string): Promise<string | undefined>;
			confirm(title: string, message: string): Promise<boolean>;
		};
	},
): Promise<{ kind: "new" } | { kind: "existing"; name: string } | null> {
	const backups = await listBackups();
	const buildItems = (): SelectItem[] => [
		{ label: "+ New auth backup", value: NEW_BACKUP_VALUE, description: "Create a new named auth backup from current auth.json" },
		...backups.map((backup) => toSelectItem(backup, getFreshUsageSummary(backup.name))),
	];
	const selected = await showSelectList(ctx, "Auth backups:", buildItems(), (updateItems) => {
		for (const backup of backups) {
			if (getFreshUsageSummary(backup.name)) continue;
			void buildUsageSummary(backup).then((usageSummary) => {
				if (usageSummary) {
					latestUsageByBackupName.set(backup.name, { summary: usageSummary, fetchedAt: Date.now() });
				}
				updateItems(buildItems());
			});
		}
	});
	if (!selected) return null;
	if (selected === NEW_BACKUP_VALUE) return { kind: "new" };
	return { kind: "existing", name: selected };
}

async function selectBackupAction(
	ctx: { ui: { custom<T>(factory: (tui: any, theme: any, keybindings: any, done: (value: T) => void) => any): Promise<T> } },
	backup: BackupInfo,
): Promise<string | null> {
	return showSelectList(ctx, `Auth backup: ${backup.name}`, [
		{ label: "Backup current auth here", value: ACTION_BACKUP_HERE, description: "Overwrite this auth backup with current auth.json" },
		{ label: "Restore this backup", value: ACTION_RESTORE, description: "Restore this auth backup into ~/.pi/agent/auth.json and reload extensions" },
		{ label: "Delete this backup", value: ACTION_DELETE, description: "Delete this auth backup" },
		{ label: "Cancel", value: ACTION_CANCEL, description: "Close without changes" },
	]);
}

async function getBackupInfo(name: string): Promise<BackupInfo> {
	const backups = await listBackups();
	const backup = backups.find((entry) => entry.name === name);
	if (!backup) throw new Error(`Auth backup not found: ${name}`);
	return backup;
}

function getBackupConfirmMessage(info: BackupInfo): string {
	return buildBackupConfirmMessage(info, getFreshUsageSummary(info.name));
}

export default function (pi: ExtensionAPI) {
	pi.registerMessageRenderer(MESSAGE_TYPE, (message, _options, _theme) => new Text(message.content, 0, 0));

	pi.registerCommand("auth-backup", {
		description: "Manage auth backups",
		handler: async (_args, ctx) => {
			requireInteractive(ctx);

			for (;;) {
				const target = await selectBackupTarget(ctx);
				if (!target) return;

				if (target.kind === "new") {
					const name = await promptForNewBackupName(ctx);
					await backupAuth(name, false);
					ctx.ui.notify(`Backed up auth: ${name}`, "info");
					return;
				}

				const backup = await getBackupInfo(target.name);

				for (;;) {
					const action = await selectBackupAction(ctx, backup);
					if (!action) return;
					if (action === ACTION_CANCEL) break;

					if (action === ACTION_BACKUP_HERE) {
						const ok = await ctx.ui.confirm("Overwrite backup", getBackupConfirmMessage(backup));
						if (!ok) continue;
						await backupAuth(backup.name, true);
						ctx.ui.notify(`Backed up auth: ${backup.name}`, "info");
						return;
					}

					if (action === ACTION_RESTORE) {
						const ok = await ctx.ui.confirm("Restore backup", getBackupConfirmMessage(backup));
						if (!ok) continue;
						await ctx.waitForIdle();
						await restoreBackup(backup.name);
						ctx.modelRegistry.authStorage.reload();
						ctx.modelRegistry.refresh();
						ctx.ui.notify(`Restored auth backup: ${backup.name}`, "info");
						await ctx.reload();
						return;
					}

					if (action === ACTION_DELETE) {
						const ok = await ctx.ui.confirm("Delete backup", getBackupConfirmMessage(backup));
						if (!ok) continue;
						await deleteBackup(backup.name);
						ctx.ui.notify(`Deleted auth backup: ${backup.name}`, "info");
						return;
					}
				}
			}
		},
	});
}
