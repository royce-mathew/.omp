import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
  resolveWorkspace,
  type WorkspaceSnapshot,
  WorkspaceHistory,
} from "./git.ts";

const TURN_TYPE = "omp.undo-redo.turn";
const STATE_TYPE = "omp.undo-redo.state";
const SCOPE_WARNING =
  "Ignored files, Git commits, external side effects, and subagent worktrees are not reverted.";
const DATA_DIR = path.join(import.meta.dir, ".data");

export interface UndoRedoTurn {
  version: 1;
  id: string;
  userEntryId: string;
  sourceSessionFile: string;
  sourceSessionId: string;
  before: WorkspaceSnapshot[];
  after: WorkspaceSnapshot[];
}

export interface UndoRedoState {
  version: 1;
  undo: UndoRedoTurn[];
  redo: UndoRedoTurn[];
}

interface PendingTurn {
  id: string;
  startLeafId: string | null;
  sourceSessionFile: string;
  sourceSessionId: string;
  before: WorkspaceSnapshot[];
}

function isSnapshot(value: unknown): value is WorkspaceSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  return (
    typeof snapshot.repositoryRoot === "string" &&
    typeof snapshot.commonDir === "string" &&
    typeof snapshot.head === "string" &&
    typeof snapshot.indexTree === "string" &&
    typeof snapshot.worktreeTree === "string" &&
    typeof snapshot.refName === "string"
  );
}

function sameRoots(
  left: readonly WorkspaceSnapshot[],
  right: readonly WorkspaceSnapshot[],
): boolean {
  if (left.length !== right.length) return false;
  const rightRoots = new Set(right.map((snapshot) => snapshot.repositoryRoot));
  return left.every((snapshot) => rightRoots.has(snapshot.repositoryRoot));
}

function isTurn(value: unknown): value is UndoRedoTurn {
  if (!value || typeof value !== "object") return false;
  const turn = value as Record<string, unknown>;
  if (
    turn.version !== 1 ||
    typeof turn.id !== "string" ||
    typeof turn.userEntryId !== "string" ||
    typeof turn.sourceSessionFile !== "string" ||
    typeof turn.sourceSessionId !== "string" ||
    !Array.isArray(turn.before) ||
    !turn.before.every(isSnapshot) ||
    !Array.isArray(turn.after) ||
    !turn.after.every(isSnapshot)
  ) {
    return false;
  }
  const before = turn.before as WorkspaceSnapshot[];
  const after = turn.after as WorkspaceSnapshot[];
  return (
    sameRoots(before, after) &&
    before.every((snapshot) =>
      after.some(
        (candidate) =>
          candidate.repositoryRoot === snapshot.repositoryRoot &&
          candidate.head === snapshot.head,
      ),
    )
  );
}

function isState(value: unknown): value is UndoRedoState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    state.version === 1 &&
    Array.isArray(state.undo) &&
    state.undo.every(isTurn) &&
    Array.isArray(state.redo) &&
    state.redo.every(isTurn)
  );
}

export function reconstructState(
  entries: readonly SessionEntry[],
): UndoRedoState {
  let state: UndoRedoState = { version: 1, undo: [], redo: [] };
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === TURN_TYPE && isTurn(entry.data)) {
      state = { version: 1, undo: [...state.undo, entry.data], redo: [] };
    } else if (entry.customType === STATE_TYPE && isState(entry.data)) {
      state = {
        version: 1,
        undo: [...entry.data.undo],
        redo: [...entry.data.redo],
      };
    }
  }
  return state;
}

function roots(ctx: ExtensionContext): string[] {
  const header = ctx.sessionManager.getHeader();
  return [
    ctx.sessionManager.getCwd(),
    ...(header?.additionalDirectories ?? []),
  ];
}

function messageRecord(
  entry: SessionEntry,
): Record<string, unknown> | undefined {
  if (
    entry.type !== "message" ||
    !entry.message ||
    typeof entry.message !== "object"
  )
    return undefined;
  return entry.message as unknown as Record<string, unknown>;
}

function isUserEntry(entry: SessionEntry): boolean {
  const message = messageRecord(entry);
  if (!message) return false;
  return (
    message.role === "user" ||
    (message.role === "custom" &&
      message.customType === "skill-prompt" &&
      message.attribution === "user")
  );
}

