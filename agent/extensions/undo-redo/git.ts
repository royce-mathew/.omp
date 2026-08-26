import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const GIT_TIMEOUT_MS = 5 * 60 * 1000;
const PRIVATE_REF_PREFIX = "refs/omp/undo/";
const lockChains = new Map<string, Promise<unknown>>();

export interface WorkspaceSnapshot {
  repositoryRoot: string;
  commonDir: string;
  head: string;
  indexTree: string;
  worktreeTree: string;
  refName: string;
}

export type SnapshotMatch =
  { matches: true } | { matches: false; paths: string[] };

export type ResolvedWorkspace =
  | {
      ok: true;
      repositories: Array<{ repositoryRoot: string; commonDir: string }>;
    }
  | { ok: false; root: string; message: string };

function repositoryHash(commonDir: string): string {
  return Bun.hash.wyhash(commonDir).toString(16);
}

function storePath(dataDir: string, commonDir: string): string {
  return path.join(dataDir, repositoryHash(commonDir));
}

function safeRefPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-") || "unknown";
}

function validateRef(refName: string): void {
  if (
    !refName.startsWith(PRIVATE_REF_PREFIX) ||
    refName.includes("..") ||
    refName.endsWith("/") ||
    !/^refs\/[A-Za-z0-9._/-]+$/.test(refName)
  ) {
    throw new Error(`Invalid undo snapshot ref: ${refName}`);
  }
}

async function run(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  allowFailure = false,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const pinnedEnv: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_PAGER: "cat",
    ...env,
  };
  const commandArgs = [
    ...Object.entries(pinnedEnv).map(([key, value]) => `${key}=${value}`),
    "git",
    ...args,
  ];
  const result = await pi.exec("env", commandArgs, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
  });
  if (!allowFailure && result.code !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `git ${args.join(" ")} failed (${result.code})`,
    );
  }
  return result;
}

