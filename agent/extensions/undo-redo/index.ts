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
  listJournals,
  writeJournal,
  type TransitionJournal,
} from "./journal.ts";
import {
  CHECKPOINT_TYPE,
  CURSOR_TYPE,
  reconstructState,
  UNAVAILABLE_TYPE,
  workspaceIdentity,
  type ResolvedState,
  type SessionPosition,
  type TurnCheckpoint,
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
      ref.kind === "main" &&
      ref.sessionFile === ctx.sessionManager.getSessionFile(),
  );
  if (!root) return false;
  const byId = new Map(refs.map((ref) => [ref.id, ref]));
  return refs.some((ref) => {
    const running = registry.isRunning(ref) ||
      (ref.status === "running" && ref.session === null);
    if (ref.kind !== "sub" || !running) return false;
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

function allSnapshots(turn: TurnCheckpoint): WorkspaceSnapshot[] {
  return turn.workspaces.flatMap((workspace) => [workspace.before, workspace.after]);
}

async function restoreRollback(
  workspace: WorkspaceHistory,
  rollback: readonly WorkspaceSnapshot[],
  turn: Pick<TurnCheckpoint, "workspaces">,
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
  let sessionRecovery: Promise<string | undefined> = Promise.resolve(undefined);
  let pendingFinalization: Promise<void> | undefined;

  const lineageFromState = (
    state: ResolvedState,
    fallback: string,
  ): string => {
    const lineages = new Set(
      [...state.applied, ...state.redo.map((entry) => entry.turn)]
        .map((turn) => turn.rootSessionId),
    );
    if (lineages.size > 1) {
      throw new Error("Undo history has inconsistent journal lineages.");
    }
    return lineages.values().next().value ?? fallback;
  };

  const samePosition = (
    ctx: ExtensionContext,
    position: SessionPosition,
  ): boolean =>
    ctx.sessionManager.getSessionFile() === position.sessionFile &&
    ctx.sessionManager.getLeafId() === position.leafId;

  const excludedPathsNotice = (
    ctx: ExtensionCommandContext,
    turn: TurnCheckpoint,
  ): void => {
    const exclusions = new Set<string>();
    for (const workspaceRecord of turn.workspaces) {
      for (const excludedPath of new Set([
        ...workspaceRecord.before.excludedPaths,
        ...workspaceRecord.after.excludedPaths,
      ])) {
        const name = workspaceRecord.repositoryRoot === ctx.sessionManager.getCwd()
          ? excludedPath
          : `${workspaceRecord.repositoryRoot}:${excludedPath}`;
        exclusions.add(name);
      }
    }
    if (exclusions.size > 0) {
      ctx.ui.notify(
        `Oversized untracked paths were excluded and left unchanged:\n${[...exclusions].sort().join("\n")}`,
        "warning",
      );
    }
  };

  const releaseJournal = async (
    lineage: string,
    journal: TransitionJournal,
  ): Promise<void> => {
    await workspace.deleteRefs(journal.rollback);
    await clearJournal(dataDir, lineage);
  };

  const recoveryFailure = (
    journal: TransitionJournal,
    originalPaths: readonly string[],
    targetPaths: readonly string[],
  ): string => {
    const target = journal.target
      ? `${journal.target.sessionFile}@${journal.target.leafId ?? "<root>"}`
      : "<not-yet-created>";
    const paths = [...new Set([...originalPaths, ...targetPaths])];
    const detail = paths.length > 0 ? ` Affected paths: ${paths.join(", ")}.` : "";
    return `Undo recovery is unresolved for ${journal.direction} of ${journal.turnId}. Manual recovery is required at ${journal.original.sessionFile}@${journal.original.leafId ?? "<root>"} or ${target}; rollback snapshots were retained.${detail}`;
  };

  const recoverJournal = async (
    ctx: ExtensionContext,
    lineage: string,
    journal: TransitionJournal,
  ): Promise<string | undefined> => {
    const expectedHeads = new Map(
      journal.workspaces.map((workspaceRecord) => [
        workspaceIdentity(workspaceRecord),
        workspaceRecord.after.head,
      ]),
    );
    const originalSide = journal.direction === "undo" ? "after" : "before";
    const targetSide = journal.direction === "undo" ? "before" : "after";
    const atOriginal = samePosition(ctx, journal.original);
    const atTarget = journal.target !== null && samePosition(ctx, journal.target);
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
      await releaseJournal(lineage, journal);
      return undefined;
    }
    if (atTarget && originalMatches.matches) {
      await workspace.restoreAllPaths(journal.workspaces, targetSide);
      const restored = await workspace.matchAllPaths(
        journal.workspaces,
        targetSide,
        expectedHeads,
      );
      if (restored.matches) {
        await releaseJournal(lineage, journal);
        return undefined;
      }
    }
    if (atOriginal && targetMatches.matches) {
      await restoreRollback(workspace, journal.rollback, journal);
      const restored = await workspace.matchAllPaths(
        journal.workspaces,
        originalSide,
        expectedHeads,
      );
      if (restored.matches) {
        await releaseJournal(lineage, journal);
        return undefined;
      }
    }
    return recoveryFailure(
      journal,
      originalMatches.matches ? [] : originalMatches.paths,
      targetMatches.matches ? [] : targetMatches.paths,
    );
  };

  const recoverForContext = async (
    ctx: ExtensionContext,
  ): Promise<string | undefined> => {
    let lineage = ctx.sessionManager.getSessionId();
    let reconstructionError: string | undefined;
    try {
      const state = await reconstructState(ctx.sessionManager.getBranch());
      lineage = lineageFromState(state, lineage);
    } catch (error) {
      reconstructionError = error instanceof Error ? error.message : String(error);
    }
    const sessionFile = ctx.sessionManager.getSessionFile();
    const parentSession = ctx.sessionManager.getHeader()?.parentSession;
    const candidates = (await listJournals(dataDir)).filter(({ rootSessionId, journal }) =>
      rootSessionId === lineage ||
      journal.original.sessionFile === sessionFile ||
      journal.target?.sessionFile === sessionFile ||
      journal.original.sessionFile === parentSession,
    );
    if (candidates.length > 1) {
      return "Undo recovery found multiple transaction journals for this session; manual recovery is required.";
    }
    const [candidate] = candidates;
    if (candidate) {
      rootSessionId = candidate.rootSessionId;
      return recoverJournal(ctx, candidate.rootSessionId, candidate.journal);
    }
    if (reconstructionError) return `Undo history is unavailable: ${reconstructionError}`;
    rootSessionId = lineage;
    return undefined;
  };

  const ensureRecovered = async (
    ctx: ExtensionContext,
  ): Promise<string | undefined> => {
    const startRecovery = await sessionRecovery;
    if (startRecovery) return startRecovery;
    return recoverForContext(ctx);
  };


  const initialize = (): void => {
    rootSessionId = "";
    unavailableMessage = undefined;
    sessionRecovery = Promise.resolve(undefined);
  };

  const ensureSessionDurable = async (ctx: ExtensionContext): Promise<void> => {
    const manager = ctx.sessionManager as unknown;
    if (
      !manager ||
      typeof manager !== "object" ||
      !("ensureOnDisk" in manager) ||
      typeof manager.ensureOnDisk !== "function"
    ) {
      throw new Error("Undo session persistence is unavailable.");
    }
    await manager.ensureOnDisk();
  };

  const appendDurably = async (
    ctx: ExtensionContext,
    customType: string,
    data: unknown,
  ): Promise<void> => {
    pi.appendEntry(customType, data);
    await ensureSessionDurable(ctx);
  };

  const finalizePending = async (ctx: ExtensionContext): Promise<void> => {
    if (pendingFinalization) return pendingFinalization;
    const active = pending;
    if (!active) return;
    pending = undefined;
    const finalization = (async (): Promise<void> => {
      const branch = ctx.sessionManager.getBranch();
      const userEntry = entriesAfterLeaf(branch, active.startLeafId).find(isUserEntry);
      if (!userEntry) {
        await workspace.deleteRefs(active.before).catch(() => {});
        return;
      }
      let after: WorkspaceSnapshot[] = [];
      try {
        if (active.truncatesRedo) {
        }
        if (active.unavailableReason) throw new Error(active.unavailableReason);
        after = await workspace.capture(
          roots(ctx),
          rootSessionId || active.sourceSessionId,
          active.id,
          "after",
        );
        const workspaces = await workspace.deltas(active.before, after);
        const checkpoint: TurnCheckpoint = {
          id: active.id,
          rootSessionId: rootSessionId || active.sourceSessionId,
          userEntryId: userEntry.id,
          sessionFile: active.sourceSessionFile,
          sessionId: active.sourceSessionId,
          createdAt: new Date().toISOString(),
          workspaces,
        };
        await appendDurably(ctx, CHECKPOINT_TYPE, checkpoint);
        await workspace.recordDurableCheckpoint(
          checkpoint.rootSessionId,
          checkpoint.id,
          checkpoint.sessionFile,
          allSnapshots(checkpoint),
        );
        unavailableMessage = undefined;
      } catch (error) {
        unavailableMessage = error instanceof Error ? error.message : String(error);
        try {
          await appendDurably(ctx, UNAVAILABLE_TYPE, {
            reason: unavailableMessage,
            userEntryId: userEntry.id,
          });
        } finally {
          await workspace.deleteRefs([...active.before, ...after]).catch(() => {});
        }
        pi.logger.warn("Undo turn was not recorded", { error: unavailableMessage });
      }
    })();
    pendingFinalization = finalization;
    try {
      await finalization;
    } finally {
      if (pendingFinalization === finalization) pendingFinalization = undefined;
    }
  };

  const moveToPosition = async (
    ctx: ExtensionCommandContext,
    position: SessionPosition,
    onTransition: () => void,
    allowNavigation = true,
  ): Promise<void> => {
    const switchedSession =
      ctx.sessionManager.getSessionFile() !== position.sessionFile;
    if (switchedSession) {
      const result = await ctx.switchSession(position.sessionFile);
      if (result.cancelled) throw new Error("Session switch was cancelled.");
      onTransition();
    }
    if (position.leafId === null) {
      if (ctx.sessionManager.getLeafId() !== null) {
        throw new Error("Session is not at its recorded root.");
      }
    } else if (ctx.sessionManager.getLeafId() !== position.leafId) {
      if (!allowNavigation) {
        throw new Error("Source session is not at its recorded transcript leaf.");
      }
      const result = await ctx.navigateTree(position.leafId, { summarize: false });
      if (result.cancelled) throw new Error("Transcript navigation was cancelled.");
      onTransition();
    }
    if (!samePosition(ctx, position)) {
      throw new Error("Session is not at its recorded transcript leaf.");
    }
    await ensureSessionDurable(ctx);
  };

  const compatibleRedoState = (
    current: ResolvedState,
    target: ResolvedState,
    turn: TurnCheckpoint,
  ): boolean =>
    target.applied.length === current.applied.length + 1 &&
    target.applied.every((candidate, index) =>
      index === current.applied.length
        ? candidate.id === turn.id
        : candidate.id === current.applied[index]?.id,
    ) &&
    target.redo.length === current.redo.length - 1 &&
    target.redo.every((candidate, index) =>
      candidate.turn.id === current.redo[index]?.turn.id &&
      candidate.target.sessionFile === current.redo[index]?.target.sessionFile &&
      candidate.target.leafId === current.redo[index]?.target.leafId,
    ) &&
    target.expectedHeads.size === current.expectedHeads.size &&
    [...target.expectedHeads].every(([repository, head]) =>
      current.expectedHeads.get(repository) === head,
    );

  const compensate = async (
    ctx: ExtensionCommandContext,
    direction: "undo" | "redo",
    original: SessionPosition,
    rollback: readonly WorkspaceSnapshot[],
    turn: TurnCheckpoint,
    workspaceRestoreStarted: boolean,
    transcriptTransitioned: boolean,
  ): Promise<string | undefined> => {
    const failures: string[] = [];
    if (workspaceRestoreStarted) {
      try {
        await restoreRollback(workspace, rollback, turn);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        pi.logger.error(`${direction} workspace compensation failed`, { error: detail });
        failures.push(`workspace: ${detail}`);
      }
    }
    if (transcriptTransitioned || !samePosition(ctx, original)) {
      try {
        await moveToPosition(ctx, original, () => {}, false);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        pi.logger.error(`${direction} transcript compensation failed`, { error: detail });
        failures.push(`transcript: ${detail}`);
      }
    }
    return failures.length > 0 ? failures.join("; ") : undefined;
  };

  pi.on("session_start", async (_event, ctx) => {
    initialize();
    sessionRecovery = recoverForContext(ctx).catch(
      (error) => error instanceof Error ? error.message : String(error),
    );
    const recoveryError = await sessionRecovery;
    unavailableMessage = recoveryError;
  });
  const finalizeBeforeSessionTransition = async (
    _event: unknown,
    ctx: ExtensionContext,
  ): Promise<void> => {
    await finalizePending(ctx);
  };
  pi.on("session_before_switch", finalizeBeforeSessionTransition);
  pi.on("session_before_branch", finalizeBeforeSessionTransition);
  pi.on("session_before_tree", finalizeBeforeSessionTransition);
  pi.on("session_switch", () => initialize());
  pi.on("session_branch", () => initialize());
  pi.on("session_tree", () => initialize());
  pi.on("session_shutdown", async (_event, ctx) => {
    await finalizePending(ctx);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    await finalizePending(ctx);
    if (ctx.mode !== "tui") return;
    const sourceSessionFile = ctx.sessionManager.getSessionFile();
    if (!sourceSessionFile) return;
    const id = crypto.randomUUID();
    const createUnavailablePending = (reason: string): void => {
      unavailableMessage = reason;
      pending = {
        id,
        startLeafId: ctx.sessionManager.getLeafId(),
        sourceSessionFile,
        sourceSessionId: ctx.sessionManager.getSessionId(),
        before: [],
        truncatesRedo: false,
        unavailableReason: reason,
      };
    };
    let recoveryError: string | undefined;
    try {
      recoveryError = await ensureRecovered(ctx);
    } catch (error) {
      recoveryError = error instanceof Error ? error.message : String(error);
    }
    if (recoveryError) {
      createUnavailablePending(recoveryError);
      return;
    }
    let truncatesRedo = false;
    try {
      const state = await reconstructState(ctx.sessionManager.getBranch());
      rootSessionId = lineageFromState(state, ctx.sessionManager.getSessionId());
      truncatesRedo = state.redo.length > 0;
    } catch (error) {
      createUnavailablePending(error instanceof Error ? error.message : String(error));
      return;
    }
    try {
      const before = await workspace.capture(
        roots(ctx),
        rootSessionId,
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
      const reason = error instanceof Error ? error.message : String(error);
      unavailableMessage = reason;
      pending = {
        id,
        startLeafId: ctx.sessionManager.getLeafId(),
        sourceSessionFile,
        sourceSessionId: ctx.sessionManager.getSessionId(),
        before: [],
        truncatesRedo,
        unavailableReason: reason,
      };
      pi.logger.warn("Undo snapshot capture failed", { error: reason });
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!event.willContinue) await finalizePending(ctx);
  });

  const preflight = async (
    ctx: ExtensionCommandContext,
    side: "before" | "after",
  ): Promise<{ state: ResolvedState; turn: TurnCheckpoint; lineage: string } | undefined> => {
    if (ctx.mode !== "tui") {
      notifyFailure(ctx, "Undo and redo are available only in an interactive root session.");
      return undefined;
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages() || liveRelevantSubagent(ctx)) {
      notifyFailure(ctx, "Cannot change undo history while the session or a relevant subagent is busy.");
      return undefined;
    }
    await finalizePending(ctx);

    try {
      const recoveryError = await ensureRecovered(ctx);
      if (recoveryError) {
        notifyFailure(ctx, recoveryError, true);
        return undefined;
      }
    } catch (error) {
      notifyFailure(ctx, error instanceof Error ? error.message : String(error), true);
      return undefined;
    }
    let state: ResolvedState;
    try {
      state = await reconstructState(ctx.sessionManager.getBranch());
      rootSessionId = lineageFromState(state, ctx.sessionManager.getSessionId());
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
    return { state, turn, lineage: rootSessionId };
  };

  const completeCleanup = async (
    ctx: ExtensionCommandContext,
    direction: "undo" | "redo",
    lineage: string,
    journal: TransitionJournal,
  ): Promise<void> => {
    try {
      await releaseJournal(lineage, journal);
    } catch (error) {
      notifyFailure(
        ctx,
        `${direction === "undo" ? "Undo" : "Redo"} completed, but transaction cleanup is pending: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  };

  const runUndo = async (ctx: ExtensionCommandContext): Promise<void> => {
    const draft = ctx.ui.getEditorText();
    ctx.ui.setEditorText("");
    const prepared = await preflight(ctx, "after");
    if (!prepared) {
      ctx.ui.setEditorText(draft);
      return;
    }
    const { turn, lineage } = prepared;
    const original: SessionPosition = {
      sessionFile: ctx.sessionManager.getSessionFile() ?? "",
      leafId: ctx.sessionManager.getLeafId(),
    };
    const entry = ctx.sessionManager.getEntry(turn.userEntryId);
    if (!original.sessionFile || !entry || !isUserEntry(entry)) {
      ctx.ui.setEditorText(draft);
      notifyFailure(ctx, "The transcript boundary for this undo point is missing.");
      return;
    }
    let rollback: WorkspaceSnapshot[] = [];
    let journal: TransitionJournal | undefined;
    let transcriptTransitioned = false;
    let workspaceRestoreStarted = false;
    try {
      rollback = await workspace.capture(
        roots(ctx),
        lineage,
        `rollback-${crypto.randomUUID()}`,
        "rollback",
      );
      journal = {
        rootSessionId: lineage,
        direction: "undo",
        turnId: turn.id,
        original,
        target: null,
        rollback,
        workspaces: turn.workspaces,
        phase: "prepared",
      };
      await writeJournal(dataDir, lineage, journal);
      const cursor = {
        kind: "undo" as const,
        turnId: turn.id,
        source: original,
      };
      if (!entry.parentId) {
        const result = await ctx.newSession({
          parentSession: original.sessionFile,
          setup: async (manager) => {
            manager.appendCustomEntry(CURSOR_TYPE, cursor);
            await manager.ensureOnDisk();
          },
        });
        if (result.cancelled) throw new Error("Session transition was cancelled.");
        transcriptTransitioned = true;
      } else {
        const result =
          messageRecord(entry)?.role === "user"
            ? await ctx.branch(turn.userEntryId)
            : await ctx.navigateTree(entry.parentId, { summarize: false });
        if (result.cancelled) throw new Error("Session branching was cancelled.");
        transcriptTransitioned = true;
        await appendDurably(ctx, CURSOR_TYPE, cursor);
      }
      const target: SessionPosition = {
        sessionFile: ctx.sessionManager.getSessionFile() ?? "",
        leafId: ctx.sessionManager.getLeafId(),
      };
      if (!target.sessionFile) throw new Error("Undo target session is missing.");
      journal = { ...journal, target, phase: "transcript-moved" };
      await writeJournal(dataDir, lineage, journal);
      workspaceRestoreStarted = true;
      await workspace.restoreAllPaths(turn.workspaces, "before");
      journal = { ...journal, phase: "workspace-restored" };
      await writeJournal(dataDir, lineage, journal);
      await ctx.reload();
      const prompt = userText(entry);
      ctx.ui.setEditorText(prompt.text);
      ctx.ui.notify("Undid last user turn and restored selected workspace paths.", "info");
      if (prompt.attachments) ctx.ui.notify("Prompt attachments cannot be restored to the editor.", "warning");
      ctx.ui.notify(SCOPE_WARNING, "warning");
      excludedPathsNotice(ctx, turn);
    } catch (error) {
      const compensationError = await compensate(
        ctx,
        "undo",
        original,
        rollback,
        turn,
        workspaceRestoreStarted,
        transcriptTransitioned,
      );
      if (!compensationError && journal) {
        const recoveryError = await recoverJournal(ctx, lineage, journal).catch(
          (recovery) => recovery instanceof Error ? recovery.message : String(recovery),
        );
        if (recoveryError) {
          ctx.ui.setEditorText(draft);
          notifyFailure(ctx, `Failed to undo last user turn: ${error instanceof Error ? error.message : String(error)}. Manual recovery is required: ${recoveryError}`, true);
          return;
        }
      }
      ctx.ui.setEditorText(draft);
      const manualRecovery = compensationError
        ? ` Manual recovery is required: ${compensationError}`
        : "";
      notifyFailure(ctx, `Failed to undo last user turn: ${error instanceof Error ? error.message : String(error)}.${manualRecovery}`, true);
      return;
    }
    if (journal) await completeCleanup(ctx, "undo", lineage, journal);
  };

  const runRedo = async (ctx: ExtensionCommandContext): Promise<void> => {
    const draft = ctx.ui.getEditorText();
    ctx.ui.setEditorText("");
    const prepared = await preflight(ctx, "before");
    if (!prepared) {
      ctx.ui.setEditorText(draft);
      return;
    }
    const { state, turn, lineage } = prepared;
    const target = state.redo.at(-1)?.target;
    const original: SessionPosition = {
      sessionFile: ctx.sessionManager.getSessionFile() ?? "",
      leafId: ctx.sessionManager.getLeafId(),
    };
    if (!target || !original.sessionFile) {
      ctx.ui.setEditorText(draft);
      notifyFailure(ctx, "The transcript position for this redo point is missing.");
      return;
    }
    let rollback: WorkspaceSnapshot[] = [];
    let journal: TransitionJournal | undefined;
    let transcriptTransitioned = false;
    let workspaceRestoreStarted = false;
    try {
      rollback = await workspace.capture(
        roots(ctx),
        lineage,
        `rollback-${crypto.randomUUID()}`,
        "rollback",
      );
      journal = {
        rootSessionId: lineage,
        direction: "redo",
        turnId: turn.id,
        original,
        target,
        rollback,
        workspaces: turn.workspaces,
        phase: "prepared",
      };
      await writeJournal(dataDir, lineage, journal);
      await moveToPosition(ctx, target, () => {
        transcriptTransitioned = true;
      });
      const targetState = await reconstructState(ctx.sessionManager.getBranch());
      if (!compatibleRedoState(state, targetState, turn)) {
        throw new Error("Redo target does not contain the recorded next undo state.");
      }
      journal = { ...journal, phase: "transcript-moved" };
      await writeJournal(dataDir, lineage, journal);
      workspaceRestoreStarted = true;
      await workspace.restoreAllPaths(turn.workspaces, "after");
      journal = { ...journal, phase: "workspace-restored" };
      await writeJournal(dataDir, lineage, journal);
      await ctx.reload();
      await moveToPosition(ctx, target, () => {
        transcriptTransitioned = true;
      });
      if (state.redo.length > 1) ctx.ui.setEditorText(draft);
      ctx.ui.notify("Redid user turn and restored selected workspace paths.", "info");
      ctx.ui.notify(SCOPE_WARNING, "warning");
      excludedPathsNotice(ctx, turn);
    } catch (error) {
      const compensationError = await compensate(
        ctx,
        "redo",
        original,
        rollback,
        turn,
        workspaceRestoreStarted,
        transcriptTransitioned,
      );
      if (!compensationError && journal) {
        const recoveryError = await recoverJournal(ctx, lineage, journal).catch(
          (recovery) => recovery instanceof Error ? recovery.message : String(recovery),
        );
        if (recoveryError) {
          ctx.ui.setEditorText(draft);
          notifyFailure(ctx, `Failed to redo user turn: ${error instanceof Error ? error.message : String(error)}. Manual recovery is required: ${recoveryError}`, true);
          return;
        }
      }
      ctx.ui.setEditorText(draft);
      const manualRecovery = compensationError
        ? ` Manual recovery is required: ${compensationError}`
        : "";
      notifyFailure(ctx, `Failed to redo user turn: ${error instanceof Error ? error.message : String(error)}.${manualRecovery}`, true);
      return;
    }
    if (journal) await completeCleanup(ctx, "redo", lineage, journal);
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
