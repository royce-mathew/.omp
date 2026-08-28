import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import type { WorkspaceSnapshot } from "./git.ts";

export const CHECKPOINT_TYPE = "omp.undo-redo.checkpoint";
export const CURSOR_TYPE = "omp.undo-redo.cursor";
export const UNAVAILABLE_TYPE = "omp.undo-redo.unavailable";
export const RECONSTRUCTION_DEPTH_LIMIT = 128;

export interface SessionPosition {
  sessionFile: string;
  leafId: string | null;
}

export interface WorkspaceDelta {
  repositoryRoot: string;
  commonDir: string;
  before: WorkspaceSnapshot;
  after: WorkspaceSnapshot;
  changedPaths: string[];
}

export interface TurnCheckpoint {
  id: string;
  rootSessionId: string;
  userEntryId: string;
  sessionFile: string;
  sessionId: string;
  createdAt: string;
  workspaces: WorkspaceDelta[];
}

export type CursorEvent =
  | { kind: "undo"; turnId: string; source: SessionPosition }
  | { kind: "truncate" };

export interface RedoTarget {
  turn: TurnCheckpoint;
  target: SessionPosition;
}
export interface ResolvedState {
  applied: TurnCheckpoint[];
  redo: RedoTarget[];
  expectedHeads: Map<string, string>;
  barrier: boolean;
}