async function text(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<string> {
  return (await run(pi, cwd, args, env)).stdout;
}

async function withLock<T>(
  commonDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = await fs.realpath(commonDir);
  const prior = lockChains.get(key);
  const current = (async () => {
    if (prior) {
      try {
        await prior;
      } catch {
        // A failed operation must not poison the repository queue.
      }
    }
    return operation();
  })();
  lockChains.set(key, current);
  try {
    return await current;
  } finally {
    if (lockChains.get(key) === current) lockChains.delete(key);
  }
}

async function resolveRepository(
  pi: ExtensionAPI,
  configuredRoot: string,
): Promise<{ repositoryRoot: string; commonDir: string; head: string } | null> {
  const root = path.resolve(configuredRoot);
  const topLevel = await run(
    pi,
    root,
    ["rev-parse", "--show-toplevel"],
    {},
    true,
  );
  if (topLevel.code !== 0) return null;
  const repositoryRoot = path.resolve(topLevel.stdout.trim());
  const common = await text(pi, repositoryRoot, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const commonDir = await fs.realpath(common.trim());
  const headResult = await run(
    pi,
    repositoryRoot,
    ["rev-parse", "HEAD"],
    {},
    true,
  );
  const head = headResult.code === 0 ? headResult.stdout.trim() : "";
  return head ? { repositoryRoot, commonDir, head } : null;
}

export async function resolveWorkspace(
  pi: ExtensionAPI,
  roots: readonly string[],
): Promise<ResolvedWorkspace> {
  const repositories = new Map<
    string,
    { repositoryRoot: string; commonDir: string }
  >();
  for (const configuredRoot of roots) {
    const root = path.resolve(configuredRoot);
    const repository = await resolveRepository(pi, root);
    if (!repository) {
      return {
        ok: false,
        root,
        message: `Workspace root is not in a Git repository with a HEAD: ${root}`,
      };
    }
    if (!repositories.has(repository.repositoryRoot)) {
      repositories.set(repository.repositoryRoot, {
        repositoryRoot: repository.repositoryRoot,
        commonDir: repository.commonDir,
      });
    }
  }
  return { ok: true, repositories: [...repositories.values()] };
}

async function ensureStore(
  pi: ExtensionAPI,
  dataDir: string,
  repository: { repositoryRoot: string; commonDir: string },
): Promise<string> {
  const store = storePath(dataDir, repository.commonDir);
  if (!(await Bun.file(path.join(store, "HEAD")).exists())) {
    await fs.mkdir(path.dirname(store), { recursive: true });
    await run(pi, path.dirname(store), ["init", "--bare", store]);
  }

  const alternatesPath = path.join(store, "objects", "info", "alternates");
  const sourceObjects = await fs.realpath(
    path.join(repository.commonDir, "objects"),
  );
  let existing = "";
  try {
    existing = await Bun.file(alternatesPath).text();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const alternates = existing.split("\n").filter(Boolean);
  if (!alternates.includes(sourceObjects)) {
    alternates.push(sourceObjects);
    await Bun.write(alternatesPath, `${alternates.join("\n")}\n`);
  }
  return store;
}

function privateEnv(
  store: string,
  root: string,
  indexFile?: string,
): Record<string, string> {
  return {
    GIT_DIR: store,
    GIT_WORK_TREE: root,
    ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}),
  };
}

async function refExists(
  pi: ExtensionAPI,
  store: string,
  refName: string,
): Promise<boolean> {
  const result = await run(
    pi,
    store,
    ["--git-dir", store, "show-ref", "--verify", "--quiet", refName],
    {},
    true,
  );
  return result.code === 0;
}

async function captureFingerprint(
  pi: ExtensionAPI,
  dataDir: string,
  repository: { repositoryRoot: string; commonDir: string },
  refName?: string,
): Promise<WorkspaceSnapshot> {
  const headResult = await run(
    pi,
    repository.repositoryRoot,
    ["rev-parse", "HEAD"],
    {},
    true,
  );
  if (headResult.code !== 0 || !headResult.stdout.trim()) {
    throw new Error(`Git repository has no HEAD: ${repository.repositoryRoot}`);
  }
  const head = headResult.stdout.trim();
  const store = await ensureStore(pi, dataDir, repository);
  const indexTree = (
    await text(pi, repository.repositoryRoot, ["write-tree"])
  ).trim();
  const indexFile = path.join(store, `index-${crypto.randomUUID()}`);
  const env = privateEnv(store, repository.repositoryRoot, indexFile);
  try {
    await run(pi, repository.repositoryRoot, ["read-tree", indexTree], env);
    const sourceExclude = path.join(repository.commonDir, "info", "exclude");
    const privateExclude = path.join(store, "info", "exclude");
    try {
      await fs.copyFile(sourceExclude, privateExclude);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.rm(privateExclude, { force: true });
    }
    const globalExclude = await run(
      pi,
      repository.repositoryRoot,
      ["config", "--path", "--get", "core.excludesFile"],
      {},
      true,
    );
    const addArgs =
      globalExclude.code === 0 && globalExclude.stdout.trim()
        ? [
            "-c",
            `core.excludesFile=${globalExclude.stdout.trim()}`,
            "add",
            "-A",
            "--",
            ".",
          ]
        : ["add", "-A", "--", "."];
    await run(pi, repository.repositoryRoot, addArgs, env);
    const worktreeTree = (
      await text(pi, repository.repositoryRoot, ["write-tree"], env)
    ).trim();
    const snapshotRef =
      refName ?? `${PRIVATE_REF_PREFIX}unreferenced/${crypto.randomUUID()}`;
    if (refName) {
      validateRef(refName);
      await run(pi, store, [
        "--git-dir",
        store,
        "update-ref",
        refName,
        worktreeTree,
      ]);
      await run(pi, store, [
        "--git-dir",
        store,
        "update-ref",
        `${refName}-index`,
        indexTree,
      ]);
    }
    return {
      repositoryRoot: repository.repositoryRoot,
      commonDir: repository.commonDir,
      head,
      indexTree,
      worktreeTree,
      refName: snapshotRef,
    };
  } finally {
    await fs.rm(indexFile, { force: true });
    await fs.rm(`${indexFile}.lock`, { force: true });
  }
}

function parseNameStatus(raw: string): string[] {
  const fields = raw.split("\0");
  const paths = new Set<string>();
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    const first = fields[index++];
    if (first) paths.add(first);
    if (status.startsWith("R") || status.startsWith("C")) {
      const second = fields[index++];
      if (second) paths.add(second);
    }
  }
  return [...paths];
}

async function treeDifference(
  pi: ExtensionAPI,
  store: string,
  root: string,
  expected: string,
  actual: string,
  filter?: string,
): Promise<string[]> {
  const args = [
    "--git-dir",
    store,
    "diff-tree",
    "--no-commit-id",
    "--name-status",
  ];
  if (filter) args.push(`--diff-filter=${filter}`);
  args.push("-r", "-z", expected, actual);
  return parseNameStatus(await text(pi, root, args));
}

export class WorkspaceHistory {
  constructor(
    readonly pi: ExtensionAPI,
    readonly dataDir: string,
  ) {}

  async capture(
    roots: readonly string[],
    rootSessionId: string,
    turnId: string,
    stage: "before" | "after",
  ): Promise<WorkspaceSnapshot[]> {
    const resolved = await resolveWorkspace(this.pi, roots);
    if (!resolved.ok) throw new Error(resolved.message);
    const snapshots: WorkspaceSnapshot[] = [];
    try {
      for (const repository of resolved.repositories) {
        const refName = [
          PRIVATE_REF_PREFIX.slice(0, -1),
          safeRefPart(rootSessionId),
          safeRefPart(turnId),
          stage,
          Bun.hash.wyhash(repository.repositoryRoot).toString(16),
        ].join("/");
        const snapshot = await withLock(repository.commonDir, () =>
          captureFingerprint(this.pi, this.dataDir, repository, refName),
        );
        snapshots.push(snapshot);
      }
      return snapshots;
    } catch (error) {
      await this.deleteRefs(snapshots).catch(() => {});
      throw error;
    }
  }

