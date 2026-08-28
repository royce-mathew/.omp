import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  isSessionPosition,
  isWorkspaceDelta,
  isWorkspaceSnapshot,
  workspaceIdentity,
  type WorkspaceDelta,
  type SessionPosition,
} from "./state.ts";
import type { WorkspaceSnapshot } from "./git.ts";

export interface TransitionJournal {
  rootSessionId: string;
  direction: "undo" | "redo";
  turnId: string;
  original: SessionPosition;
  target: SessionPosition | null;
  rollback: WorkspaceSnapshot[];
  workspaces: WorkspaceDelta[];
  phase: "prepared" | "transcript-moved" | "workspace-restored";
}

export interface StoredJournal {
  rootSessionId: string;
  journal: TransitionJournal;
}

function transactionsDir(dataDir: string): string {
  return path.join(dataDir, "transactions");
}

function journalName(rootSessionId: string): string {
  return `${Bun.hash.wyhash(rootSessionId).toString(16)}.json`;
}

function journalPath(dataDir: string, rootSessionId: string): string {
  return path.join(transactionsDir(dataDir), journalName(rootSessionId));
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function sameScopes(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length && left.every((scope, index) => scope === right[index]);
}

function hasOneToOneRepositories(
  rollback: readonly WorkspaceSnapshot[],
  workspaces: readonly WorkspaceDelta[],
): boolean {
  if (rollback.length !== workspaces.length) return false;
  const byIdentity = new Map<string, WorkspaceDelta>();
  for (const workspace of workspaces) {
    const identity = workspaceIdentity(workspace);
    if (byIdentity.has(identity)) return false;
    byIdentity.set(identity, workspace);
  }
  for (const snapshot of rollback) {
    const workspace = byIdentity.get(workspaceIdentity(snapshot));
    if (!workspace || !sameScopes(snapshot.scopes, workspace.before.scopes)) return false;
    byIdentity.delete(workspaceIdentity(snapshot));
  }
  return byIdentity.size === 0;
}

function isJournal(value: unknown): value is TransitionJournal {
  if (!value || typeof value !== "object") return false;
  const journal = value as Record<string, unknown>;
  if (
    Object.keys(journal).length !== 8 ||
    !Object.keys(journal).every((key) =>
      [
        "rootSessionId",
        "direction",
        "turnId",
        "original",
        "target",
        "rollback",
        "workspaces",
        "phase",
      ].includes(key)
    ) ||
    !validIdentifier(journal.rootSessionId) ||
    (journal.direction !== "undo" && journal.direction !== "redo") ||
    !validIdentifier(journal.turnId) ||
    !isSessionPosition(journal.original) ||
    (journal.target !== null && !isSessionPosition(journal.target)) ||
    !Array.isArray(journal.rollback) ||
    !journal.rollback.every(isWorkspaceSnapshot) ||
    !Array.isArray(journal.workspaces) ||
    !journal.workspaces.every(isWorkspaceDelta) ||
    (journal.phase !== "prepared" &&
      journal.phase !== "transcript-moved" &&
      journal.phase !== "workspace-restored")
  ) return false;
  return hasOneToOneRepositories(journal.rollback, journal.workspaces);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(
    directory,
    fsSync.constants.O_RDONLY | fsSync.constants.O_DIRECTORY,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureTransactionsDir(dataDir: string): Promise<string> {
  const directory = transactionsDir(dataDir);
  const created = await fs.mkdir(directory, { recursive: true });
  if (created) await syncDirectory(path.dirname(created));
  await syncDirectory(path.dirname(directory));
  await syncDirectory(directory);
  return directory;
}

async function readJournalFile(file: string): Promise<TransitionJournal> {
  const handle = await fs.open(file, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error("Undo transaction journal is not a regular file.");
    }
    const journal = JSON.parse(await handle.readFile({ encoding: "utf8" }));
    if (!isJournal(journal)) throw new Error("Undo transaction journal is malformed.");
    return journal;
  } finally {
    await handle.close();
  }
}

export async function readJournal(
  dataDir: string,
  rootSessionId: string,
): Promise<TransitionJournal | undefined> {
  if (!validIdentifier(rootSessionId)) {
    throw new Error("Undo transaction journal root session is malformed.");
  }
  try {
    const journal = await readJournalFile(journalPath(dataDir, rootSessionId));
    if (journal.rootSessionId !== rootSessionId) {
      throw new Error("Undo transaction journal belongs to a different root session.");
    }
    return journal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Undo transaction journal is unreadable: ${String(error)}`);
  }
}

export async function listJournals(dataDir: string): Promise<StoredJournal[]> {
  const directory = transactionsDir(dataDir);
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Undo transaction journals are unreadable: ${String(error)}`);
  }
  const journals: StoredJournal[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile()) {
      throw new Error(`Undo transaction journal is not a regular file: ${entry.name}`);
    }
    const journal = await readJournalFile(path.join(directory, entry.name));
    if (entry.name !== journalName(journal.rootSessionId)) {
      throw new Error(`Undo transaction journal has an invalid file name: ${entry.name}`);
    }
    journals.push({ rootSessionId: journal.rootSessionId, journal });
  }
  return journals;
}

export async function writeJournal(
  dataDir: string,
  rootSessionId: string,
  journal: TransitionJournal,
): Promise<void> {
  if (!isJournal(journal) || journal.rootSessionId !== rootSessionId) {
    throw new Error("Refusing to persist a malformed undo transaction journal.");
  }
  const directory = await ensureTransactionsDir(dataDir);
  const destination = journalPath(dataDir, rootSessionId);
  const temporary = path.join(directory, `.${journalName(rootSessionId)}.${crypto.randomUUID()}.tmp`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(
      temporary,
      fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL,
      0o600,
    );
    await handle.writeFile(JSON.stringify(journal));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, destination);
    await syncDirectory(directory);
  } finally {
    await handle?.close();
    await fs.rm(temporary, { force: true });
  }
}

export async function clearJournal(dataDir: string, rootSessionId: string): Promise<void> {
  if (!validIdentifier(rootSessionId)) {
    throw new Error("Undo transaction journal root session is malformed.");
  }
  const destination = journalPath(dataDir, rootSessionId);
  try {
    await fs.unlink(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await syncDirectory(path.dirname(destination));
}
