import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { $ } from "bun";
import { WorkspaceHistory } from "../git.ts";
import { readJournal, writeJournal } from "../journal.ts";
import { createUndoRedoExtension } from "../index.ts";
import type { TurnCheckpointV2 } from "../state.ts";

interface RegisteredExtension {
  handlers: Map<
    string,
    (
      event: Record<string, unknown>,
      ctx: ExtensionContext,
    ) => Promise<void> | void
  >;
  commands: Map<
    string,
    (args: string, ctx: ExtensionCommandContext) => Promise<void> | void
  >;
}

const cleanup: string[] = [];

afterEach(async () => {
  AgentRegistry.resetGlobalForTests();
  await Promise.all(
    cleanup
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

async function makeRepository(): Promise<string> {
  const root = await fs.mkdtemp("/tmp/omp-undo-redo-extension-");
  cleanup.push(root);
  await Bun.write(path.join(root, "tracked.txt"), "baseline\n");
  await Bun.write(path.join(root, ".gitignore"), "ignored.log\n");
  await $`git init --initial-branch=main && git config user.email tester@example.com && git config user.name Tester && git add -A && git commit -m baseline`
    .cwd(root)
    .quiet();
  return root;
}

function dataDirectory(root: string): string {
  const dataDir = `${root}-undo-redo-data`;
  cleanup.push(dataDir);
  return dataDir;
}

function exec(
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
) {
  const result = Bun.spawnSync([command, ...args], {
    cwd: options?.cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: options?.timeout,
  });
  return Promise.resolve({
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    code: result.exitCode,
    killed: result.exitedDueToTimeout,
  });
}

function effectiveGitArgs(command: string, args: readonly string[]): readonly string[] {
  if (command === "git") return args;
  if (command !== "env") return [];
  const git = args.indexOf("git");
  return git === -1 ? [] : args.slice(git + 1);
}

function loadExtension(
  manager: SessionManager,
  dataDir: string,
  run: typeof exec = exec,
): RegisteredExtension {
  const handlers = new Map<
    string,
    (
      event: Record<string, unknown>,
      ctx: ExtensionContext,
    ) => Promise<void> | void
  >();
  const commands = new Map<
    string,
    (args: string, ctx: ExtensionCommandContext) => Promise<void> | void
  >();
  const pi = {
    exec: run,
    logger: { warn() {}, error() {}, debug() {} },
    on(
      event: string,
      handler: (
        event: Record<string, unknown>,
        ctx: ExtensionContext,
      ) => Promise<void> | void,
    ) {
      handlers.set(event, handler);
    },
    appendEntry(customType: string, data?: unknown) {
      manager.appendCustomEntry(customType, data);
    },
    registerCommand(
      name: string,
      options: {
        handler: (
          args: string,
          ctx: ExtensionCommandContext,
        ) => Promise<void> | void;
      },
    ) {
      commands.set(name, options.handler);
    },
  } as unknown as ExtensionAPI;
  createUndoRedoExtension(pi, dataDir);
  return { handlers, commands };
}

function baseContext(manager: SessionManager, cwd: string): ExtensionContext {
  return {
    mode: "tui",
    cwd,
    hasUI: true,
    sessionManager: manager,
    isIdle: () => true,
    hasPendingMessages: () => false,
  } as unknown as ExtensionContext;
}

function appendAssistant(
  manager: SessionManager,
  stopReason: "stop" | "error" | "aborted" = "stop",
): void {
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: stopReason }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  });
}

async function recordTurn(
  extension: RegisteredExtension,
  manager: SessionManager,
  context: ExtensionContext,
  prompt: string,
  change?: () => Promise<void>,
  stopReason: "stop" | "error" | "aborted" = "stop",
): Promise<string> {
  await extension.handlers.get("before_agent_start")?.(
    { type: "before_agent_start", prompt, systemPrompt: [] },
    context,
  );
  const userEntryId = manager.appendMessage({
    role: "user",
    content: prompt,
    timestamp: Date.now(),
  });
  await change?.();
  appendAssistant(manager, stopReason);
  await extension.handlers.get("agent_end")?.(
    { type: "agent_end", messages: [] },
    context,
  );
  return userEntryId;
}

