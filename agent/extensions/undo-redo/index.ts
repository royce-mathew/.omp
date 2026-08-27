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
import {
  clearJournal,
  readJournal,
  writeJournal,
  type TransitionJournal,
} from "./journal.ts";
import {
  CHECKPOINT_TYPE,
  CURSOR_TYPE,
  reconstructState,
  UNAVAILABLE_TYPE,
  type ResolvedState,
  type SessionPosition,
  type TurnCheckpointV2,
} from "./state.ts";

const SCOPE_WARNING =
  "Restored selected Git-visible paths only. Ignored files, commits, external side effects, and isolated subagent worktrees are unchanged.";
const DATA_DIR = path.join(import.meta.dir, ".data");

interface PendingTurn {
  id: string;
  startLeafId: string | null;
  sourceSessionFile: string;
  sourceSessionId: string;
  before: WorkspaceSnapshot[];
  truncatesRedo: boolean;
  unavailableReason?: string;
}

function roots(ctx: ExtensionContext): string[] {
  const header = ctx.sessionManager.getHeader();
  return [ctx.sessionManager.getCwd(), ...(header?.additionalDirectories ?? [])];
}

function messageRecord(entry: SessionEntry): Record<string, unknown> | undefined {
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") {
    return undefined;
  }
  return entry.message as unknown as Record<string, unknown>;
}

function isUserEntry(entry: SessionEntry): boolean {
  const message = messageRecord(entry);
  return !!message && (
    message.role === "user" ||
    (message.role === "custom" &&
      message.customType === "skill-prompt" &&
      message.attribution === "user")
  );
}

function entriesAfterLeaf(
  entries: readonly SessionEntry[],
  leafId: string | null,
): SessionEntry[] {
  if (!leafId) return [...entries];
  const index = entries.findIndex((entry) => entry.id === leafId);
  return index < 0 ? [] : entries.slice(index + 1);
}

function userText(entry: SessionEntry): { text: string; attachments: boolean } {
  const message = messageRecord(entry);
  const content = message?.content;
  if (typeof content === "string") return { text: content, attachments: false };
  if (!Array.isArray(content)) return { text: "", attachments: false };
  let text = "";
  let attachments = false;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const part = item as Record<string, unknown>;
    if (part.type === "text" && typeof part.text === "string") text += part.text;
    else attachments = true;
  }
  return { text, attachments };
}

function liveRelevantSubagent(ctx: ExtensionContext): boolean {
  const registry = AgentRegistry.global();
  const refs = registry.list();
  const root = refs.find(
    (ref) =>
      ref.kind !== "sub" &&
      ref.sessionFile === ctx.sessionManager.getSessionFile(),
  );
  if (!root) return false;
  const byId = new Map(refs.map((ref) => [ref.id, ref]));
  return refs.some((ref) => {
    if (ref.kind !== "sub" || !registry.isRunning(ref)) return false;
    const seen = new Set<string>();
    let parentId = ref.parentId;
    while (parentId) {
      if (seen.has(parentId)) return false;
      seen.add(parentId);
      if (parentId === root.id) return true;
      parentId = byId.get(parentId)?.parentId;
    }
    return false;
  });
}

function notifyFailure(
  ctx: ExtensionCommandContext,
  message: string,
  error = false,
): void {
  ctx.ui.notify(message, error ? "error" : "warning");
}

function allSnapshots(turn: TurnCheckpointV2): WorkspaceSnapshot[] {
  return turn.workspaces.flatMap((workspace) => [workspace.before, workspace.after]);
}

async function restoreRollback(
  workspace: WorkspaceHistory,
  rollback: readonly WorkspaceSnapshot[],
  turn: TurnCheckpointV2,
): Promise<void> {
  for (const delta of turn.workspaces) {
    const snapshot = rollback.find(
      (candidate) =>
        candidate.repositoryRoot === delta.repositoryRoot &&
        candidate.commonDir === delta.commonDir,
    );
    if (!snapshot) throw new Error(`Rollback snapshot is missing: ${delta.repositoryRoot}`);
    await workspace.restorePaths(snapshot, delta.changedPaths);
  }
}


