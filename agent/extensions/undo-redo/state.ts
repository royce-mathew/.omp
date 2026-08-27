import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import type { WorkspaceSnapshot } from "./git.ts";

export const CHECKPOINT_TYPE = "omp.undo-redo.checkpoint.v2";
export const CURSOR_TYPE = "omp.undo-redo.cursor.v2";
export const UNAVAILABLE_TYPE = "omp.undo-redo.unavailable.v2";
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

export interface TurnCheckpointV2 {
  version: 2;
  id: string;
  rootSessionId: string;
  userEntryId: string;
  sessionFile: string;
  sessionId: string;
  createdAt: string;
  workspaces: WorkspaceDelta[];
}

export type CursorEventV2 =
  | { version: 2; kind: "undo"; turnId: string; source: SessionPosition }
  | { version: 2; kind: "truncate" };

export interface RedoTarget {
  turn: TurnCheckpointV2;
  target: SessionPosition;
}
export interface ResolvedState {
  applied: TurnCheckpointV2[];
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

function isSnapshot(value: unknown): value is WorkspaceSnapshot {
  const snapshot = record(value);
  return !!snapshot &&
    typeof snapshot.repositoryRoot === "string" &&
    typeof snapshot.commonDir === "string" &&
    typeof snapshot.head === "string" &&
    typeof snapshot.indexTree === "string" &&
    typeof snapshot.worktreeTree === "string" &&
    typeof snapshot.refName === "string" &&
    Array.isArray(snapshot.scopes) &&
    snapshot.scopes.every((scope) => typeof scope === "string") &&
    Array.isArray(snapshot.excludedPaths) &&
    snapshot.excludedPaths.every((entry) => typeof entry === "string");
}

function validPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    !value.startsWith("/") && !value.split("/").includes("..");
}

export function isCheckpoint(value: unknown): value is TurnCheckpointV2 {
  const checkpoint = record(value);
  if (
    !checkpoint ||
    checkpoint.version !== 2 ||
    typeof checkpoint.id !== "string" ||
    typeof checkpoint.rootSessionId !== "string" ||
    typeof checkpoint.userEntryId !== "string" ||
    typeof checkpoint.sessionFile !== "string" ||
    typeof checkpoint.sessionId !== "string" ||
    typeof checkpoint.createdAt !== "string" ||
    !Array.isArray(checkpoint.workspaces)
  ) return false;
  return checkpoint.workspaces.every((value) => {
    const workspace = record(value);
    if (
      !workspace ||
      typeof workspace.repositoryRoot !== "string" ||
      typeof workspace.commonDir !== "string" ||
      !isSnapshot(workspace.before) ||
      !isSnapshot(workspace.after) ||
      !Array.isArray(workspace.changedPaths) ||
      !workspace.changedPaths.every(validPath)
    ) return false;
    const scopes = (workspace.after as WorkspaceSnapshot).scopes;
    return workspace.changedPaths.every(
      (changedPath) =>
        scopes.some(
          (scope) =>
            scope === "." || changedPath === scope || changedPath.startsWith(`${scope}/`),
        ),
    );
  });
}

export function isCursorEvent(value: unknown): value is CursorEventV2 {
  const cursor = record(value);
  if (!cursor || cursor.version !== 2 || typeof cursor.kind !== "string") return false;
  if (cursor.kind === "truncate") return Object.keys(cursor).every((key) =>
    ["version", "kind"].includes(key));
  const source = record(cursor.source);
  return cursor.kind === "undo" && typeof cursor.turnId === "string" &&
    !!source && typeof source.sessionFile === "string" &&
    (typeof source.leafId === "string" || source.leafId === null);
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

function updateHeads(state: ResolvedState, turn: TurnCheckpointV2): void {
  for (const workspace of turn.workspaces) {
    state.expectedHeads.set(workspace.commonDir, workspace.after.head);
  }
}

function appendCheckpoint(state: ResolvedState, turn: TurnCheckpointV2): void {
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
