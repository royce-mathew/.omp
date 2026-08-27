import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { WorkspaceDelta } from "./state.ts";

const GIT_TIMEOUT_MS = 5 * 60 * 1000;
const PRIVATE_REF_PREFIX = "refs/omp/undo/";
export const MAX_UNTRACKED_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TURN_PRIVATE_BYTES = 32 * 1024 * 1024;
const lockChains = new Map<string, Promise<unknown>>();

export interface WorkspaceSnapshot {
  repositoryRoot: string;
  commonDir: string;
  head: string;
  indexTree: string;
  worktreeTree: string;
  refName: string;
  scopes: string[];
  excludedPaths: string[];
}

export type SnapshotMatch =
  | { matches: true }
  | { matches: false; paths: string[] };

interface Repository {
  repositoryRoot: string;
  commonDir: string;
  head: string;
  scopes: string[];
}

export type ResolvedWorkspace =
  | { ok: true; repositories: Repository[] }
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

function validatePath(relativePath: string): void {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.split("/").includes("..") ||
    relativePath.includes("\0")
  ) {
    throw new Error(`Invalid workspace path: ${relativePath}`);
  }
}

async function run(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  allowFailure = false,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const result = await pi.exec(
    "env",
    [
      "GIT_TERMINAL_PROMPT=0",
      "GCM_INTERACTIVE=Never",
      "GIT_PAGER=cat",
      ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
      "git",
      ...args,
    ],
    { cwd, timeout: GIT_TIMEOUT_MS },
  );
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
    try {
      await prior;
    } catch {
      // Failed work must not poison later operations.
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
): Promise<Omit<Repository, "scopes"> | null> {
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
  const commonDir = await fs.realpath(
    (
      await text(pi, repositoryRoot, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])
    ).trim(),
  );
  const symbolicHead = await run(
    pi,
    repositoryRoot,
    ["symbolic-ref", "-q", "HEAD"],
    {},
    true,
  );
  if (symbolicHead.code !== 0) return null;
  const head = await run(pi, repositoryRoot, ["rev-parse", "HEAD"], {}, true);
  const headState = head.code === 0 && head.stdout.trim()
    ? head.stdout.trim()
    : `unborn:${symbolicHead.stdout.trim()}`;
  return { repositoryRoot, commonDir, head: headState };
}

export async function resolveWorkspace(
  pi: ExtensionAPI,
  roots: readonly string[],
): Promise<ResolvedWorkspace> {
  const repositories = new Map<string, Repository>();
  for (const configuredRoot of roots) {
    const root = path.resolve(configuredRoot);
    const repository = await resolveRepository(pi, root);
    if (!repository) {
      return {
        ok: false,
        root,
        message: `Workspace root is not in a supported Git repository: ${root}`,
      };
    }
    const relative = path.relative(repository.repositoryRoot, root);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return { ok: false, root, message: `Workspace root escapes its repository: ${root}` };
    }
    const scope = relative ? relative.split(path.sep).join("/") : ".";
    const key = `${repository.repositoryRoot}\0${repository.commonDir}`;
    const existing = repositories.get(key);
    if (existing) {
      if (!existing.scopes.includes(scope)) existing.scopes.push(scope);
    } else {
      repositories.set(key, { ...repository, scopes: [scope] });
    }
  }
  for (const repository of repositories.values()) {
    repository.scopes.sort();
    if (repository.scopes.includes(".")) repository.scopes = ["."];
    else {
      repository.scopes = repository.scopes.filter(
        (scope, index, all) =>
          !all.some(
            (parent, parentIndex) =>
              parentIndex !== index && scope.startsWith(`${parent}/`),
          ),
      );
    }
  }
  return { ok: true, repositories: [...repositories.values()] };
}