  async matches(snapshot: WorkspaceSnapshot): Promise<SnapshotMatch> {
    const repository = await resolveRepository(
      this.pi,
      snapshot.repositoryRoot,
    );
    if (!repository || repository.commonDir !== snapshot.commonDir) {
      return { matches: false, paths: [snapshot.repositoryRoot] };
    }
    return withLock(repository.commonDir, async () => {
      const store = storePath(this.dataDir, repository.commonDir);
      if (
        !(await refExists(this.pi, store, snapshot.refName)) ||
        !(await refExists(this.pi, store, `${snapshot.refName}-index`))
      ) {
        return { matches: false, paths: [snapshot.refName] };
      }
      const current = await captureFingerprint(
        this.pi,
        this.dataDir,
        repository,
      );
      if (
        current.head === snapshot.head &&
        current.indexTree === snapshot.indexTree &&
        current.worktreeTree === snapshot.worktreeTree
      ) {
        return { matches: true };
      }
      const paths =
        current.worktreeTree === snapshot.worktreeTree
          ? [repository.repositoryRoot]
          : await treeDifference(
              this.pi,
              store,
              repository.repositoryRoot,
              snapshot.worktreeTree,
              current.worktreeTree,
            );
      return { matches: false, paths };
    });
  }

  async matchAll(
    snapshots: readonly WorkspaceSnapshot[],
  ): Promise<SnapshotMatch> {
    const changed = new Set<string>();
    for (const snapshot of snapshots) {
      const result = await this.matches(snapshot);
      if (!result.matches) {
        for (const changedPath of result.paths) {
          changed.add(
            path.isAbsolute(changedPath)
              ? changedPath
              : path.join(snapshot.repositoryRoot, changedPath),
          );
        }
      }
    }
    return changed.size === 0
      ? { matches: true }
      : { matches: false, paths: [...changed] };
  }

  async restore(snapshot: WorkspaceSnapshot): Promise<void> {
    const repository = await resolveRepository(
      this.pi,
      snapshot.repositoryRoot,
    );
    if (!repository || repository.commonDir !== snapshot.commonDir) {
      throw new Error(`Repository changed: ${snapshot.repositoryRoot}`);
    }
    await withLock(repository.commonDir, async () => {
      const store = storePath(this.dataDir, repository.commonDir);
      if (
        !(await refExists(this.pi, store, snapshot.refName)) ||
        !(await refExists(this.pi, store, `${snapshot.refName}-index`))
      ) {
        throw new Error(`Undo snapshot ref is missing: ${snapshot.refName}`);
      }
      if (repository.head !== snapshot.head)
        throw new Error(`Git HEAD changed in ${repository.repositoryRoot}`);
      const current = await captureFingerprint(
        this.pi,
        this.dataDir,
        repository,
      );
      const removals = await treeDifference(
        this.pi,
        store,
        repository.repositoryRoot,
        snapshot.worktreeTree,
        current.worktreeTree,
        "A",
      );
      const checkoutIndex = path.join(store, `restore-${crypto.randomUUID()}`);
      try {
        await run(this.pi, repository.repositoryRoot, [
          "read-tree",
          snapshot.indexTree,
        ]);
        for (const relativePath of removals.sort(
          (left, right) => right.length - left.length,
        )) {
          const absolutePath = path.resolve(
            repository.repositoryRoot,
            relativePath,
          );
          if (
            absolutePath !== repository.repositoryRoot &&
            absolutePath.startsWith(`${repository.repositoryRoot}${path.sep}`)
          ) {
            await fs.rm(absolutePath, { force: true });
          }
        }
        const env = privateEnv(store, repository.repositoryRoot, checkoutIndex);
        await run(
          this.pi,
          repository.repositoryRoot,
          ["read-tree", snapshot.worktreeTree],
          env,
        );
        await run(
          this.pi,
          repository.repositoryRoot,
          ["checkout-index", "--all", "--force"],
          env,
        );
      } finally {
        await fs.rm(checkoutIndex, { force: true });
        await fs.rm(`${checkoutIndex}.lock`, { force: true });
      }
    });
  }

  async restoreAll(snapshots: readonly WorkspaceSnapshot[]): Promise<void> {
    for (const snapshot of snapshots) await this.restore(snapshot);
  }

  async available(snapshots: readonly WorkspaceSnapshot[]): Promise<boolean> {
    for (const snapshot of snapshots) {
      const store = storePath(this.dataDir, snapshot.commonDir);
      if (
        !(await refExists(this.pi, store, snapshot.refName)) ||
        !(await refExists(this.pi, store, `${snapshot.refName}-index`))
      ) {
        return false;
      }
    }
    return true;
  }

  async deleteRefs(snapshots: readonly WorkspaceSnapshot[]): Promise<void> {
    for (const snapshot of snapshots) {
      validateRef(snapshot.refName);
      const store = storePath(this.dataDir, snapshot.commonDir);
      if (!(await Bun.file(path.join(store, "HEAD")).exists())) continue;
      await run(this.pi, store, [
        "--git-dir",
        store,
        "update-ref",
        "-d",
        snapshot.refName,
      ]);
      await run(this.pi, store, [
        "--git-dir",
        store,
        "update-ref",
        "-d",
        `${snapshot.refName}-index`,
      ]);
    }
  }
}