export class StateReconstructionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateReconstructionError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key)) &&
    keys.every((key) => key in value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function validPath(value: unknown): value is string {
  return nonEmptyString(value) &&
    value !== "." &&
    !value.startsWith("/") &&
    !value.split("/").includes("..");
}

function validScope(value: unknown): value is string {
  return value === "." || validPath(value);
}

function validSnapshotRef(value: unknown): value is string {
  return nonEmptyString(value) &&
    value.startsWith("refs/omp/undo/") &&
    !value.includes("..") &&
    !value.endsWith("/") &&
    /^refs\/[A-Za-z0-9._/-]+$/.test(value);
}

function containedByScope(relativePath: string, scopes: readonly string[]): boolean {
  return scopes.some(
    (scope) =>
      scope === "." || relativePath === scope || relativePath.startsWith(`${scope}/`),
  );
}

function stringList(
  value: unknown,
  validElement: (entry: unknown) => entry is string,
): value is string[] {
  return Array.isArray(value) && value.every(validElement);
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function uniquePaths(paths: readonly string[]): boolean {
  return new Set(paths).size === paths.length;
}

export function workspaceIdentity(
  workspace: Pick<WorkspaceDelta, "repositoryRoot" | "commonDir">,
): string {
  return `${workspace.repositoryRoot}\0${workspace.commonDir}`;
}

export function isWorkspaceSnapshot(value: unknown): value is WorkspaceSnapshot {
  const snapshot = record(value);
  if (!snapshot) return false;
  const scopes = snapshot.scopes;
  const excludedPaths = snapshot.excludedPaths;
  if (
    !exactKeys(snapshot, [
      "repositoryRoot",
      "commonDir",
      "head",
      "indexTree",
      "worktreeTree",
      "refName",
      "scopes",
      "excludedPaths",
    ]) ||
    !nonEmptyString(snapshot.repositoryRoot) ||
    !nonEmptyString(snapshot.commonDir) ||
    !nonEmptyString(snapshot.head) ||
    !nonEmptyString(snapshot.indexTree) ||
    !nonEmptyString(snapshot.worktreeTree) ||
    !validSnapshotRef(snapshot.refName) ||
    !stringList(scopes, validScope) ||
    !uniquePaths(scopes) ||
    !stringList(excludedPaths, validPath) ||
    !uniquePaths(excludedPaths)
  ) return false;
  return excludedPaths.every((excludedPath) =>
    containedByScope(excludedPath, scopes));
}

export function isWorkspaceDelta(value: unknown): value is WorkspaceDelta {
  const workspace = record(value);
  if (
    !workspace ||
    !exactKeys(workspace, [
      "repositoryRoot",
      "commonDir",
      "before",
      "after",
      "changedPaths",
    ]) ||
    !nonEmptyString(workspace.repositoryRoot) ||
    !nonEmptyString(workspace.commonDir) ||
    !isWorkspaceSnapshot(workspace.before) ||
    !isWorkspaceSnapshot(workspace.after) ||
    !Array.isArray(workspace.changedPaths) ||
    !workspace.changedPaths.every(validPath) ||
    !uniquePaths(workspace.changedPaths)
  ) return false;
  const before = workspace.before;
  const after = workspace.after;
  if (
    before.repositoryRoot !== workspace.repositoryRoot ||
    before.commonDir !== workspace.commonDir ||
    after.repositoryRoot !== workspace.repositoryRoot ||
    after.commonDir !== workspace.commonDir ||
    !samePaths(before.scopes, after.scopes)
  ) return false;
  const excludedPaths = new Set([...before.excludedPaths, ...after.excludedPaths]);
  return workspace.changedPaths.every(
    (changedPath) =>
      !excludedPaths.has(changedPath) &&
      containedByScope(changedPath, after.scopes),
  );
}

export function isSessionPosition(value: unknown): value is SessionPosition {
  const position = record(value);
  return !!position &&
    exactKeys(position, ["sessionFile", "leafId"]) &&
    nonEmptyString(position.sessionFile) &&
    (nonEmptyString(position.leafId) || position.leafId === null);
}

export function isCheckpoint(value: unknown): value is TurnCheckpoint {
  const checkpoint = record(value);
  if (
    !checkpoint ||
    !exactKeys(checkpoint, [
      "id",
      "rootSessionId",
      "userEntryId",
      "sessionFile",
      "sessionId",
      "createdAt",
      "workspaces",
    ]) ||
    !nonEmptyString(checkpoint.id) ||
    !nonEmptyString(checkpoint.rootSessionId) ||
    !nonEmptyString(checkpoint.userEntryId) ||
    !nonEmptyString(checkpoint.sessionFile) ||
    !nonEmptyString(checkpoint.sessionId) ||
    !nonEmptyString(checkpoint.createdAt) ||
    !Number.isFinite(Date.parse(checkpoint.createdAt)) ||
    !Array.isArray(checkpoint.workspaces) ||
    !checkpoint.workspaces.every(isWorkspaceDelta)
  ) return false;
  const identities = checkpoint.workspaces.map(workspaceIdentity);
  return uniquePaths(identities);
}

export function isCursorEvent(value: unknown): value is CursorEvent {
  const cursor = record(value);
  if (!cursor || typeof cursor.kind !== "string") return false;
  if (cursor.kind === "truncate") {
    return exactKeys(cursor, ["kind"]);
  }
  return cursor.kind === "undo" &&
    exactKeys(cursor, ["kind", "turnId", "source"]) &&
    nonEmptyString(cursor.turnId) &&
    isSessionPosition(cursor.source);
}
function cloneState(state?: ResolvedState): ResolvedState {
  return state
    ? {
        applied: [...state.applied],
        redo: [...state.redo],
        expectedHeads: new Map(state.expectedHeads),
        barrier: state.barrier,
      }
    : { applied: [], redo: [], expectedHeads: new Map(), barrier: false };
}

function updateHeads(state: ResolvedState, turn: TurnCheckpoint): void {
  for (const workspace of turn.workspaces) {
    state.expectedHeads.set(workspaceIdentity(workspace), workspace.after.head);
  }
}

function appendCheckpoint(state: ResolvedState, turn: TurnCheckpoint): void {
  if (state.applied.some((candidate) => candidate.id === turn.id)) {
    throw new StateReconstructionError(`Duplicate undo checkpoint: ${turn.id}`);
  }
  state.applied.push(turn);
  state.redo = [];
  updateHeads(state, turn);
}

function entriesToLeaf(
  entries: readonly SessionEntry[],
  leafId: string | null,
): SessionEntry[] {
  if (leafId === null) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: SessionEntry[] = [];
  const seen = new Set<string>();
  let id: string | null = leafId;
  while (id !== null) {
    if (seen.has(id)) throw new StateReconstructionError("Session entry parent cycle.");
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) throw new StateReconstructionError(`Missing session leaf: ${id}`);
    branch.push(entry);
    id = entry.parentId;
  }
  return branch.reverse();
}

export type PositionLoader = (position: SessionPosition) => Promise<readonly SessionEntry[]>;

export async function loadPosition(position: SessionPosition): Promise<readonly SessionEntry[]> {
  if (!isSessionPosition(position)) {
    throw new StateReconstructionError("Malformed persisted session position.");
  }
  if (!(await Bun.file(position.sessionFile).exists())) {
    throw new StateReconstructionError(`Persisted session is missing: ${position.sessionFile}`);
  }
  const entries = await loadEntriesFromFile(position.sessionFile);
  return entriesToLeaf(entries as SessionEntry[], position.leafId);
}

export async function reconstructState(
  entries: readonly SessionEntry[],
  loader: PositionLoader = loadPosition,
): Promise<ResolvedState> {
  const cache = new Map<string, ResolvedState>();
  const resolving = new Set<string>();
  const resolve = async (
    branch: readonly SessionEntry[],
    depth: number,
    position?: SessionPosition,
  ): Promise<ResolvedState> => {
    if (depth > RECONSTRUCTION_DEPTH_LIMIT) {
      throw new StateReconstructionError("Undo history exceeds the reconstruction depth limit.");
    }
    const key = position ? `${position.sessionFile}\0${position.leafId ?? ""}` : undefined;
    if (key && cache.has(key)) return cloneState(cache.get(key));
    if (key && resolving.has(key)) throw new StateReconstructionError("Undo cursor cycle.");
    if (key) resolving.add(key);
    try {
      let state = cloneState();
      for (const entry of branch) {
        if (entry.type !== "custom") continue;
        if (entry.customType === CHECKPOINT_TYPE) {
          if (!isCheckpoint(entry.data)) throw new StateReconstructionError("Malformed undo checkpoint.");
          appendCheckpoint(state, entry.data);
          continue;
        }
        if (entry.customType === UNAVAILABLE_TYPE) {
          state = { applied: [], redo: [], expectedHeads: new Map(), barrier: true };
          continue;
        }
        if (entry.customType !== CURSOR_TYPE) continue;
        if (!isCursorEvent(entry.data)) throw new StateReconstructionError("Malformed undo cursor.");
        if (entry.data.kind === "truncate") {
          state.redo = [];
          continue;
        }
        const sourceEntries = await loader(entry.data.source);
        const sourceState = await resolve(sourceEntries, depth + 1, entry.data.source);
        const turn = sourceState.applied.at(-1);
        if (!turn || turn.id !== entry.data.turnId) {
          throw new StateReconstructionError("Undo cursor does not target the final applied turn.");
        }
        sourceState.applied.pop();
        sourceState.redo.push({ turn, target: entry.data.source });
        state = sourceState;
      }
      if (key) cache.set(key, cloneState(state));
      return state;
    } finally {
      if (key) resolving.delete(key);
    }
  };
  return resolve(entries, 0);
}