async function ensureStore(
  pi: ExtensionAPI,
  dataDir: string,
  repository: Pick<Repository, "repositoryRoot" | "commonDir">,
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
  if (!existing.split("\n").filter(Boolean).includes(sourceObjects)) {
    await fs.mkdir(path.dirname(alternatesPath), { recursive: true });
    await Bun.write(
      alternatesPath,
      `${[...existing.split("\n").filter(Boolean), sourceObjects].join("\n")}\n`,
    );
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
  return (
    await run(
      pi,
      store,
      ["--git-dir", store, "show-ref", "--verify", "--quiet", refName],
      {},
      true,
    )
  ).code === 0;
}

function parseNul(raw: string): string[] {
  return raw.split("\0").filter(Boolean);
}

async function oversizedUntracked(
  pi: ExtensionAPI,
  repository: Repository,
): Promise<string[]> {
  const candidates = parseNul(
    await text(pi, repository.repositoryRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...repository.scopes,
    ]),
  );
  const excluded: string[] = [];
  for (const candidate of candidates) {
    validatePath(candidate);
    const stat = await fs.lstat(path.join(repository.repositoryRoot, candidate));
    if (stat.isFile() && stat.size > MAX_UNTRACKED_FILE_BYTES) excluded.push(candidate);
  }
  return excluded.sort();
}

