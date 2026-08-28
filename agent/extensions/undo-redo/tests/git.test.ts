import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { $ } from "bun";
import { WorkspaceHistory, type WorkspaceSnapshot } from "../git.ts";
import { writeJournal } from "../journal.ts";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

async function repository(files: Record<string, string> = {}): Promise<string> {
  const root = await fs.mkdtemp("/tmp/omp-undo-redo-git-");
  cleanup.push(root);
  await Bun.write(path.join(root, ".gitignore"), "ignored.log\n");
  await Bun.write(path.join(root, "tracked.txt"), "baseline\n");
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await Bun.write(absolute, content);
  }
  await $`git init --initial-branch=main && git config user.email tester@example.com && git config user.name Tester && git add -A && git commit -m baseline`
    .cwd(root)
    .quiet();
  return root;
}

function dataDirectory(root: string): string {
  const directory = `${root}-data`;
  cleanup.push(directory);
  return directory;
}

function exec(command: string, args: string[], options?: { cwd?: string; timeout?: number }) {
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

function history(root: string, run = exec): WorkspaceHistory {
  return new WorkspaceHistory({ exec: run } as unknown as ExtensionAPI, dataDirectory(root));
}

async function indexText(root: string, file: string): Promise<string | undefined> {
  const result = await exec("git", ["show", `:${file}`], { cwd: root });
  return result.code === 0 ? result.stdout : undefined;
}

async function indexMode(root: string, file: string): Promise<string | undefined> {
  const result = await exec("git", ["ls-files", "--stage", "--", file], { cwd: root });
  return result.stdout ? result.stdout.split(" ")[0] : undefined;
}

async function head(root: string): Promise<string> {
  return (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
}

describe("WorkspaceHistory selective snapshots", () => {
  it("round-trips staged, unstaged, untracked, deleted, and executable paths without ignored files", async () => {
    const root = await repository({ "delete.txt": "delete me\n", "mode.sh": "#!/bin/sh\necho baseline\n" });
    await fs.chmod(path.join(root, "mode.sh"), 0o755);
    await $`git add mode.sh && git commit -m executable`.cwd(root).quiet();
    const workspace = history(root);
    const before = await workspace.capture([root], "session", "round-trip", "before");

    await Bun.write(path.join(root, "tracked.txt"), "staged\n");
    await $`git add tracked.txt`.cwd(root).quiet();
    await Bun.write(path.join(root, "tracked.txt"), "unstaged\n");
    await Bun.write(path.join(root, "untracked.txt"), "untracked\n");
    await fs.rm(path.join(root, "delete.txt"));
    await fs.chmod(path.join(root, "mode.sh"), 0o644);
    await Bun.write(path.join(root, "ignored.log"), "leave me\n");
    const after = await workspace.capture([root], "session", "round-trip", "after");
    const [delta] = await workspace.deltas(before, after);

    await workspace.restoreAllPaths([delta!], "before");
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("baseline\n");
    expect(await indexText(root, "tracked.txt")).toBe("baseline\n");
    expect(await Bun.file(path.join(root, "untracked.txt")).exists()).toBe(false);
    expect(await Bun.file(path.join(root, "delete.txt")).text()).toBe("delete me\n");
    expect((await fs.stat(path.join(root, "mode.sh"))).mode & 0o111).toBeGreaterThan(0);
    expect(await Bun.file(path.join(root, "ignored.log")).text()).toBe("leave me\n");

    await workspace.restoreAllPaths([delta!], "after");
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("unstaged\n");
    expect(await indexText(root, "tracked.txt")).toBe("staged\n");
    expect(await Bun.file(path.join(root, "untracked.txt")).text()).toBe("untracked\n");
    expect(await Bun.file(path.join(root, "delete.txt")).exists()).toBe(false);
    expect(await indexMode(root, "mode.sh")).toBe("100644");
    expect(await Bun.file(path.join(root, "ignored.log")).text()).toBe("leave me\n");
  });

  it("preserves unrelated worktree and index edits and detects affected-path divergence", async () => {
    const root = await repository({ "other.txt": "other baseline\n" });
    const workspace = history(root);
    const before = await workspace.capture([root], "session", "selective", "before");
    await Bun.write(path.join(root, "tracked.txt"), "turn\n");
    const after = await workspace.capture([root], "session", "selective", "after");
    const [delta] = await workspace.deltas(before, after);

    await Bun.write(path.join(root, "other.txt"), "manual staged\n");
    await $`git add other.txt`.cwd(root).quiet();
    await Bun.write(path.join(root, "manual.txt"), "manual worktree\n");
    await workspace.restoreAllPaths([delta!], "before");
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("baseline\n");
    expect(await Bun.file(path.join(root, "other.txt")).text()).toBe("manual staged\n");
    expect(await indexText(root, "other.txt")).toBe("manual staged\n");
    expect(await Bun.file(path.join(root, "manual.txt")).text()).toBe("manual worktree\n");

    await workspace.restoreAllPaths([delta!], "after");
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("turn\n");
    expect(await indexText(root, "other.txt")).toBe("manual staged\n");
    await Bun.write(path.join(root, "tracked.txt"), "conflict\n");
    await expect(workspace.matchPaths(delta!.after, delta!.changedPaths)).resolves.toEqual({
      matches: false,
      paths: ["tracked.txt"],
    });
  });

  it("round-trips file-directory and directory-file shape transitions", async () => {
    const root = await repository({ shape: "file\n", "reverse/child.txt": "child\n" });
    const workspace = history(root);
    const beforeFile = await workspace.capture([root], "session", "file-to-directory", "before");
    await fs.rm(path.join(root, "shape"));
    await fs.mkdir(path.join(root, "shape"));
    await Bun.write(path.join(root, "shape", "child.txt"), "directory\n");
    const afterDirectory = await workspace.capture([root], "session", "file-to-directory", "after");
    const [fileToDirectory] = await workspace.deltas(beforeFile, afterDirectory);
    await workspace.restoreAllPaths([fileToDirectory!], "before");
    expect(await Bun.file(path.join(root, "shape")).text()).toBe("file\n");
    await workspace.restoreAllPaths([fileToDirectory!], "after");
    expect(await Bun.file(path.join(root, "shape", "child.txt")).text()).toBe("directory\n");

    const beforeDirectory = await workspace.capture([root], "session", "directory-to-file", "before");
    await fs.rm(path.join(root, "reverse"), { recursive: true });
    await Bun.write(path.join(root, "reverse"), "file\n");
    const afterFile = await workspace.capture([root], "session", "directory-to-file", "after");
    const [directoryToFile] = await workspace.deltas(beforeDirectory, afterFile);
    await workspace.restoreAllPaths([directoryToFile!], "before");
    expect(await Bun.file(path.join(root, "reverse", "child.txt")).text()).toBe("child\n");
    await workspace.restoreAllPaths([directoryToFile!], "after");
    expect(await Bun.file(path.join(root, "reverse")).text()).toBe("file\n");
  });

  it("restores rename and copy path unions in both the index and worktree", async () => {
    const root = await repository({ "old.txt": "old\n" });
    const workspace = history(root);
    const before = await workspace.capture([root], "session", "rename-copy", "before");
    await fs.rename(path.join(root, "old.txt"), path.join(root, "renamed.txt"));
    await fs.copyFile(path.join(root, "renamed.txt"), path.join(root, "copied.txt"));
    await $`git add -A`.cwd(root).quiet();
    const after = await workspace.capture([root], "session", "rename-copy", "after");
    const [delta] = await workspace.deltas(before, after);
    expect(delta!.changedPaths).toEqual(["copied.txt", "old.txt", "renamed.txt"]);

    await workspace.restoreAllPaths([delta!], "before");
    expect(await Bun.file(path.join(root, "old.txt")).text()).toBe("old\n");
    expect(await Bun.file(path.join(root, "renamed.txt")).exists()).toBe(false);
    expect(await indexText(root, "old.txt")).toBe("old\n");
    await workspace.restoreAllPaths([delta!], "after");
    expect(await Bun.file(path.join(root, "renamed.txt")).text()).toBe("old\n");
    expect(await Bun.file(path.join(root, "copied.txt")).text()).toBe("old\n");
    expect(await indexText(root, "renamed.txt")).toBe("old\n");
    expect(await indexText(root, "copied.txt")).toBe("old\n");
  });

  it("keeps linked worktrees and separate repositories independent", async () => {
    const root = await repository();
    const linked = `${root}-linked`;
    cleanup.push(linked);
    await $`git worktree add -b linked-branch ${linked}`.cwd(root).quiet();
    const other = await repository();
    const workspace = history(root);
    const before = await workspace.capture([root, linked, other], "session", "roots", "before");
    await Bun.write(path.join(root, "tracked.txt"), "main\n");
    await Bun.write(path.join(linked, "tracked.txt"), "linked\n");
    await Bun.write(path.join(other, "tracked.txt"), "other\n");
    const after = await workspace.capture([root, linked, other], "session", "roots", "after");
    const deltas = await workspace.deltas(before, after);

    await workspace.restoreAllPaths(deltas, "before");
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("baseline\n");
    expect(await Bun.file(path.join(linked, "tracked.txt")).text()).toBe("baseline\n");
    expect(await Bun.file(path.join(other, "tracked.txt")).text()).toBe("baseline\n");
    await workspace.restoreAllPaths(deltas, "after");
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("main\n");
    expect(await Bun.file(path.join(linked, "tracked.txt")).text()).toBe("linked\n");
    expect(await Bun.file(path.join(other, "tracked.txt")).text()).toBe("other\n");
  });

  it("does not move HEAD while restoring a turn that includes a commit", async () => {
    const root = await repository();
    const workspace = history(root);
    const before = await workspace.capture([root], "session", "committed", "before");
    await Bun.write(path.join(root, "tracked.txt"), "committed turn\n");
    await $`git add tracked.txt && git commit -m turn`.cwd(root).quiet();
    const committedHead = await head(root);
    const after = await workspace.capture([root], "session", "committed", "after");
    const [delta] = await workspace.deltas(before, after);

    await workspace.restoreAllPaths([delta!], "before");
    expect(await head(root)).toBe(committedHead);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("baseline\n");
    expect(await indexText(root, "tracked.txt")).toBe("baseline\n");
    await workspace.restoreAllPaths([delta!], "after");
    expect(await head(root)).toBe(committedHead);
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("committed turn\n");
    expect(await indexText(root, "tracked.txt")).toBe("committed turn\n");
  });

  it("replays the durable catalog, expires only stale checkpoints, and keeps the valid checkpoint usable", async () => {
    const root = await repository();
    const dataDir = dataDirectory(root);
    let now = 100;
    const retention = {
      now: () => now,
      maxSnapshotAgeMs: 10,
      maxTurnsPerRootSession: 10,
      maxDataBytes: Number.MAX_SAFE_INTEGER,
      gcIntervalMs: 1,
    };
    const workspace = new WorkspaceHistory(
      { exec } as unknown as ExtensionAPI,
      dataDir,
      retention,
    );
    const staleBefore = await workspace.capture([root], "root", "stale", "before");
    await Bun.write(path.join(root, "tracked.txt"), "stale\n");
    const staleAfter = await workspace.capture([root], "root", "stale", "after");
    await workspace.recordDurableCheckpoint(
      "root",
      "stale",
      "/sessions/stale.jsonl",
      [...staleBefore, ...staleAfter],
    );
    expect(await Bun.file(path.join(dataDir, "checkpoints.jsonl")).exists()).toBe(true);

    now = 111;
    const freshBefore = await workspace.capture([root], "root", "fresh", "before");
    await Bun.write(path.join(root, "tracked.txt"), "fresh\n");
    const freshAfter = await workspace.capture([root], "root", "fresh", "after");
    await workspace.recordDurableCheckpoint(
      "root",
      "fresh",
      "/sessions/fresh.jsonl",
      [...freshBefore, ...freshAfter],
    );

    const replayed = new WorkspaceHistory(
      { exec } as unknown as ExtensionAPI,
      dataDir,
      retention,
    );
    await replayed.collectGarbage(true);
    expect(await replayed.available([...staleBefore, ...staleAfter])).toBe(false);
    expect(await replayed.available([...freshBefore, ...freshAfter])).toBe(true);

    const freshDeltas = await replayed.deltas(freshBefore, freshAfter);
    await replayed.restoreAllPaths(freshDeltas, "before");
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("stale\n");
    await replayed.restoreAllPaths(freshDeltas, "after");
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("fresh\n");

    const capped = new WorkspaceHistory(
      { exec } as unknown as ExtensionAPI,
      dataDir,
      { ...retention, maxDataBytes: 1 },
    );
    await expect(
      capped.capture([root], "root", "refused-by-total-cap", "before"),
    ).rejects.toThrow(/private storage limit/i);
    expect(await replayed.available([...freshBefore, ...freshAfter])).toBe(true);
  });

  it("keeps expired durable refs required by an unresolved journal", async () => {
    const root = await repository();
    const dataDir = dataDirectory(root);
    let now = 0;
    const retention = {
      now: () => now,
      maxSnapshotAgeMs: 1,
      maxTurnsPerRootSession: 10,
      maxDataBytes: Number.MAX_SAFE_INTEGER,
      gcIntervalMs: 1,
    };
    const workspace = new WorkspaceHistory(
      { exec } as unknown as ExtensionAPI,
      dataDir,
      retention,
    );
    const before = await workspace.capture([root], "root", "protected", "before");
    await Bun.write(path.join(root, "tracked.txt"), "protected\n");
    const after = await workspace.capture([root], "root", "protected", "after");
    const deltas = await workspace.deltas(before, after);
    await workspace.recordDurableCheckpoint(
      "root",
      "protected",
      "/sessions/protected.jsonl",
      [...before, ...after],
    );
    await writeJournal(dataDir, "root", {
      rootSessionId: "root",
      direction: "undo",
      turnId: "protected",
      original: { sessionFile: "/sessions/protected.jsonl", leafId: null },
      target: null,
      rollback: before,
      workspaces: deltas,
      phase: "prepared",
    });

    now = 2;
    await new WorkspaceHistory(
      { exec } as unknown as ExtensionAPI,
      dataDir,
      retention,
    ).collectGarbage(true);
    expect(await workspace.available([...before, ...after])).toBe(true);
  });

  it("rejects missing and corrupt private refs before mutating the worktree or index", async () => {
    const root = await repository();
    const dataDir = dataDirectory(root);
    const workspace = new WorkspaceHistory(
      { exec } as unknown as ExtensionAPI,
      dataDir,
    );
    const before = await workspace.capture([root], "session", "bad-ref", "before");
    await Bun.write(path.join(root, "tracked.txt"), "after\n");
    const after = await workspace.capture([root], "session", "bad-ref", "after");
    const [delta] = await workspace.deltas(before, after);
    const missingRef = {
      ...delta!.before,
      refName: "refs/omp/undo/missing",
    } as WorkspaceSnapshot;
    await expect(workspace.restorePaths(missingRef, delta!.changedPaths)).rejects.toThrow(
      "missing",
    );
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("after\n");
    expect(await indexText(root, "tracked.txt")).toBe("baseline\n");

    const store = path.join(
      dataDir,
      Bun.hash.wyhash(delta!.before.commonDir).toString(16),
    );
    const treeEntry = await exec(
      "git",
      ["--git-dir", store, "ls-tree", delta!.before.worktreeTree, "--", "tracked.txt"],
    );
    const blob = treeEntry.stdout.trim().split(/\s+/)[2];
    expect(blob).toMatch(/^[0-9a-f]{40,64}$/);
    await exec(
      "git",
      ["--git-dir", store, "update-ref", delta!.before.refName, blob!],
    );
    expect(await workspace.available([delta!.before])).toBe(true);
    await expect(workspace.restorePaths(delta!.before, delta!.changedPaths)).rejects.toThrow();
    expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("after\n");
    expect(await indexText(root, "tracked.txt")).toBe("baseline\n");
  });
});