export function createUndoRedoExtension(
  pi: ExtensionAPI,
  dataDir = DATA_DIR,
): void {
  const workspace = new WorkspaceHistory(pi, dataDir);
  let rootSessionId = "";
  let pending: PendingTurn | undefined;
  let unavailableMessage: string | undefined;
  let lastContext: ExtensionContext | undefined;
  const recoverJournal = async (
    ctx: ExtensionCommandContext,
  ): Promise<string | undefined> => {
    const lineage = rootSessionId || ctx.sessionManager.getSessionId();
    const journal = await readJournal(dataDir, lineage);
    if (!journal) return undefined;
    const expectedHeads = new Map(
      journal.workspaces.map((workspaceRecord) => [
        workspaceRecord.commonDir,
        workspaceRecord.after.head,
      ]),
    );
    const originalSide = journal.direction === "undo" ? "after" : "before";
    const targetSide = journal.direction === "undo" ? "before" : "after";
    const atOriginal =
      ctx.sessionManager.getSessionFile() === journal.original.sessionFile &&
      ctx.sessionManager.getLeafId() === journal.original.leafId;
    const atTarget =
      journal.target !== null &&
      ctx.sessionManager.getSessionFile() === journal.target.sessionFile &&
      ctx.sessionManager.getLeafId() === journal.target.leafId;
    const originalMatches = await workspace.matchAllPaths(
      journal.workspaces,
      originalSide,
      expectedHeads,
    );
    const targetMatches = await workspace.matchAllPaths(
      journal.workspaces,
      targetSide,
      expectedHeads,
    );
    if ((atOriginal && originalMatches.matches) || (atTarget && targetMatches.matches)) {
      await workspace.deleteRefs(journal.rollback);
      await clearJournal(dataDir, lineage);
      return undefined;
    }
    if (journal.phase === "transcript-moved" && atTarget && originalMatches.matches) {
      await workspace.restoreAllPaths(journal.workspaces, targetSide);
      const restored = await workspace.matchAllPaths(
        journal.workspaces,
        targetSide,
        expectedHeads,
      );
      if (restored.matches) {
        await workspace.deleteRefs(journal.rollback);
        await clearJournal(dataDir, lineage);
        return undefined;
      }
    }
    return `Undo recovery is unresolved for ${journal.direction} of ${journal.turnId}; affected paths and rollback snapshots were retained.`;
  };

  const discardPending = async (): Promise<void> => {
    const abandoned = pending;
    pending = undefined;
    if (abandoned) await workspace.deleteRefs(abandoned.before).catch(() => {});
  };

  const initialize = (ctx: ExtensionContext): void => {
    rootSessionId ||= ctx.sessionManager.getSessionId();
    pending = undefined;
    unavailableMessage = undefined;
    lastContext = ctx;
  };

  const finalizePending = async (ctx: ExtensionContext): Promise<void> => {
    const active = pending;
    if (!active) return;
    pending = undefined;
    const branch = ctx.sessionManager.getBranch();
    const userEntry = entriesAfterLeaf(branch, active.startLeafId).find(isUserEntry);
    if (!userEntry) {
      await workspace.deleteRefs(active.before).catch(() => {});
      return;
    }
    if (active.truncatesRedo) {
      pi.appendEntry(CURSOR_TYPE, { version: 2, kind: "truncate" });
    }
    if (active.unavailableReason) {
      unavailableMessage = active.unavailableReason;
      pi.appendEntry(UNAVAILABLE_TYPE, {
        version: 2,
        reason: unavailableMessage,
        userEntryId: userEntry.id,
      });
      return;
    }
    try {
      const after = await workspace.capture(
        roots(ctx),
        rootSessionId || active.sourceSessionId,
        active.id,
        "after",
      );
      const workspaces = await workspace.deltas(active.before, after);
      const checkpoint: TurnCheckpointV2 = {
        version: 2,
        id: active.id,
        rootSessionId: rootSessionId || active.sourceSessionId,
        userEntryId: userEntry.id,
        sessionFile: active.sourceSessionFile,
        sessionId: active.sourceSessionId,
        createdAt: new Date().toISOString(),
        workspaces,
      };
      pi.appendEntry(CHECKPOINT_TYPE, checkpoint);
      unavailableMessage = undefined;
    } catch (error) {
      await workspace.deleteRefs(active.before).catch(() => {});
      unavailableMessage = error instanceof Error ? error.message : String(error);
      pi.appendEntry(UNAVAILABLE_TYPE, {
        version: 2,
        reason: unavailableMessage,
      });
      pi.logger.warn("Undo turn was not recorded", { error: unavailableMessage });
    }
  };

  pi.on("session_start", (_event, ctx) => initialize(ctx));
  pi.on("session_switch", (_event, ctx) => initialize(ctx));
  pi.on("session_branch", (_event, ctx) => initialize(ctx));
  pi.on("session_tree", (_event, ctx) => initialize(ctx));
  pi.on("session_shutdown", async () => {
    if (lastContext) await finalizePending(lastContext);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    lastContext = ctx;
    if (ctx.mode !== "tui" || pending) return;
    const sourceSessionFile = ctx.sessionManager.getSessionFile();
    if (!sourceSessionFile) return;
    let truncatesRedo = false;
    try {
      truncatesRedo = (await reconstructState(ctx.sessionManager.getBranch())).redo.length > 0;
    } catch (error) {
      unavailableMessage = error instanceof Error ? error.message : String(error);
      return;
    }
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
        truncatesRedo,
      };
      unavailableMessage = undefined;
    } catch (error) {
      unavailableMessage = error instanceof Error ? error.message : String(error);
      pending = {
        id,
        startLeafId: ctx.sessionManager.getLeafId(),
        sourceSessionFile,
        sourceSessionId: ctx.sessionManager.getSessionId(),
        before: [],
        truncatesRedo,
        unavailableReason: unavailableMessage,
      };
      pi.logger.warn("Undo snapshot capture failed", { error: unavailableMessage });
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    lastContext = ctx;
    if (!event.willContinue) await finalizePending(ctx);
  });

  const preflight = async (
    ctx: ExtensionCommandContext,
    side: "before" | "after",
  ): Promise<{ state: ResolvedState; turn: TurnCheckpointV2 } | undefined> => {
    if (ctx.mode !== "tui") {
      notifyFailure(ctx, "Undo and redo are available only in an interactive root session.");
      return undefined;
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages() || liveRelevantSubagent(ctx)) {
      notifyFailure(ctx, "Cannot change undo history while the session or a relevant subagent is busy.");
      return undefined;
    }
    let state: ResolvedState;
    try {
      const recoveryError = await recoverJournal(ctx);
      if (recoveryError) {
        notifyFailure(ctx, recoveryError, true);
        return undefined;
      }
    } catch (error) {
      notifyFailure(ctx, error instanceof Error ? error.message : String(error), true);
      return undefined;
    }
    try {
      state = await reconstructState(ctx.sessionManager.getBranch());
    } catch (error) {
      notifyFailure(ctx, `Undo history is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
    const turn = side === "after" ? state.applied.at(-1) : state.redo.at(-1)?.turn;
    if (!turn) {
      notifyFailure(
        ctx,
        unavailableMessage ?? `There is no user turn to ${side === "after" ? "undo" : "redo"}.`,
      );
      return undefined;
    }
    const resolved = await resolveWorkspace(pi, roots(ctx));
    if (!resolved.ok) {
      notifyFailure(ctx, resolved.message);
      return undefined;
    }
    const workspaceScopeChanged = turn.workspaces.some((workspaceRecord) => {
      const current = resolved.repositories.find(
        (repository) =>
          repository.repositoryRoot === workspaceRecord.repositoryRoot &&
          repository.commonDir === workspaceRecord.commonDir,
      );
      if (!current) return true;
      const expectedScopes = workspaceRecord.after.scopes;
      return (
        current.scopes.length !== expectedScopes.length ||
        current.scopes.some((scope, index) => scope !== expectedScopes[index])
      );
    });
    if (workspaceScopeChanged || resolved.repositories.length !== turn.workspaces.length) {
      notifyFailure(ctx, "Configured workspace roots changed since this turn was recorded.");
      return undefined;
    }
    if (!(await workspace.available(allSnapshots(turn)))) {
      notifyFailure(ctx, "The private workspace snapshot for this turn is missing or expired.");
      return undefined;
    }
    const match = await workspace.matchAllPaths(turn.workspaces, side, state.expectedHeads);
    if (!match.matches) {
      notifyFailure(
        ctx,
        `Affected workspace paths changed:\n${match.paths.join("\n")}`,
      );
      return undefined;
    }
    return { state, turn };
  };

  const runUndo = async (ctx: ExtensionCommandContext): Promise<void> => {
    const draft = ctx.ui.getEditorText();
    ctx.ui.setEditorText("");
    const prepared = await preflight(ctx, "after");
    if (!prepared) {
      ctx.ui.setEditorText(draft);
      return;
    }
    const { state, turn } = prepared;
    const originalSessionFile = ctx.sessionManager.getSessionFile();
    const originalLeafId = ctx.sessionManager.getLeafId();
    const entry = ctx.sessionManager.getEntry(turn.userEntryId);
    if (!originalSessionFile || !entry || !isUserEntry(entry)) {
      ctx.ui.setEditorText(draft);
      notifyFailure(ctx, "The transcript boundary for this undo point is missing.");
      return;
    }
    let rollback: WorkspaceSnapshot[] = [];
    let journal: TransitionJournal | undefined;
    let transitioned = false;
    try {
      rollback = await workspace.capture(
        roots(ctx),
        rootSessionId || ctx.sessionManager.getSessionId(),
        `rollback-${crypto.randomUUID()}`,
        "rollback",
      );
      journal = {
        version: 1,
        direction: "undo",
        turnId: turn.id,
        original: { sessionFile: originalSessionFile, leafId: originalLeafId },
        target: null,
        rollback,
        workspaces: turn.workspaces,
        phase: "prepared",
      };
      await writeJournal(dataDir, rootSessionId || ctx.sessionManager.getSessionId(), journal);
      const cursor = {
        version: 2 as const,
        kind: "undo" as const,
        turnId: turn.id,
        source: { sessionFile: originalSessionFile, leafId: originalLeafId } satisfies SessionPosition,
      };
      if (!entry.parentId) {
        const result = await ctx.newSession({
          parentSession: originalSessionFile,
          setup: async (manager) => {
            manager.appendCustomEntry(CURSOR_TYPE, cursor);
            await manager.ensureOnDisk();
          },
        });
        if (result.cancelled) throw new Error("Session transition was cancelled.");
        transitioned = true;
      } else {
        const result =
          messageRecord(entry)?.role === "user"
            ? await ctx.branch(turn.userEntryId)
            : await ctx.navigateTree(entry.parentId, { summarize: false });
        if (result.cancelled) throw new Error("Session branching was cancelled.");
        transitioned = true;
        pi.appendEntry(CURSOR_TYPE, cursor);
      }
      journal = {
        ...journal,
        target: {
          sessionFile: ctx.sessionManager.getSessionFile() ?? "",
          leafId: ctx.sessionManager.getLeafId(),
        },
        phase: "transcript-moved",
      };
      await writeJournal(dataDir, rootSessionId || ctx.sessionManager.getSessionId(), journal);
      await workspace.restoreAllPaths(turn.workspaces, "before");
      journal = { ...journal, phase: "workspace-restored" };
      await writeJournal(dataDir, rootSessionId || ctx.sessionManager.getSessionId(), journal);
      await ctx.reload();
      const prompt = userText(entry);
      ctx.ui.setEditorText(prompt.text);
      ctx.ui.notify("Undid last user turn and restored selected workspace paths.", "info");
      if (prompt.attachments) ctx.ui.notify("Prompt attachments cannot be restored to the editor.", "warning");
      ctx.ui.notify(SCOPE_WARNING, "warning");
      await workspace.deleteRefs(rollback);
      await clearJournal(dataDir, rootSessionId || ctx.sessionManager.getSessionId());
    } catch (error) {
      await restoreRollback(workspace, rollback, turn).catch((compensation: unknown) =>
        pi.logger.error("Undo workspace compensation failed", { error: String(compensation) }),
      );
      if (transitioned) {
        await ctx.switchSession(originalSessionFile).catch((compensation: unknown) =>
          pi.logger.error("Undo transcript compensation failed", { error: String(compensation) }),
        );
      }
      ctx.ui.setEditorText(draft);
      notifyFailure(ctx, `Failed to undo last user turn: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  };

  const runRedo = async (ctx: ExtensionCommandContext): Promise<void> => {
    const draft = ctx.ui.getEditorText();
    ctx.ui.setEditorText("");
    const prepared = await preflight(ctx, "before");
    if (!prepared) {
      ctx.ui.setEditorText(draft);
      return;
    }
    const { state, turn } = prepared;
    const target = state.redo.at(-1)?.target;
    const originalSessionFile = ctx.sessionManager.getSessionFile();
    const originalLeafId = ctx.sessionManager.getLeafId();
    if (!target || !originalSessionFile) {
      ctx.ui.setEditorText(draft);
      notifyFailure(ctx, "The transcript position for this redo point is missing.");
      return;
    }
    let rollback: WorkspaceSnapshot[] = [];
    let journal: TransitionJournal | undefined;
    let transitioned = false;
    try {
      rollback = await workspace.capture(
        roots(ctx),
        rootSessionId || ctx.sessionManager.getSessionId(),
        `rollback-${crypto.randomUUID()}`,
        "rollback",
      );
      journal = {
        version: 1,
        direction: "redo",
        turnId: turn.id,
        original: { sessionFile: originalSessionFile, leafId: originalLeafId },
        target,
        rollback,
        workspaces: turn.workspaces,
        phase: "prepared",
      };
      await writeJournal(dataDir, rootSessionId || ctx.sessionManager.getSessionId(), journal);
      const result = await ctx.switchSession(target.sessionFile);
      if (result.cancelled) throw new Error("Source session switch was cancelled.");
      if (
        target.leafId !== null &&
        ctx.sessionManager.getLeafId() !== target.leafId
      ) {
        throw new Error("Redo source session is not at its recorded transcript leaf.");
      }
      transitioned = true;
      journal = { ...journal, phase: "transcript-moved" };
      await writeJournal(dataDir, rootSessionId || ctx.sessionManager.getSessionId(), journal);
      await workspace.restoreAllPaths(turn.workspaces, "after");
      journal = { ...journal, phase: "workspace-restored" };
      await writeJournal(dataDir, rootSessionId || ctx.sessionManager.getSessionId(), journal);
      await ctx.reload();
      if (state.redo.length > 1) ctx.ui.setEditorText(draft);
      ctx.ui.notify("Redid user turn and restored selected workspace paths.", "info");
      ctx.ui.notify(SCOPE_WARNING, "warning");
      await workspace.deleteRefs(rollback);
      await clearJournal(dataDir, rootSessionId || ctx.sessionManager.getSessionId());
    } catch (error) {
      await restoreRollback(workspace, rollback, turn).catch((compensation: unknown) =>
        pi.logger.error("Redo workspace compensation failed", { error: String(compensation) }),
      );
      if (transitioned) {
        await ctx.switchSession(originalSessionFile).catch((compensation: unknown) =>
          pi.logger.error("Redo transcript compensation failed", { error: String(compensation) }),
        );
      }
      ctx.ui.setEditorText(draft);
      notifyFailure(ctx, `Failed to redo user turn: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  };

  pi.registerCommand("undo", {
    description: "Undo last user turn and selected workspace changes",
    handler: (_args, ctx) => runUndo(ctx),
  });
  pi.registerCommand("redo", {
    description: "Redo last undone user turn and selected workspace changes",
    handler: (_args, ctx) => runRedo(ctx),
  });
}

export default function undoRedoExtension(pi: ExtensionAPI): void {
  createUndoRedoExtension(pi);
}