async function captureFingerprint(
  pi: ExtensionAPI,
  dataDir: string,
  repository: Repository,
  refName?: string,
): Promise<WorkspaceSnapshot> {
  const store = await ensureStore(pi, dataDir, repository);
  const indexTree = (await text(pi, repository.repositoryRoot, ["write-tree"])).trim();
  const indexFile = path.join(store, `index-${crypto.randomUUID()}`);
  const env = privateEnv(store, repository.repositoryRoot, indexFile);
  try {
    await run(pi, repository.repositoryRoot, ["read-tree", indexTree], env);
    const excludedPaths = await oversizedUntracked(pi, repository);
    await run(
      pi,
      repository.repositoryRoot,
      ["add", "-A", "--", ...repository.scopes],
      env,
    );
    for (const excluded of excludedPaths) {
      await run(
        pi,
        repository.repositoryRoot,
        ["update-index", "--force-remove", "--", excluded],
        env,
      );
    }
    const worktreeTree = (
      await text(pi, repository.repositoryRoot, ["write-tree"], env)
    ).trim();
    const snapshotRef =
      refName ?? `${PRIVATE_REF_PREFIX}unreferenced/${crypto.randomUUID()}`;
    if (refName) {
      validateRef(refName);
      await run(pi, store, ["--git-dir", store, "update-ref", refName, worktreeTree]);
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
      head: repository.head,
      indexTree,
      worktreeTree,
      refName: snapshotRef,
      scopes: [...repository.scopes],
      excludedPaths,
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
  scopes: readonly string[],
): Promise<string[]> {
  return parseNameStatus(
    await text(pi, root, [
      "--git-dir",
      store,
      "diff-tree",
      "--no-commit-id",
      "--name-status",
      "-r",
      "-z",
      expected,
      actual,
      "--",
      ...scopes,
    ]),
  );
}

function matchingRepository(
  snapshots: readonly WorkspaceSnapshot[],
  candidate: WorkspaceSnapshot,
): WorkspaceSnapshot | undefined {
  return snapshots.find(
    (snapshot) =>
      snapshot.repositoryRoot === candidate.repositoryRoot &&
      snapshot.commonDir === candidate.commonDir,
  );
}

interface TreeEntry {
  mode: string;
  object: string;
  path: string;
}

function parseTreeEntry(raw: string): TreeEntry | undefined {
  const tab = raw.indexOf("\t");
  if (tab < 0) return undefined;
  const [mode, type, object] = raw.slice(0, tab).split(" ");
  return type === "blob" && mode && object
    ? { mode, object, path: raw.slice(tab + 1) }
    : undefined;
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
    stage: "before" | "after" | "rollback" = "before",
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
        snapshots.push(
          await withLock(repository.commonDir, () =>
            captureFingerprint(this.pi, this.dataDir, repository, refName),
          ),
        );
      }
      return snapshots;
    } catch (error) {
      await this.deleteRefs(snapshots).catch(() => {});
      throw error;
    }
  }

  async deltas(
    before: readonly WorkspaceSnapshot[],
    after: readonly WorkspaceSnapshot[],
  ): Promise<WorkspaceDelta[]> {
    if (before.length !== after.length) throw new Error("Workspace roots changed during the user turn.");
    const deltas: WorkspaceDelta[] = [];
    for (const beforeSnapshot of before) {
      const afterSnapshot = matchingRepository(after, beforeSnapshot);
      if (
        !afterSnapshot ||
        beforeSnapshot.scopes.length !== afterSnapshot.scopes.length ||
        beforeSnapshot.scopes.some(
          (scope, index) => scope !== afterSnapshot.scopes[index],
        )
      ) {
        throw new Error("Workspace roots changed during the user turn.");
      }
      const store = storePath(this.dataDir, beforeSnapshot.commonDir);
      const changedPaths = new Set<string>([
        ...(await treeDifference(
          this.pi,
          store,
          beforeSnapshot.repositoryRoot,
          beforeSnapshot.indexTree,
          afterSnapshot.indexTree,
          beforeSnapshot.scopes,
        )),
        ...(await treeDifference(
          this.pi,
          store,
          beforeSnapshot.repositoryRoot,
          beforeSnapshot.worktreeTree,
          afterSnapshot.worktreeTree,
          beforeSnapshot.scopes,
        )),
      ]);
      for (const excludedPath of new Set([
        ...beforeSnapshot.excludedPaths,
        ...afterSnapshot.excludedPaths,
      ])) {
        changedPaths.delete(excludedPath);
      }
      for (const changedPath of changedPaths) validatePath(changedPath);
      deltas.push({
        repositoryRoot: beforeSnapshot.repositoryRoot,
        commonDir: beforeSnapshot.commonDir,
        before: beforeSnapshot,
        after: afterSnapshot,
        changedPaths: [...changedPaths].sort(),
      });
    }
    return deltas;
  }

  async matchPaths(
    snapshot: WorkspaceSnapshot,
    changedPaths: readonly string[],
    expectedHead = snapshot.head,
  ): Promise<SnapshotMatch> {
    const repository = await resolveRepository(this.pi, snapshot.repositoryRoot);
    if (
      !repository ||
      repository.commonDir !== snapshot.commonDir ||
      repository.head !== expectedHead
    ) {
      return { matches: false, paths: [snapshot.repositoryRoot] };
    }
    for (const changedPath of changedPaths) validatePath(changedPath);
    return withLock(repository.commonDir, async () => {
      const store = storePath(this.dataDir, repository.commonDir);
      if (
        !(await refExists(this.pi, store, snapshot.refName)) ||
        !(await refExists(this.pi, store, `${snapshot.refName}-index`))
      ) {
        return { matches: false, paths: [snapshot.refName] };
      }
      const current = await captureFingerprint(this.pi, this.dataDir, {
        ...repository,
        scopes: snapshot.scopes,
      });
      const paths = new Set<string>([
        ...(await treeDifference(
          this.pi,
          store,
          repository.repositoryRoot,
          snapshot.indexTree,
          current.indexTree,
          changedPaths,
        )),
        ...(await treeDifference(
          this.pi,
          store,
          repository.repositoryRoot,
          snapshot.worktreeTree,
          current.worktreeTree,
          changedPaths,
        )),
      ]);
      return paths.size === 0
        ? { matches: true }
        : { matches: false, paths: [...paths].sort() };
    });
  }

  async matchAllPaths(
    workspaces: readonly WorkspaceDelta[],
    side: "before" | "after",
    expectedHeads: ReadonlyMap<string, string>,
  ): Promise<SnapshotMatch> {
    const paths = new Set<string>();
    for (const workspace of workspaces) {
      const result = await this.matchPaths(
        workspace[side],
        workspace.changedPaths,
        expectedHeads.get(workspace.commonDir),
      );
      if (!result.matches) {
        for (const changedPath of result.paths) {
          paths.add(
            path.isAbsolute(changedPath)
              ? changedPath
              : path.join(workspace.repositoryRoot, changedPath),
          );
        }
      }
    }
    return paths.size === 0
      ? { matches: true }
      : { matches: false, paths: [...paths].sort() };
  }

  async restorePaths(
    snapshot: WorkspaceSnapshot,
    changedPaths: readonly string[],
  ): Promise<void> {
    const repository = await resolveRepository(this.pi, snapshot.repositoryRoot);
    if (!repository || repository.commonDir !== snapshot.commonDir) {
      throw new Error(`Repository changed: ${snapshot.repositoryRoot}`);
    }
    for (const changedPath of changedPaths) validatePath(changedPath);
    await withLock(repository.commonDir, async () => {
      const store = storePath(this.dataDir, repository.commonDir);
      if (
        !(await refExists(this.pi, store, snapshot.refName)) ||
        !(await refExists(this.pi, store, `${snapshot.refName}-index`))
      ) {
        throw new Error(`Undo snapshot ref is missing: ${snapshot.refName}`);
      }
      const checkoutIndex = path.join(store, `restore-${crypto.randomUUID()}`);
      const env = privateEnv(store, repository.repositoryRoot, checkoutIndex);
      try {
        await run(this.pi, repository.repositoryRoot, ["read-tree", snapshot.worktreeTree], env);
        const worktreeEntries = new Map<string, TreeEntry>();
        const indexEntries = new Map<string, TreeEntry>();
        for (const changedPath of changedPaths) {
          for (const [tree, entries] of [
            [snapshot.worktreeTree, worktreeEntries],
            [snapshot.indexTree, indexEntries],
          ] as const) {
            const listing = await text(
              this.pi,
              repository.repositoryRoot,
              ["ls-tree", "-z", tree, "--", changedPath],
              privateEnv(store, repository.repositoryRoot),
            );
            for (const item of parseNul(listing)) {
              const entry = parseTreeEntry(item);
              if (entry) entries.set(entry.path, entry);
            }
          }
        }
        const selected = new Set(changedPaths);
        const deepestFirst = [...changedPaths].sort(
          (left, right) => right.split("/").length - left.split("/").length,
        );
        for (const changedPath of deepestFirst) {
          if (worktreeEntries.has(changedPath)) continue;
          const absolute = path.join(repository.repositoryRoot, changedPath);
          try {
            const stat = await fs.lstat(absolute);
            if (stat.isDirectory()) {
              const descendants = await fs.readdir(absolute, { recursive: true });
              if (
                descendants.some(
                  (entry) =>
                    !selected.has(
                      path.join(changedPath, entry.toString()).split(path.sep).join("/"),
                    ),
                )
              ) {
                throw new Error(`Unselected path blocks restore: ${changedPath}`);
              }
            }
            await fs.rm(absolute, { recursive: true, force: true });
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
          }
        }
        for (const entry of [...worktreeEntries.values()].sort(
          (left, right) => left.path.split("/").length - right.path.split("/").length,
        )) {
          const absolute = path.join(repository.repositoryRoot, entry.path);
          try {
            const stat = await fs.lstat(absolute);
            if (stat.isDirectory()) {
              const descendants = await fs.readdir(absolute, { recursive: true });
              if (
                descendants.some(
                  (child) =>
                    !selected.has(
                      path.join(entry.path, child.toString()).split(path.sep).join("/"),
                    ),
                )
              ) {
                throw new Error(`Unselected path blocks restore: ${entry.path}`);
              }
              await fs.rm(absolute, { recursive: true, force: true });
            }
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
          }
          await run(
            this.pi,
            repository.repositoryRoot,
            ["checkout-index", "--force", "--", entry.path],
            env,
          );
        }
        for (const changedPath of changedPaths) {
          await run(
            this.pi,
            repository.repositoryRoot,
            ["update-index", "--force-remove", "--", changedPath],
          );
        }
        for (const entry of indexEntries.values()) {
          await run(
            this.pi,
            repository.repositoryRoot,
            [
              "update-index",
              "--add",
              "--cacheinfo",
              `${entry.mode},${entry.object},${entry.path}`,
            ],
          );
        }
      } finally {
        await fs.rm(checkoutIndex, { force: true });
        await fs.rm(`${checkoutIndex}.lock`, { force: true });
      }
    });
  }

  async restoreAllPaths(
    workspaces: readonly WorkspaceDelta[],
    side: "before" | "after",
  ): Promise<void> {
    for (const workspace of workspaces) {
      await this.restorePaths(workspace[side], workspace.changedPaths);
    }
  }

  async available(snapshots: readonly WorkspaceSnapshot[]): Promise<boolean> {
    for (const snapshot of snapshots) {
      const store = storePath(this.dataDir, snapshot.commonDir);
      if (
        !(await refExists(this.pi, store, snapshot.refName)) ||
        !(await refExists(this.pi, store, `${snapshot.refName}-index`))
      ) return false;
    }
    return true;
  }

  async deleteRefs(snapshots: readonly WorkspaceSnapshot[]): Promise<void> {
    for (const snapshot of snapshots) {
      validateRef(snapshot.refName);
      const store = storePath(this.dataDir, snapshot.commonDir);
      if (!(await Bun.file(path.join(store, "HEAD")).exists())) continue;
      await run(this.pi, store, ["--git-dir", store, "update-ref", "-d", snapshot.refName]);
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