function completedAssistantAfter(
  entries: readonly SessionEntry[],
  userIndex: number,
): boolean {
  for (let index = entries.length - 1; index > userIndex; index--) {
    const message = messageRecord(entries[index]);
    if (message?.role !== "assistant") continue;
    return message.stopReason !== "aborted" && message.stopReason !== "error";
  }
  return false;
}

function entriesAfterLeaf(
  entries: readonly SessionEntry[],
  leafId: string | null,
): SessionEntry[] {
  if (!leafId) return [...entries];
  const index = entries.findIndex((entry) => entry.id === leafId);
  return index < 0 ? [] : entries.slice(index + 1);
}

function liveSubagentExists(): boolean {
  return AgentRegistry.global()
    .list()
    .some(
      (ref) =>
        ref.kind === "sub" && ref.session !== null && ref.status !== "aborted",
    );
}

async function validateWorkspace(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: UndoRedoState,
): Promise<string | undefined> {
  const resolved = await resolveWorkspace(pi, roots(ctx));
  if (!resolved.ok) return resolved.message;
  const expected = [...state.undo, ...state.redo].at(-1)?.before;
  if (!expected) return undefined;
  const current = new Set(
    resolved.repositories.map((repository) => repository.repositoryRoot),
  );
  if (
    expected.length !== current.size ||
    expected.some((snapshot) => !current.has(snapshot.repositoryRoot))
  ) {
    return "Configured workspace roots changed since the undo point was recorded.";
  }
  return undefined;
}

function notifyFailure(
  ctx: ExtensionCommandContext,
  message: string,
  error = false,
): void {
  ctx.ui.notify(message, error ? "error" : "warning");
}

