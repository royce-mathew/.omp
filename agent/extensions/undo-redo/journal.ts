import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkspaceDelta, SessionPosition } from "./state.ts";
import type { WorkspaceSnapshot } from "./git.ts";

export interface TransitionJournal {
  version: 1;
  direction: "undo" | "redo";
  turnId: string;
  original: SessionPosition;
  target: SessionPosition | null;
  rollback: WorkspaceSnapshot[];
  workspaces: WorkspaceDelta[];
  phase: "prepared" | "transcript-moved" | "workspace-restored";
}

function journalPath(dataDir: string, rootSessionId: string): string {
  return path.join(dataDir, "transactions", `${Bun.hash.wyhash(rootSessionId).toString(16)}.json`);
}

function isPosition(value: unknown): value is SessionPosition {
  return !!value && typeof value === "object" &&
    typeof (value as Record<string, unknown>).sessionFile === "string" &&
    (typeof (value as Record<string, unknown>).leafId === "string" ||
      (value as Record<string, unknown>).leafId === null);
}

function isJournal(value: unknown): value is TransitionJournal {
  if (!value || typeof value !== "object") return false;
  const journal = value as Record<string, unknown>;
  return (
    journal.version === 1 &&
    (journal.direction === "undo" || journal.direction === "redo") &&
    typeof journal.turnId === "string" &&
    isPosition(journal.original) &&
    (journal.target === null || isPosition(journal.target)) &&
    Array.isArray(journal.rollback) &&
    Array.isArray(journal.workspaces) &&
    (journal.phase === "prepared" ||
      journal.phase === "transcript-moved" ||
      journal.phase === "workspace-restored")
  );
}

export async function readJournal(
  dataDir: string,
  rootSessionId: string,
): Promise<TransitionJournal | undefined> {
  try {
    const journal = JSON.parse(
      await Bun.file(journalPath(dataDir, rootSessionId)).text(),
    );
    if (!isJournal(journal)) throw new Error("Undo transaction journal is malformed.");
    return journal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Undo transaction journal is unreadable: ${String(error)}`);
  }
}

export async function writeJournal(
  dataDir: string,
  rootSessionId: string,
  journal: TransitionJournal,
): Promise<void> {
  const destination = journalPath(dataDir, rootSessionId);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temporary, JSON.stringify(journal));
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function clearJournal(dataDir: string, rootSessionId: string): Promise<void> {
  await fs.rm(journalPath(dataDir, rootSessionId), { force: true });
}
