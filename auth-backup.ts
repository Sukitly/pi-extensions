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

const NEW_BACKUP_VALUE = "__new__";
const ACTION_BACKUP_HERE = "__action_backup_here__";
const ACTION_RESTORE = "__action_restore__";
const ACTION_DELETE = "__action_delete__";
const ACTION_CANCEL = "__action_cancel__";

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

function buildBackupDescription(info: BackupInfo): string {
	return `created ${formatTimestamp(info.createdAtMs)}  ·  ${formatProviders(info.providers)}`;
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

function toSelectItem(backup: BackupInfo): SelectItem {
	return {
		label: backup.name,
		value: backup.name,
		description: buildBackupDescription(backup),
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
): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title))));

		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")));
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));

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
	const options: SelectItem[] = [
		{ label: "+ New auth backup", value: NEW_BACKUP_VALUE, description: "Create a new named auth backup from current auth.json" },
		...backups.map(toSelectItem),
	];
	const selected = await showSelectList(ctx, "Auth backups:", options);
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
		{ label: "Restore this backup", value: ACTION_RESTORE, description: "Restore this auth backup into ~/.pi/agent/auth.json and reload" },
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

export default function (pi: ExtensionAPI) {
	pi.registerMessageRenderer(MESSAGE_TYPE, (message, _options, _theme) => new Text(message.content, 0, 0));

	pi.registerCommand("auth-backup", {
		description: "Manage auth backups",
		handler: async (_args, ctx) => {
			requireInteractive(ctx);
			const target = await selectBackupTarget(ctx);
			if (!target) return;

			if (target.kind === "new") {
				const name = await promptForNewBackupName(ctx);
				await backupAuth(name, false);
				ctx.ui.notify(`Backed up auth: ${name}`, "info");
				return;
			}

			const backup = await getBackupInfo(target.name);
			const action = await selectBackupAction(ctx, backup);
			if (!action || action === ACTION_CANCEL) return;

			if (action === ACTION_BACKUP_HERE) {
				const ok = await ctx.ui.confirm("Overwrite auth backup?", `Overwrite auth backup '${backup.name}'?`);
				if (!ok) return;
				await backupAuth(backup.name, true);
				ctx.ui.notify(`Backed up auth: ${backup.name}`, "info");
				return;
			}

			if (action === ACTION_RESTORE) {
				const ok = await ctx.ui.confirm("Restore auth backup?", `Restore auth backup '${backup.name}' into ~/.pi/agent/auth.json and reload?`);
				if (!ok) return;
				await ctx.waitForIdle();
				await restoreBackup(backup.name);
				ctx.ui.notify(`Restored auth backup: ${backup.name}`, "info");
				await ctx.reload();
				return;
			}

			if (action === ACTION_DELETE) {
				const ok = await ctx.ui.confirm("Delete auth backup?", `Delete auth backup '${backup.name}'?`);
				if (!ok) return;
				await deleteBackup(backup.name);
				ctx.ui.notify(`Deleted auth backup: ${backup.name}`, "info");
			}
		},
	});
}