export function createUndoRedoExtension(
  pi: ExtensionAPI,
  dataDir = DATA_DIR,
): void {
  const workspace = new WorkspaceHistory(pi, dataDir);
  let rootSessionId = "";
  let pending: PendingTurn | undefined;
  let unavailableMessage: string | undefined;

  const discardPending = async (): Promise<void> => {
    const abandoned = pending;
    pending = undefined;
    if (abandoned) await workspace.deleteRefs(abandoned.before).catch(() => {});
  };

  const initialize = (ctx: ExtensionContext): void => {
    rootSessionId ||= ctx.sessionManager.getSessionId();
    pending = undefined;
    unavailableMessage = undefined;
  };

  pi.on("session_start", (_event, ctx) => initialize(ctx));
  pi.on("session_switch", (_event, ctx) => initialize(ctx));
  pi.on("session_branch", (_event, ctx) => initialize(ctx));
  pi.on("session_tree", (_event, ctx) => initialize(ctx));
  pi.on("session_shutdown", async () => discardPending());

  pi.on("before_agent_start", async (_event, ctx) => {
    if (ctx.mode !== "tui" || pending) return;
    const sourceSessionFile = ctx.sessionManager.getSessionFile();
    if (!sourceSessionFile) return;
    const state = reconstructState(ctx.sessionManager.getBranch());
    if (state.redo.length > 0)
      pi.appendEntry(STATE_TYPE, {
        version: 1,
        undo: state.undo,
        redo: [],
      } satisfies UndoRedoState);
    const id = crypto.randomUUID();
    try {
      const before = await workspace.capture(
        roots(ctx),
        rootSessionId || ctx.sessionManager.getSessionId(),
        id,
        "before",
      );
      pending = {
        id,
        startLeafId: ctx.sessionManager.getLeafId(),
        sourceSessionFile,
        sourceSessionId: ctx.sessionManager.getSessionId(),
        before,
      };
      unavailableMessage = undefined;
    } catch (error) {
      unavailableMessage =
        error instanceof Error ? error.message : String(error);
      pi.logger.warn("Undo snapshot capture failed", {
        error: unavailableMessage,
      });
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!pending || event.willContinue) return;
    const active = pending;
    const branch = ctx.sessionManager.getBranch();
    const added = entriesAfterLeaf(branch, active.startLeafId);
    const userOffset = added.findIndex(isUserEntry);
    if (userOffset < 0 || !completedAssistantAfter(added, userOffset)) {
      await discardPending();
      return;
    }
    const userEntry = added[userOffset];
    pending = undefined;
    let after: WorkspaceSnapshot[] = [];
    try {
      after = await workspace.capture(
        roots(ctx),
        rootSessionId || active.sourceSessionId,
        active.id,
        "after",
      );
      if (!sameRoots(active.before, after))
        throw new Error("Workspace roots changed during the user turn.");
      if (
        active.before.some(
          (before) =>
            after.find((candidate) => candidate.commonDir === before.commonDir)
              ?.head !== before.head,
        )
      ) {
        throw new Error("Git HEAD changed during the user turn.");
      }
      const turn: UndoRedoTurn = {
        version: 1,
        id: active.id,
        userEntryId: userEntry.id,
        sourceSessionFile: active.sourceSessionFile,
        sourceSessionId: active.sourceSessionId,
        before: active.before,
        after,
      };
      pi.appendEntry(TURN_TYPE, turn);
      unavailableMessage = undefined;
    } catch (error) {
      await workspace.deleteRefs([...active.before, ...after]).catch(() => {});
      unavailableMessage =
        error instanceof Error ? error.message : String(error);
      pi.logger.warn("Undo turn was not recorded", {
        error: unavailableMessage,
      });
    }
  });

  const runUndo = async (ctx: ExtensionCommandContext): Promise<void> => {
    const draft = ctx.ui.getEditorText();
    ctx.ui.setEditorText("");
    if (ctx.mode !== "tui") {
      ctx.ui.setEditorText(draft);
      notifyFailure(
        ctx,
        "Undo is available only in an interactive root session.",
      );
      return;
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages() || liveSubagentExists()) {
      ctx.ui.setEditorText(draft);
      notifyFailure(
        ctx,
        "Cannot undo while the session or a subagent is busy.",
      );
      return;
    }

    const state = reconstructState(ctx.sessionManager.getBranch());
    const workspaceError = await validateWorkspace(pi, ctx, state);
    if (workspaceError) {
      ctx.ui.setEditorText(draft);
      notifyFailure(ctx, workspaceError);
      return;
    }
    const record = state.undo.at(-1);
    if (!record) {
      ctx.ui.setEditorText(draft);
      notifyFailure(
        ctx,
        unavailableMessage ?? "There is no user turn to undo.",
      );
      return;
    }
    if (
      !(await Bun.file(record.sourceSessionFile).exists()) ||
      !(await workspace.available([...record.before, ...record.after]))
    ) {
      ctx.ui.setEditorText(draft);
      notifyFailure(
        ctx,
        "The persisted session or a private workspace snapshot for this turn is missing.",
      );
      return;
    }
    const match = await workspace.matchAll(record.after);
    if (!match.matches) {
      ctx.ui.setEditorText(draft);
      notifyFailure(
        ctx,
        `Workspace changed after this turn:\n${match.paths.join("\n")}`,
      );
      return;
    }

    const originalSessionFile = ctx.sessionManager.getSessionFile();
    const entry = ctx.sessionManager.getEntry(record.userEntryId);
    if (!originalSessionFile || !entry || !isUserEntry(entry)) {
      ctx.ui.setEditorText(draft);
      notifyFailure(
        ctx,
        "The transcript boundary for this undo point is missing.",
      );
      return;
    }

    let transitioned = false;
    try {
      const baseUndo = state.undo.slice(0, -1);
      const stateForBranch = (
        branchFile: string,
        branchSessionId: string,
      ): UndoRedoState => {
        const undo = [...baseUndo];
        const previous = undo.at(-1);
        if (previous) {
          undo[undo.length - 1] = {
            ...previous,
            sourceSessionFile: branchFile,
            sourceSessionId: branchSessionId,
          };
        }
        return { version: 1, undo, redo: [...state.redo, record] };
      };

      if (!entry.parentId) {
        const result = await ctx.newSession({
          parentSession: originalSessionFile,
          setup: async (sessionManager) => {
            const branchFile = sessionManager.getSessionFile();
            if (!branchFile) throw new Error("Undo branch was not persisted.");
            sessionManager.appendCustomEntry(
              STATE_TYPE,
              stateForBranch(branchFile, sessionManager.getSessionId()),
            );
            await sessionManager.ensureOnDisk();
          },
        });
        if (result.cancelled)
          throw new Error("Session transition was cancelled.");
      } else {
        const result =
          messageRecord(entry)?.role === "user"
            ? await ctx.branch(record.userEntryId)
            : await ctx.navigateTree(entry.parentId, { summarize: false });
        if (result.cancelled)
          throw new Error("Session branching was cancelled.");
        const branchFile = ctx.sessionManager.getSessionFile();
        if (!branchFile) throw new Error("Undo branch was not persisted.");
        pi.appendEntry(
          STATE_TYPE,
          stateForBranch(branchFile, ctx.sessionManager.getSessionId()),
        );
      }
      transitioned = true;
      await workspace.restoreAll(record.before);
      await ctx.reload();
      ctx.ui.notify("Undid last user turn and restored workspace.", "info");
      ctx.ui.notify(SCOPE_WARNING, "warning");
    } catch (error) {
      await workspace
        .restoreAll(record.after)
        .catch((compensation) =>
          pi.logger.error("Undo workspace compensation failed", {
            error: String(compensation),
          }),
        );
      if (transitioned) {
        await ctx
          .switchSession(originalSessionFile)
          .catch((compensation) =>
            pi.logger.error("Undo transcript compensation failed", {
              error: String(compensation),
            }),
          );
      }
      ctx.ui.setEditorText(draft);
      notifyFailure(
        ctx,
        `Failed to undo last user turn: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  };

  const runRedo = async (ctx: ExtensionCommandContext): Promise<void> => {
    const draft = ctx.ui.getEditorText();
    ctx.ui.setEditorText("");
    if (ctx.mode !== "tui") {
      ctx.ui.setEditorText(draft);
      notifyFailure(
        ctx,
        "Redo is available only in an interactive root session.",
      );
      return;
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages() || liveSubagentExists()) {
      ctx.ui.setEditorText(draft);
      notifyFailure(
        ctx,
        "Cannot redo while the session or a subagent is busy.",
      );
      return;
    }

    const state = reconstructState(ctx.sessionManager.getBranch());
    const workspaceError = await validateWorkspace(pi, ctx, state);
    if (workspaceError) {
      ctx.ui.setEditorText(draft);
      notifyFailure(ctx, workspaceError);
      return;
    }
    const record = state.redo.at(-1);
    if (!record) {
      ctx.ui.setEditorText(draft);
      notifyFailure(ctx, "There is no user turn to redo.");
      return;
    }
    if (
      !(await Bun.file(record.sourceSessionFile).exists()) ||
      !(await workspace.available([...record.before, ...record.after]))
    ) {
      ctx.ui.setEditorText(draft);
      notifyFailure(
        ctx,
        "The persisted session or a private workspace snapshot for this turn is missing.",
      );
      return;
    }
    const match = await workspace.matchAll(record.before);
    if (!match.matches) {
      ctx.ui.setEditorText(draft);
      notifyFailure(
        ctx,
        `Workspace changed after undo:\n${match.paths.join("\n")}`,
      );
      return;
    }

    const originalSessionFile = ctx.sessionManager.getSessionFile();
    if (!originalSessionFile) {
      ctx.ui.setEditorText(draft);
      notifyFailure(ctx, "The active session is not persisted.");
      return;
    }
    let transitioned = false;
    try {
      const result = await ctx.switchSession(record.sourceSessionFile);
      if (result.cancelled)
        throw new Error("Source session switch was cancelled.");
      transitioned = true;
      await workspace.restoreAll(record.after);
      await ctx.reload();
      ctx.ui.notify("Redid user turn and restored workspace.", "info");
      ctx.ui.notify(SCOPE_WARNING, "warning");
    } catch (error) {
      await workspace
        .restoreAll(record.before)
        .catch((compensation) =>
          pi.logger.error("Redo workspace compensation failed", {
            error: String(compensation),
          }),
        );
      if (transitioned) {
        await ctx
          .switchSession(originalSessionFile)
          .catch((compensation) =>
            pi.logger.error("Redo transcript compensation failed", {
              error: String(compensation),
            }),
          );
      }
      ctx.ui.setEditorText(draft);
      notifyFailure(
        ctx,
        `Failed to redo user turn: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  };

  pi.registerCommand("undo", {
    description: "Undo last user turn and workspace changes",
    handler: (_args, ctx) => runUndo(ctx),
  });
  pi.registerCommand("redo", {
    description: "Redo last undone user turn and workspace changes",
    handler: (_args, ctx) => runRedo(ctx),
  });
}

export default function undoRedoExtension(pi: ExtensionAPI): void {
  createUndoRedoExtension(pi);
}