function commandContext(
  manager: SessionManager,
  context: ExtensionContext,
  editor: { text: string },
  notifications: Array<[string, string | undefined]>,
  overrides: Partial<ExtensionCommandContext> = {},
): ExtensionCommandContext {
  return {
    ...context,
    ui: {
      getEditorText: () => editor.text,
      setEditorText: (text: string) => {
        editor.text = text;
      },
      notify: (message: string, type?: string) => notifications.push([message, type]),
    },
    waitForIdle: async () => {},
    newSession: async (options?: {
      parentSession?: string;
      setup?: (sessionManager: SessionManager) => Promise<void>;
    }) => {
      await manager.newSession({ parentSession: options?.parentSession });
      await options?.setup?.(manager);
      return { cancelled: false };
    },
    branch: async (entryId: string) => {
      manager.createBranchedSession(manager.getEntry(entryId)?.parentId ?? "");
      return { cancelled: false };
    },
    navigateTree: async (targetId: string) => {
      manager.createBranchedSession(targetId);
      return { cancelled: false };
    },
    switchSession: async (sessionFile: string) => {
      await manager.setSessionFile(sessionFile);
      return { cancelled: false };
    },
    reload: async () => {
      const sessionFile = manager.getSessionFile();
      if (sessionFile) await manager.setSessionFile(sessionFile);
    },
    ...overrides,
  } as unknown as ExtensionCommandContext;
}
describe("local undo redo extension", () => {
  it("records a completed user turn and round-trips its transcript and Git workspace", async () => {
    AgentRegistry.resetGlobalForTests();
    const root = await makeRepository();
    const sessionDir = `${root}-sessions`;
    cleanup.push(sessionDir);
    const manager = SessionManager.create(root, sessionDir);
    const extension = loadExtension(manager, dataDirectory(root));
    const context = baseContext(manager, root);
    await extension.handlers.get("session_start")?.(
      { type: "session_start" },
      context,
    );
    await Bun.write(path.join(root, "ignored.log"), "ignored before\n");
    await extension.handlers.get("before_agent_start")?.(
      { type: "before_agent_start", prompt: "change it", systemPrompt: [] },
      context,
    );

    const userEntryId = manager.appendMessage({
      role: "user",
      content: "change it",
      timestamp: Date.now(),
    });
    await Bun.write(path.join(root, "tracked.txt"), "staged\n");
    await $`git add tracked.txt`.cwd(root).quiet();
    await Bun.write(path.join(root, "tracked.txt"), "after\n");
    await Bun.write(path.join(root, "untracked.txt"), "untracked after\n");
    await Bun.write(path.join(root, "ignored.log"), "ignored after\n");
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    await extension.handlers.get("agent_end")?.(
      { type: "agent_end", messages: [] },
      context,
    );
    await manager.flush();
    expect(
      manager
        .getEntries()
        .some(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "omp.undo-redo.checkpoint.v2",
        ),
    ).toBe(true);

    let editor = "/undo";
    const notifications: Array<[string, string | undefined]> = [];
    const commandContext = {
      ...context,
      ui: {
        getEditorText: () => editor,
        setEditorText: (text: string) => {
          editor = text;
        },
        notify: (message: string, type?: string) =>
          notifications.push([message, type]),
      },
      waitForIdle: async () => {},
      newSession: async (options?: {
        parentSession?: string;
        setup?: (sessionManager: SessionManager) => Promise<void>;
      }) => {
        await manager.newSession({ parentSession: options?.parentSession });
        await options?.setup?.(manager);
        return { cancelled: false };
      },
      branch: async (entryId: string) => {
        manager.createBranchedSession(
          manager.getEntry(entryId)?.parentId ?? "",
        );
        return { cancelled: false };
      },
      navigateTree: async (targetId: string) => {
        manager.createBranchedSession(targetId);
        return { cancelled: false };
      },
      switchSession: async (sessionFile: string) => {
        await manager.setSessionFile(sessionFile);
        return { cancelled: false };
      },
      reload: async () => {
        const sessionFile = manager.getSessionFile();
        if (sessionFile) await manager.setSessionFile(sessionFile);
      },
    } as unknown as ExtensionCommandContext;
    await extension.commands.get("undo")?.("", commandContext);

    expect(notifications).toContainEqual([
      "Undid last user turn and restored selected workspace paths.",
      "info",
    ]);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe(
      "baseline\n",
    );
    expect(await Bun.file(path.join(root, "untracked.txt")).exists()).toBe(
      false,
    );
    expect(await Bun.file(path.join(root, "ignored.log")).text()).toBe(
      "ignored after\n",
    );
    expect(await $`git status --porcelain=v1 -z`.cwd(root).text()).toBe("");
    expect(manager.getEntry(userEntryId)).toBeUndefined();

    editor = "/redo";
    await extension.commands.get("redo")?.("", commandContext);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe(
      "after\n",
    );
    expect(await Bun.file(path.join(root, "untracked.txt")).text()).toBe(
      "untracked after\n",
    );
    expect(await Bun.file(path.join(root, "ignored.log")).text()).toBe(
      "ignored after\n",
    );
    expect(await $`git status --porcelain=v1 -z`.cwd(root).text()).toBe(
      "MM tracked.txt\0?? untracked.txt\0",
    );
    expect(manager.getEntry(userEntryId)).toBeDefined();
    expect(notifications).toContainEqual([
      "Redid user turn and restored selected workspace paths.",
      "info",
    ]);
  });

  it("refuses a manual workspace divergence without moving the transcript", async () => {
    AgentRegistry.resetGlobalForTests();
    const root = await makeRepository();
    const sessionDir = `${root}-sessions`;
    cleanup.push(sessionDir);
    const manager = SessionManager.create(root, sessionDir);
    const extension = loadExtension(manager, dataDirectory(root));
    const context = baseContext(manager, root);
    await extension.handlers.get("session_start")?.(
      { type: "session_start" },
      context,
    );
    await extension.handlers.get("before_agent_start")?.(
      { type: "before_agent_start", prompt: "change it", systemPrompt: [] },
      context,
    );
    manager.appendMessage({
      role: "user",
      content: "change it",
      timestamp: Date.now(),
    });
    await Bun.write(path.join(root, "tracked.txt"), "after\n");
    manager.appendMessage({
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    await extension.handlers.get("agent_end")?.(
      { type: "agent_end", messages: [] },
      context,
    );
    const leaf = manager.getLeafId();
    const sourceFile = manager.getSessionFile();
    await Bun.write(path.join(root, "tracked.txt"), "manual\n");
    const index = await $`git ls-files --stage -- tracked.txt`.cwd(root).text();
    let editor = "/undo";
    const warnings: string[] = [];
    const commandContext = {
      ...context,
      ui: {
        getEditorText: () => editor,
        setEditorText: (text: string) => {
          editor = text;
        },
        notify: (message: string) => warnings.push(message),
      },
    } as unknown as ExtensionCommandContext;

    await extension.commands.get("undo")?.("", commandContext);
    expect(manager.getLeafId()).toBe(leaf);
    expect(manager.getSessionFile()).toBe(sourceFile);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe(
      "manual\n",
    );
    expect(await $`git ls-files --stage -- tracked.txt`.cwd(root).text()).toBe(index);
    expect(editor).toBe("/undo");
    expect(
      warnings.some((message) => message.includes("Affected workspace paths changed")),
    ).toBe(true);
  });

  it("captures and restores every configured linked worktree", async () => {
    const root = await makeRepository();
    const linked = `${root}-linked`;
    cleanup.push(linked);
    await $`git worktree add -b undo-redo-linked ${linked}`.cwd(root).quiet();

    const workspace = new WorkspaceHistory(
      { exec } as unknown as ExtensionAPI,
      dataDirectory(root),
    );
    const snapshots = await workspace.capture(
      [root, linked],
      "session",
      "turn",
      "before",
    );

    expect(snapshots).toHaveLength(2);
    expect(new Set(snapshots.map((snapshot) => snapshot.repositoryRoot))).toEqual(
      new Set([root, linked]),
    );
    expect(new Set(snapshots.map((snapshot) => snapshot.refName)).size).toBe(2);

    await Bun.write(path.join(root, "tracked.txt"), "main changed\n");
    await Bun.write(path.join(linked, "tracked.txt"), "linked changed\n");
    const after = await workspace.capture(
      [root, linked],
      "session",
      "turn",
      "after",
    );
    await workspace.restoreAllPaths(await workspace.deltas(snapshots, after), "before");

    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe(
      "baseline\n",
    );
    expect(await Bun.file(path.join(linked, "tracked.txt")).text()).toBe(
      "baseline\n",
    );

  });
  it("restores only turn paths while preserving unrelated manual edits", async () => {
    const root = await makeRepository();
    const workspace = new WorkspaceHistory(
      { exec } as unknown as ExtensionAPI,
      dataDirectory(root),
    );
    const before = await workspace.capture([root], "session", "selective", "before");
    await Bun.write(path.join(root, "tracked.txt"), "turn change\n");
    const after = await workspace.capture([root], "session", "selective", "after");
    const deltas = await workspace.deltas(before, after);
    await Bun.write(path.join(root, "manual.txt"), "manual change\n");

    await workspace.restoreAllPaths(deltas, "before");

    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("baseline\n");
    expect(await Bun.file(path.join(root, "manual.txt")).text()).toBe("manual change\n");
  });

  it("round-trips file-to-directory changes through selective restoration", async () => {
    const root = await makeRepository();
    const workspace = new WorkspaceHistory(
      { exec } as unknown as ExtensionAPI,
      dataDirectory(root),
    );
    const before = await workspace.capture([root], "session", "shape", "before");
    await fs.rm(path.join(root, "tracked.txt"));
    await fs.mkdir(path.join(root, "tracked.txt"));
    await Bun.write(path.join(root, "tracked.txt", "child.txt"), "child\n");
    const after = await workspace.capture([root], "session", "shape", "after");
    const deltas = await workspace.deltas(before, after);

    await workspace.restoreAllPaths(deltas, "before");
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("baseline\n");

    await workspace.restoreAllPaths(deltas, "after");
    expect(await Bun.file(path.join(root, "tracked.txt", "child.txt")).text()).toBe("child\n");
  });
  it("keeps completed turns LIFO across multi-level undo redo and truncates redo after a new prompt", async () => {
    const root = await makeRepository();
    const sessionDir = `${root}-sessions`;
    cleanup.push(sessionDir);
    const manager = SessionManager.create(root, sessionDir);
    const extension = loadExtension(manager, dataDirectory(root));
    const context = baseContext(manager, root);
    await extension.handlers.get("session_start")?.({ type: "session_start" }, context);
    const first = await recordTurn(extension, manager, context, "first", async () => {
      await Bun.write(path.join(root, "tracked.txt"), "first\n");
    });
    const second = await recordTurn(extension, manager, context, "second", async () => {
      await Bun.write(path.join(root, "tracked.txt"), "second\n");
    });
    const editor = { text: "/undo" };
    const notifications: Array<[string, string | undefined]> = [];
    const commands = commandContext(manager, context, editor, notifications);

    await extension.commands.get("undo")?.("", commands);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("first\n");
    expect(manager.getEntry(second)).toBeUndefined();
    await extension.commands.get("undo")?.("", commands);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("baseline\n");
    expect(manager.getEntry(first)).toBeUndefined();
    await extension.commands.get("redo")?.("", commands);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("first\n");
    await extension.commands.get("redo")?.("", commands);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("second\n");

    await extension.commands.get("undo")?.("", commands);
    await recordTurn(extension, manager, context, "replacement", async () => {
      await Bun.write(path.join(root, "tracked.txt"), "replacement\n");
    });
    const replacementLeaf = manager.getLeafId();
    editor.text = "/redo";
    await extension.commands.get("redo")?.("", commands);
    expect(manager.getLeafId()).toBe(replacementLeaf);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("replacement\n");
    expect(
      notifications.some(([message]) => message.includes("There is no user turn to redo")),
    ).toBe(true);
  });

  it("finalizes transcript-only, error, aborted, and shutdown-pending user turns exactly once", async () => {
    const root = await makeRepository();
    const sessionDir = `${root}-sessions`;
    cleanup.push(sessionDir);
    const manager = SessionManager.create(root, sessionDir);
    const extension = loadExtension(manager, dataDirectory(root));
    const context = baseContext(manager, root);
    await extension.handlers.get("session_start")?.({ type: "session_start" }, context);
    const transcriptOnly = await recordTurn(extension, manager, context, "read only");
    const errored = await recordTurn(
      extension,
      manager,
      context,
      "error turn",
      async () => {
        await Bun.write(path.join(root, "tracked.txt"), "error change\n");
      },
      "error",
    );
    const aborted = await recordTurn(
      extension,
      manager,
      context,
      "aborted turn",
      async () => {
        await Bun.write(path.join(root, "tracked.txt"), "aborted change\n");
      },
      "aborted",
    );
    await extension.handlers.get("before_agent_start")?.(
      { type: "before_agent_start", prompt: "shutdown turn", systemPrompt: [] },
      context,
    );
    const shutdown = manager.appendMessage({
      role: "user",
      content: "shutdown turn",
      timestamp: Date.now(),
    });
    await Bun.write(path.join(root, "tracked.txt"), "shutdown change\n");
    await extension.handlers.get("session_shutdown")?.(
      { type: "session_shutdown" },
      context,
    );
    await manager.flush();
    const sourceFile = manager.getSessionFile();
    const sourceLeaf = manager.getLeafId();
    const checkpoints = manager.getEntries().filter(
      (entry) => entry.type === "custom" && entry.customType === "omp.undo-redo.checkpoint.v2",
    );
    expect(checkpoints).toHaveLength(4);
    expect(checkpoints.map((entry) => {
      if (entry.type !== "custom") {
        throw new Error("Checkpoint entry did not retain its custom type.");
      }
      const data = entry.data;
      if (
        !data ||
        typeof data !== "object" ||
        !("userEntryId" in data) ||
        typeof data.userEntryId !== "string"
      ) {
        throw new Error("Checkpoint did not retain its user-entry boundary.");
      }
      return data.userEntryId;
    })).toEqual([
      transcriptOnly,
      errored,
      aborted,
      shutdown,
    ]);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("shutdown change\n");
    expect(await $`git ls-files --stage -- tracked.txt`.cwd(root).text()).toContain("tracked.txt");
    const editor = { text: "/undo" };
    const notifications: Array<[string, string | undefined]> = [];
    const commands = commandContext(manager, context, editor, notifications);
    const index = await $`git ls-files --stage -- tracked.txt`.cwd(root).text();
    const undoPositions: Array<{ sessionFile: string | undefined; leafId: string | null }> = [];
    for (const expected of ["aborted change\n", "error change\n", "baseline\n", "baseline\n"]) {
      await extension.commands.get("undo")?.("", commands);
      expect(manager.getSessionFile()).not.toBe(sourceFile);
      expect(manager.getLeafId()).not.toBe(sourceLeaf);
      undoPositions.push({
        sessionFile: manager.getSessionFile(),
        leafId: manager.getLeafId(),
      });
      expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe(expected);
      expect(await $`git ls-files --stage -- tracked.txt`.cwd(root).text()).toBe(index);
    }
    for (const [redoIndex, expected] of [
      "baseline\n",
      "error change\n",
      "aborted change\n",
      "shutdown change\n",
    ].entries()) {
      await extension.commands.get("redo")?.("", commands);
      const expectedPosition = redoIndex === 3
        ? { sessionFile: sourceFile, leafId: sourceLeaf }
        : undoPositions[2 - redoIndex]!;
      expect({
        sessionFile: manager.getSessionFile(),
        leafId: manager.getLeafId(),
      }).toEqual(expectedPosition);
      expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe(expected);
      expect(await $`git ls-files --stage -- tracked.txt`.cwd(root).text()).toBe(index);
    }
    expect(manager.getSessionFile()).toBe(sourceFile);
    expect(manager.getLeafId()).toBe(sourceLeaf);
  });
  it("leaves the editor, transcript, worktree, and index unchanged for every preflight refusal", async () => {
    const root = await makeRepository();
    const sessionDir = `${root}-sessions`;
    cleanup.push(sessionDir);
    const manager = SessionManager.create(root, sessionDir);
    const extension = loadExtension(manager, dataDirectory(root));
    const context = baseContext(manager, root);
    await extension.handlers.get("session_start")?.({ type: "session_start" }, context);
    await recordTurn(extension, manager, context, "turn", async () => {
      await Bun.write(path.join(root, "tracked.txt"), "turn\n");
      await $`git add tracked.txt`.cwd(root).quiet();
    });
    const sourceFile = manager.getSessionFile();
    const leaf = manager.getLeafId();
    const index = await $`git ls-files --stage -- tracked.txt`.cwd(root).text();
    const editor = { text: "unsent draft" };
    const notifications: Array<[string, string | undefined]> = [];
    for (const refusal of [
      commandContext(manager, context, editor, notifications, { isIdle: () => false }),
      commandContext(manager, context, editor, notifications, { hasPendingMessages: () => true }),
      commandContext(manager, context, editor, notifications, { mode: "json" }),
    ]) {
      await extension.commands.get("undo")?.("", refusal);
      expect(editor.text).toBe("unsent draft");
      expect(manager.getSessionFile()).toBe(sourceFile);
      expect(manager.getLeafId()).toBe(leaf);
      expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("turn\n");
      expect(await $`git ls-files --stage -- tracked.txt`.cwd(root).text()).toBe(index);
    }
    const ready = commandContext(manager, context, editor, notifications);
    await extension.commands.get("undo")?.("", ready);
    const redoFile = manager.getSessionFile();
    const redoLeaf = manager.getLeafId();
    const redoIndex = await $`git ls-files --stage -- tracked.txt`.cwd(root).text();
    editor.text = "unsent redo draft";
    for (const refusal of [
      commandContext(manager, context, editor, notifications, { isIdle: () => false }),
      commandContext(manager, context, editor, notifications, { hasPendingMessages: () => true }),
      commandContext(manager, context, editor, notifications, { mode: "json" }),
    ]) {
      await extension.commands.get("redo")?.("", refusal);
      expect(editor.text).toBe("unsent redo draft");
      expect(manager.getSessionFile()).toBe(redoFile);
      expect(manager.getLeafId()).toBe(redoLeaf);
      expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("baseline\n");
      expect(await $`git ls-files --stage -- tracked.txt`.cwd(root).text()).toBe(redoIndex);
    }
    expect(
      notifications.some(([message]) => message.includes("busy")),
    ).toBe(true);
  });
  it("uses a fresh session at a root-user boundary and preserves the exact redo source leaf", async () => {
    const root = await makeRepository();
    const sessionDir = `${root}-sessions`;
    cleanup.push(sessionDir);
    const manager = SessionManager.create(root, sessionDir);
    const extension = loadExtension(manager, dataDirectory(root));
    const context = baseContext(manager, root);
    await extension.handlers.get("session_start")?.({ type: "session_start" }, context);
    const user = await recordTurn(extension, manager, context, "root turn", async () => {
      await Bun.write(path.join(root, "tracked.txt"), "root change\n");
    });
    const sourceFile = manager.getSessionFile();
    const sourceLeaf = manager.getLeafId();
    let newSessions = 0;
    const editor = { text: "/undo" };
    const notifications: Array<[string, string | undefined]> = [];
    const commands = commandContext(manager, context, editor, notifications, {
      newSession: async (options?: {
        parentSession?: string;
        setup?: (sessionManager: SessionManager) => Promise<void>;
      }) => {
        newSessions += 1;
        await manager.newSession({ parentSession: options?.parentSession });
        await options?.setup?.(manager);
        return { cancelled: false };
      },
    });

    await extension.commands.get("undo")?.("", commands);
    expect(newSessions).toBe(1);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("baseline\n");
    expect(manager.getEntry(user)).toBeUndefined();
    await extension.commands.get("redo")?.("", commands);
    expect(manager.getSessionFile()).toBe(sourceFile);
    expect(manager.getLeafId()).toBe(sourceLeaf);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("root change\n");
  });

  it("blocks only a running descendant subagent, not idle, parked, aborted, advisor, or unrelated agents", async () => {
    const root = await makeRepository();
    const sessionDir = `${root}-sessions`;
    cleanup.push(sessionDir);
    const manager = SessionManager.create(root, sessionDir);
    const extension = loadExtension(manager, dataDirectory(root));
    const context = baseContext(manager, root);
    await extension.handlers.get("session_start")?.({ type: "session_start" }, context);
    await recordTurn(extension, manager, context, "turn", async () => {
      await Bun.write(path.join(root, "tracked.txt"), "turn\n");
    });
    const leaf = manager.getLeafId();
    const sourceFile = manager.getSessionFile();
    const index = await $`git ls-files --stage -- tracked.txt`.cwd(root).text();
    const editor = { text: "/undo" };
    const notifications: Array<[string, string | undefined]> = [];
    const commands = commandContext(manager, context, editor, notifications);
    const registry = AgentRegistry.global();
    registry.register({
      id: "Main",
      displayName: "Main",
      kind: "main",
      parentId: undefined,
      status: "idle",
      session: null,
      sessionFile: manager.getSessionFile(),
    });
    registry.register({
      id: "working-child",
      displayName: "working child",
      kind: "sub",
      parentId: "Main",
      status: "running",
      session: null,
    });
    await extension.commands.get("undo")?.("", commands);
    expect(manager.getLeafId()).toBe(leaf);
    expect(manager.getSessionFile()).toBe(sourceFile);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("turn\n");
    expect(await $`git ls-files --stage -- tracked.txt`.cwd(root).text()).toBe(index);
    expect(editor.text).toBe("/undo");

    AgentRegistry.resetGlobalForTests();
    const harmless = AgentRegistry.global();
    harmless.register({
      id: "Main",
      displayName: "Main",
      kind: "main",
      parentId: undefined,
      status: "idle",
      session: null,
      sessionFile: manager.getSessionFile(),
    });
    for (const [id, kind, parentId, status] of [
      ["idle-child", "sub", "Main", "idle"],
      ["parked-child", "sub", "Main", "parked"],
      ["aborted-child", "sub", "Main", "aborted"],
      ["advisor", "advisor", "Main", "running"],
      ["unrelated", "sub", "Other", "running"],
    ] as const) {
      harmless.register({
        id,
        displayName: id,
        kind,
        parentId,
        status,
        session: null,
      });
    }
    await extension.commands.get("undo")?.("", commands);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("baseline\n");
    expect(manager.getLeafId()).not.toBeNull();
  });

  it("compensates workspace and transcript after a selective restore failure", async () => {
    const root = await makeRepository();
    const sessionDir = `${root}-sessions`;
    cleanup.push(sessionDir);
    const manager = SessionManager.create(root, sessionDir);
    let failRestore = false;
    const extension = loadExtension(manager, dataDirectory(root), async (command, args, options) => {
      if (failRestore && effectiveGitArgs(command, args)[0] === "checkout-index") {
        failRestore = false;
        return { stdout: "", stderr: "injected restore failure", code: 1, killed: false };
      }
      return exec(command, args, options);
    });
    const context = baseContext(manager, root);
    await extension.handlers.get("session_start")?.({ type: "session_start" }, context);
    await recordTurn(extension, manager, context, "turn", async () => {
      await Bun.write(path.join(root, "tracked.txt"), "turn\n");
      await $`git add tracked.txt`.cwd(root).quiet();
      await Bun.write(path.join(root, "tracked.txt"), "turn worktree\n");
    });
    const originalFile = manager.getSessionFile();
    const originalLeaf = manager.getLeafId();
    const originalIndex = await $`git ls-files --stage -- tracked.txt`.cwd(root).text();
    const editor = { text: "draft" };
    const notifications: Array<[string, string | undefined]> = [];
    const commands = commandContext(manager, context, editor, notifications);
    failRestore = true;

    await extension.commands.get("undo")?.("", commands);
    expect(manager.getSessionFile()).toBe(originalFile);
    expect(manager.getLeafId()).toBe(originalLeaf);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("turn worktree\n");
    expect(await $`git ls-files --stage -- tracked.txt`.cwd(root).text()).toBe(originalIndex);
    expect(editor.text).toBe("draft");
    expect(
      notifications.some(([message]) => message.includes("Failed to undo last user turn")),
    ).toBe(true);
  });

  it("recovers each durable journal phase without dropping rollback metadata", async () => {
    const root = await makeRepository();
    const sessionDir = `${root}-sessions`;
    cleanup.push(sessionDir);
    const manager = SessionManager.create(root, sessionDir);
    const dataDir = dataDirectory(root);
    const extension = loadExtension(manager, dataDir);
    const context = baseContext(manager, root);
    await extension.handlers.get("session_start")?.({ type: "session_start" }, context);
    await recordTurn(extension, manager, context, "turn", async () => {
      await Bun.write(path.join(root, "tracked.txt"), "turn\n");
    });
    const checkpointEntry = manager.getEntries().find(
      (entry) => entry.type === "custom" && entry.customType === "omp.undo-redo.checkpoint.v2",
    );
    if (!checkpointEntry || checkpointEntry.type !== "custom") {
      throw new Error("Expected a durable checkpoint.");
    }
    const checkpoint = checkpointEntry.data as TurnCheckpointV2;
    const rootSessionId = checkpoint.rootSessionId;
    const position = {
      sessionFile: manager.getSessionFile()!,
      leafId: manager.getLeafId(),
    };
    const editor = { text: "/undo" };
    const notifications: Array<[string, string | undefined]> = [];
    const commands = commandContext(manager, context, editor, notifications);
    const rollbackHistory = new WorkspaceHistory(
      { exec } as unknown as ExtensionAPI,
      dataDir,
    );
    const sourceIndex = await $`git ls-files --stage -- tracked.txt`.cwd(root).text();

    for (const phase of ["prepared", "transcript-moved", "workspace-restored"] as const) {
      const rollback = await rollbackHistory.capture(
        [root],
        rootSessionId,
        `interrupted-${phase}`,
        "rollback",
      );
      await writeJournal(dataDir, rootSessionId, {
        version: 1,
        rootSessionId,
        direction: "undo",
        turnId: checkpoint.id,
        original: position,
        target: position,
        rollback,
        workspaces: checkpoint.workspaces,
        phase,
      });
      const persisted = await readJournal(dataDir, rootSessionId);
      expect(persisted?.rollback.map(({ refName }) => refName)).toEqual(
        rollback.map(({ refName }) => refName),
      );
      await extension.commands.get("undo")?.("", commands);
      expect(await readJournal(dataDir, rootSessionId)).toBeUndefined();
      expect(manager.getSessionFile()).not.toBe(position.sessionFile);
      expect(manager.getLeafId()).not.toBe(position.leafId);
      expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("baseline\n");
      expect(await $`git ls-files --stage -- tracked.txt`.cwd(root).text()).toBe(sourceIndex);
      await extension.commands.get("redo")?.("", commands);
      expect(manager.getSessionFile()).toBe(position.sessionFile);
      expect(manager.getLeafId()).toBe(position.leafId);
    }

    for (const phase of ["prepared", "transcript-moved", "workspace-restored"] as const) {
      const rollback = await rollbackHistory.capture(
        [root],
        rootSessionId,
        `unresolved-${phase}`,
        "rollback",
      );
      const corruptWorkspaces = checkpoint.workspaces.map((workspace) => ({
        ...workspace,
        after: { ...workspace.after, refName: "refs/omp/undo/missing-recovery-ref" },
      }));
      await writeJournal(dataDir, rootSessionId, {
        version: 1,
        rootSessionId,
        direction: "undo",
        turnId: checkpoint.id,
        original: position,
        target: position,
        rollback,
        workspaces: corruptWorkspaces,
        phase,
      });
      editor.text = `draft-${phase}`;
      await extension.commands.get("undo")?.("", commands);
      const unresolved = await readJournal(dataDir, rootSessionId);
      expect(unresolved?.phase).toBe(phase);
      expect(unresolved?.rollback.map(({ refName }) => refName)).toEqual(
        rollback.map(({ refName }) => refName),
      );
      expect(await rollbackHistory.available(rollback)).toBe(true);
      expect(manager.getSessionFile()).toBe(position.sessionFile);
      expect(manager.getLeafId()).toBe(position.leafId);
      expect(editor.text).toBe(`draft-${phase}`);
      expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("turn\n");
      expect(await $`git ls-files --stage -- tracked.txt`.cwd(root).text()).toBe(sourceIndex);
    }
  });
  it("reconstructs persisted history after extension restart and resumes undo redo at the same leaf", async () => {
    const root = await makeRepository();
    const sessionDir = `${root}-sessions`;
    cleanup.push(sessionDir);
    const manager = SessionManager.create(root, sessionDir);
    const dataDir = dataDirectory(root);
    const firstExtension = loadExtension(manager, dataDir);
    const context = baseContext(manager, root);
    await firstExtension.handlers.get("session_start")?.({ type: "session_start" }, context);
    const user = await recordTurn(firstExtension, manager, context, "persisted", async () => {
      await Bun.write(path.join(root, "tracked.txt"), "persisted\n");
    });
    await manager.flush();
    const sourceFile = manager.getSessionFile();
    const sourceLeaf = manager.getLeafId();
    const resumedExtension = loadExtension(manager, dataDir);
    await resumedExtension.handlers.get("session_start")?.({ type: "session_start" }, context);
    const editor = { text: "/undo" };
    const notifications: Array<[string, string | undefined]> = [];
    const commands = commandContext(manager, context, editor, notifications);

    await resumedExtension.commands.get("undo")?.("", commands);
    expect(manager.getEntry(user)).toBeUndefined();
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("baseline\n");
    await resumedExtension.commands.get("redo")?.("", commands);
    expect(manager.getSessionFile()).toBe(sourceFile);
    expect(manager.getLeafId()).toBe(sourceLeaf);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("persisted\n");
  });
  it("compensates an already restored repository when a later configured repository fails", async () => {
    const root = await makeRepository();
    const second = await makeRepository();
    const sessionDir = `${root}-sessions`;
    cleanup.push(sessionDir);
    const manager = SessionManager.create(root, sessionDir);
    const header = manager.getHeader();
    if (!header) throw new Error("Session header is required for multi-root capture.");
    header.additionalDirectories = [second];
    let failSecond = false;
    const extension = loadExtension(manager, dataDirectory(root), async (command, args, options) => {
      if (
        failSecond &&
        options?.cwd === second &&
        effectiveGitArgs(command, args)[0] === "checkout-index"
      ) {
        failSecond = false;
        return { stdout: "", stderr: "second repository failure", code: 1, killed: false };
      }
      return exec(command, args, options);
    });
    const context = baseContext(manager, root);
    await extension.handlers.get("session_start")?.({ type: "session_start" }, context);
    await recordTurn(extension, manager, context, "two roots", async () => {
      await Bun.write(path.join(root, "tracked.txt"), "root turn\n");
      await Bun.write(path.join(second, "tracked.txt"), "second turn\n");
    });
    const sourceFile = manager.getSessionFile();
    const sourceLeaf = manager.getLeafId();
    const editor = { text: "draft" };
    const notifications: Array<[string, string | undefined]> = [];
    failSecond = true;
    await extension.commands.get("undo")?.(
      "",
      commandContext(manager, context, editor, notifications),
    );
    expect(manager.getSessionFile()).toBe(sourceFile);
    expect(manager.getLeafId()).toBe(sourceLeaf);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("root turn\n");
    expect(await Bun.file(path.join(second, "tracked.txt")).text()).toBe("second turn\n");
    expect(await $`git ls-files --stage -- tracked.txt`.cwd(root).text()).toContain("tracked.txt");
    expect(await $`git ls-files --stage -- tracked.txt`.cwd(second).text()).toContain("tracked.txt");
    expect(editor.text).toBe("draft");
  });
  it("retains a sticky HEAD through multiple undos and redos of committed turns", async () => {
    const root = await makeRepository();
    const sessionDir = `${root}-sessions`;
    cleanup.push(sessionDir);
    const manager = SessionManager.create(root, sessionDir);
    const extension = loadExtension(manager, dataDirectory(root));
    const context = baseContext(manager, root);
    await extension.handlers.get("session_start")?.({ type: "session_start" }, context);
    await recordTurn(extension, manager, context, "commit one", async () => {
      await Bun.write(path.join(root, "tracked.txt"), "one\n");
      await $`git add tracked.txt && git commit -m one`.cwd(root).quiet();
    });
    await recordTurn(extension, manager, context, "commit two", async () => {
      await Bun.write(path.join(root, "tracked.txt"), "two\n");
      await $`git add tracked.txt && git commit -m two`.cwd(root).quiet();
    });
    const stickyHead = (await $`git rev-parse HEAD`.cwd(root).text()).trim();
    const editor = { text: "/undo" };
    const notifications: Array<[string, string | undefined]> = [];
    const commands = commandContext(manager, context, editor, notifications);

    await extension.commands.get("undo")?.("", commands);
    expect((await $`git rev-parse HEAD`.cwd(root).text()).trim()).toBe(stickyHead);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("one\n");
    await extension.commands.get("undo")?.("", commands);
    expect((await $`git rev-parse HEAD`.cwd(root).text()).trim()).toBe(stickyHead);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("baseline\n");
    await extension.commands.get("redo")?.("", commands);
    expect((await $`git rev-parse HEAD`.cwd(root).text()).trim()).toBe(stickyHead);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("one\n");
    await extension.commands.get("redo")?.("", commands);
    expect((await $`git rev-parse HEAD`.cwd(root).text()).trim()).toBe(stickyHead);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("two\n");
  });
  it("uses navigateTree at a skill-prompt transcript boundary and redoes its exact leaf", async () => {
    const root = await makeRepository();
    const sessionDir = `${root}-sessions`;
    cleanup.push(sessionDir);
    const manager = SessionManager.create(root, sessionDir);
    const extension = loadExtension(manager, dataDirectory(root));
    const context = baseContext(manager, root);
    await extension.handlers.get("session_start")?.({ type: "session_start" }, context);
    await recordTurn(extension, manager, context, "ordinary", async () => {
      await Bun.write(path.join(root, "tracked.txt"), "ordinary\n");
    });
    await extension.handlers.get("before_agent_start")?.(
      {
        type: "before_agent_start",
        prompt: "skill turn",
        systemPrompt: [],
      },
      context,
    );
    const skillUser = manager.appendMessage({
      role: "custom",
      customType: "skill-prompt",
      attribution: "user",
      content: "skill turn",
      display: true,
      timestamp: Date.now(),
    });
    await Bun.write(path.join(root, "tracked.txt"), "skill\n");
    appendAssistant(manager);
    await extension.handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, context);
    const sourceFile = manager.getSessionFile();
    const sourceLeaf = manager.getLeafId();
    let navigatedTo: string | undefined;
    const skillBoundary = manager.getEntry(skillUser)?.parentId;
    if (!skillBoundary) throw new Error("Expected a non-root skill transcript boundary.");
    let navigated = false;
    const editor = { text: "/undo" };
    const notifications: Array<[string, string | undefined]> = [];
    const commands = commandContext(manager, context, editor, notifications, {
      navigateTree: async (targetId: string) => {
        navigatedTo = targetId;
        navigated = true;
        manager.createBranchedSession(targetId);
        return { cancelled: false };
      },
    });

    await extension.commands.get("undo")?.("", commands);
    expect(navigatedTo).toBe(skillBoundary);
    expect(manager.getEntry(skillUser)).toBeUndefined();
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("ordinary\n");
    await extension.commands.get("redo")?.("", commands);
    expect(manager.getSessionFile()).toBe(sourceFile);
    expect(manager.getLeafId()).toBe(sourceLeaf);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("skill\n");
  });
  it("an ordinary user turn with <skills> in the system prompt branches normally", async () => {
    const root = await makeRepository();
    const sessionDir = `${root}-sessions`;
    cleanup.push(sessionDir);
    const manager = SessionManager.create(root, sessionDir);
    const extension = loadExtension(manager, dataDirectory(root));
    const context = baseContext(manager, root);
    await extension.handlers.get("session_start")?.({ type: "session_start" }, context);

    await extension.handlers.get("before_agent_start")?.(
      {
        type: "before_agent_start",
        prompt: "first turn",
        systemPrompt: ["<skills>fake</skills>"],
      },
      context,
    );
    const firstUser = manager.appendMessage({
      role: "user",
      content: "first turn",
      timestamp: Date.now(),
    });
    await Bun.write(path.join(root, "tracked.txt"), "first\n");
    appendAssistant(manager);
    await extension.handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, context);
    const firstLeaf = manager.getLeafId();
    const firstSessionFile = manager.getSessionFile();

    await extension.handlers.get("before_agent_start")?.(
      {
        type: "before_agent_start",
        prompt: "second turn",
        systemPrompt: ["<skills>fake</skills>"],
      },
      context,
    );
    const secondUser = manager.appendMessage({
      role: "user",
      content: "second turn",
      timestamp: Date.now(),
    });
    await Bun.write(path.join(root, "tracked.txt"), "second\n");
    appendAssistant(manager);
    await extension.handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, context);
    const secondLeaf = manager.getLeafId();
    const secondSessionFile = manager.getSessionFile();

    let branchedTo: string | undefined;
    const editor = { text: "/undo" };
    const notifications: Array<[string, string | undefined]> = [];
    const commands = commandContext(manager, context, editor, notifications, {
      branch: async (targetId: string) => {
        branchedTo = targetId;
        manager.createBranchedSession(targetId);
        return { cancelled: false };
      },
      navigateTree: async () => {
        throw new Error("Should not navigate tree for ordinary turn");
      }
    });

    await extension.commands.get("undo")?.("", commands);
    expect(branchedTo).toBe(secondUser);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("first\n");

    branchedTo = undefined;
    const expectedRedoSession = manager.getSessionFile();
    const expectedRedoLeaf = manager.getLeafId();
    await extension.commands.get("undo")?.("", commands);
    expect(branchedTo).toBe(undefined);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("baseline\n");

    await extension.commands.get("redo")?.("", commands);
    expect(manager.getSessionFile()).toBe(expectedRedoSession);
    expect(manager.getLeafId()).toBe(expectedRedoLeaf);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("first\n");

    await extension.commands.get("redo")?.("", commands);
    expect(manager.getSessionFile()).toBe(secondSessionFile);
    expect(manager.getLeafId()).toBe(secondLeaf);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("second\n");
  });
});
