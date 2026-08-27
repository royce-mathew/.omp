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
import { createUndoRedoExtension } from "../index.ts";

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

function loadExtension(
  manager: SessionManager,
  dataDir: string,
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
    exec,
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
    await Bun.write(path.join(root, "tracked.txt"), "manual\n");
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
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe(
      "manual\n",
    );
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
});
