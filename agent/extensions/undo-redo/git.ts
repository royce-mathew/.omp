import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { listJournals } from "./journal.ts";
import { workspaceIdentity, type WorkspaceDelta } from "./state.ts";

const GIT_TIMEOUT_MS = 5 * 60 * 1000;
const PRIVATE_REF_PREFIX = "refs/omp/undo/";
export const MAX_UNTRACKED_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TURN_PRIVATE_BYTES = 32 * 1024 * 1024;
export const MAX_TURNS_PER_ROOT_SESSION = 100;
export const MAX_SNAPSHOT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_DATA_BYTES = 1024 * 1024 * 1024;
export const GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UNCATEGORIZED_REF_GRACE_MS = GC_INTERVAL_MS;
const STORE_LOCK_TIMEOUT_MS = GIT_TIMEOUT_MS;
const STALE_LOCK_TIMEOUT_MS = STORE_LOCK_TIMEOUT_MS * 2;
const CATALOG_FILE = "checkpoints.jsonl";
const GC_STATE_FILE = "checkpoints-gc.json";
const lockChains = new Map<string, Promise<unknown>>();

export interface SnapshotRetentionTestOverrides {
  now?: () => number;
  maxTurnsPerRootSession?: number;
  maxSnapshotAgeMs?: number;
  maxDataBytes?: number;
  gcIntervalMs?: number;
}

interface SnapshotRetention {
  now: () => number;
  maxTurnsPerRootSession: number;
  maxSnapshotAgeMs: number;
  maxDataBytes: number;
  gcIntervalMs: number;
}

interface CatalogRef {
  store: string;
  refName: string;
}

interface CatalogCheckpoint {
  type: "create";
  rootSessionId: string;
  turnId: string;
  timestamp: number;
  sessionFile: string;
  refs: CatalogRef[];
}
interface CatalogDeletion {
  type: "delete";
  rootSessionId: string;
  turnId: string;
  timestamp: number;
  sessionFile: string;
  refs: CatalogRef[];
}

type CatalogRecord = CatalogCheckpoint | CatalogDeletion;

function retentionPolicy(
  overrides: SnapshotRetentionTestOverrides | undefined,
): SnapshotRetention {
  return {
    now: overrides?.now ?? Date.now,
    maxTurnsPerRootSession:
      overrides?.maxTurnsPerRootSession ?? MAX_TURNS_PER_ROOT_SESSION,
    maxSnapshotAgeMs: overrides?.maxSnapshotAgeMs ?? MAX_SNAPSHOT_AGE_MS,
    maxDataBytes: overrides?.maxDataBytes ?? MAX_DATA_BYTES,
    gcIntervalMs: overrides?.gcIntervalMs ?? GC_INTERVAL_MS,
  };
}

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
      "GIT_LITERAL_PATHSPECS=1",
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

interface StoreLockOwner {
  pid: number;
  startTime?: string;
  createdAt: number;
}

async function processStartTime(pid: number): Promise<string | undefined> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const closingParenthesis = stat.lastIndexOf(")");
    const fields = stat.slice(closingParenthesis + 2).split(" ");
    return fields[19];
  } catch {
    return undefined;
  }
}

async function staleLock(lockPath: string): Promise<boolean> {
  let owner: StoreLockOwner;
  try {
    owner = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"));
  } catch {
    const stat = await fs.stat(lockPath).catch(() => undefined);
    return !!stat && Date.now() - stat.mtimeMs > STALE_LOCK_TIMEOUT_MS;
  }
  if (
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    !Number.isFinite(owner.createdAt)
  ) return Date.now() - owner.createdAt > STALE_LOCK_TIMEOUT_MS;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    return false;
  }
  if (!owner.startTime) return false;
  const actualStartTime = await processStartTime(owner.pid);
  return !!actualStartTime && actualStartTime !== owner.startTime;
}

async function acquireFileLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + STORE_LOCK_TIMEOUT_MS;
  const owner: StoreLockOwner = {
    pid: process.pid,
    startTime: await processStartTime(process.pid),
    createdAt: Date.now(),
  };
  while (true) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner), {
        mode: 0o600,
      });
      return async () => {
        await fs.rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await staleLock(lockPath)) {
        const reclaimed = `${lockPath}.reclaim-${crypto.randomUUID()}`;
        try {
          await fs.rename(lockPath, reclaimed);
          await fs.rm(reclaimed, { recursive: true, force: true });
          continue;
        } catch (reclaimError) {
          if ((reclaimError as NodeJS.ErrnoException).code !== "ENOENT") throw reclaimError;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for private undo store lock: ${lockPath}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const prior = lockChains.get(lockPath);
  const current = (async () => {
    try {
      await prior;
    } catch {
      // Failed work must not poison later operations.
    }
    const release = await acquireFileLock(lockPath);
    try {
      return await operation();
    } finally {
      await release();
    }
  })();
  lockChains.set(lockPath, current);
  try {
    return await current;
  } finally {
    if (lockChains.get(lockPath) === current) lockChains.delete(lockPath);
  }
}

async function withStoreLock<T>(
  store: string,
  operation: () => Promise<T>,
): Promise<T> {
  await fs.mkdir(path.dirname(store), { recursive: true });
  return withFileLock(`${store}.lock`, operation);
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
async function reachableObjectIds(
  pi: ExtensionAPI,
  store: string,
): Promise<Set<string>> {
  return new Set(
    (await text(pi, store, [
      "--git-dir",
      store,
      "rev-list",
      "--objects",
      "--no-object-names",
      "--all",
    ]))
      .split("\n")
      .filter(Boolean),
  );
}

async function objectBytes(
  pi: ExtensionAPI,
  store: string,
  objectIds: ReadonlySet<string>,
): Promise<number> {
  if (objectIds.size === 0) return 0;
  let bytes = 0;
  const objects = await text(pi, store, [
    "--git-dir",
    store,
    "cat-file",
    "--batch-all-objects",
    "--batch-check=%(objectname) %(objectsize:disk)",
  ]);
  for (const line of objects.split("\n")) {
    const [object, size] = line.split(" ");
    if (objectIds.has(object) && size) bytes += Number(size);
  }
  return bytes;
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
  let alternates = "";
  try {
    alternates = await Bun.file(alternatesPath).text();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const alternateDirectories = alternates.split("\n").filter(Boolean);
  if (alternateDirectories.length === 0) return store;

  const migrationPath = `${alternatesPath}.migrating`;
  await fs.rename(alternatesPath, migrationPath);
  try {
    await run(
      pi,
      store,
      ["--git-dir", store, "repack", "-a", "-d"],
      { GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateDirectories.join(path.delimiter) },
    );
    await run(pi, store, [
      "--git-dir",
      store,
      "fsck",
      "--connectivity-only",
      "--no-dangling",
    ]);
    await fs.rm(migrationPath, { force: true });
  } catch (error) {
    await fs.rename(migrationPath, alternatesPath).catch(() => {});
    throw error;
  }
  return store;
}

async function deleteSnapshotRefs(
  pi: ExtensionAPI,
  store: string,
  refName: string,
): Promise<void> {
  await run(pi, store, ["--git-dir", store, "update-ref", "-d", refName], {}, true);
  await run(
    pi,
    store,
    ["--git-dir", store, "update-ref", "-d", `${refName}-index`],
    {},
    true,
  );
}

async function materializeSnapshotObjects(
  pi: ExtensionAPI,
  store: string,
  sourceObjects: string,
  indexTree: string,
  worktreeTree: string,
): Promise<void> {
  const materializationRef =
    `${PRIVATE_REF_PREFIX}materializing/${crypto.randomUUID()}`;
  const temporaryRefs = [
    [materializationRef, worktreeTree],
    [`${materializationRef}-index`, indexTree],
  ] as const;
  try {
    for (const [refName, tree] of temporaryRefs) {
      const refPath = path.join(store, refName);
      await fs.mkdir(path.dirname(refPath), { recursive: true });
      await fs.writeFile(refPath, `${tree}\n`, { encoding: "utf8", flag: "wx" });
    }
    await run(
      pi,
      store,
      ["--git-dir", store, "repack", "-a", "-d"],
      { GIT_ALTERNATE_OBJECT_DIRECTORIES: sourceObjects },
    );
    await run(pi, store, [
      "--git-dir",
      store,
      "fsck",
      "--connectivity-only",
      "--no-dangling",
    ]);
    for (const [refName] of temporaryRefs) {
      await run(pi, store, ["--git-dir", store, "cat-file", "-e", `${refName}^{tree}`]);
    }
  } finally {
    await Promise.all(
      temporaryRefs.map(([refName]) => fs.rm(path.join(store, refName), { force: true })),
    );
  }
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

async function snapshotRefsAvailable(
  pi: ExtensionAPI,
  store: string,
  snapshot: WorkspaceSnapshot,
): Promise<boolean> {
  try {
    validateRef(snapshot.refName);
  } catch {
    return false;
  }
  for (const [refName, expectedTree] of [
    [snapshot.refName, snapshot.worktreeTree],
    [`${snapshot.refName}-index`, snapshot.indexTree],
  ]) {
    const resolved = await run(
      pi,
      store,
      ["--git-dir", store, "rev-parse", "--verify", refName],
      {},
      true,
    );
    if (resolved.code !== 0 || resolved.stdout.trim() !== expectedTree) return false;
    if (
      (await run(
        pi,
        store,
        ["--git-dir", store, "cat-file", "-e", `${refName}^{tree}`],
        {},
        true,
      )).code !== 0
    ) return false;
  }
  return true;
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
function catalogRefKey(ref: CatalogRef): string {
  return `${ref.store}\0${ref.refName}`;
}

function catalogRefs(
  snapshots: readonly WorkspaceSnapshot[],
): CatalogRef[] {
  const refs = new Map<string, CatalogRef>();
  for (const snapshot of snapshots) {
    const ref = {
      store: repositoryHash(snapshot.commonDir),
      refName: snapshot.refName,
    };
    refs.set(catalogRefKey(ref), ref);
  }
  return [...refs.values()];
}

function parseCatalogRecord(value: unknown): CatalogRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const validRef = (ref: unknown): ref is CatalogRef => {
    if (
      !ref ||
      typeof ref !== "object" ||
      !("store" in ref) ||
      !("refName" in ref) ||
      typeof ref.store !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(ref.store) ||
      typeof ref.refName !== "string"
    ) return false;
    try {
      validateRef(ref.refName);
      return true;
    } catch {
      return false;
    }
  };
  const validRefs = (refs: unknown): refs is CatalogRef[] =>
    Array.isArray(refs) && refs.every(validRef);
  const rootSessionId = record.rootSessionId;
  const turnId = record.turnId;
  const timestamp = record.timestamp;
  const sessionFile = record.sessionFile;
  const refs = record.refs;
  if (
    typeof rootSessionId !== "string" ||
    typeof turnId !== "string" ||
    typeof timestamp !== "number" ||
    typeof sessionFile !== "string" ||
    !validRefs(refs)
  ) return undefined;
  if (record.type === "create") {
    return { type: "create", rootSessionId, turnId, timestamp, sessionFile, refs };
  }
  if (record.type === "delete") {
    return { type: "delete", rootSessionId, turnId, timestamp, sessionFile, refs };
  }
  return undefined;
}

async function readCatalog(dataDir: string): Promise<CatalogRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dataDir, CATALOG_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: CatalogRecord[] = [];
  const lines = raw.split("\n");
  let finalRecordIndex = -1;
  for (const [index, line] of lines.entries()) {
    if (line) finalRecordIndex = index;
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line) continue;
    try {
      const record = parseCatalogRecord(JSON.parse(line));
      if (!record) throw new Error("Malformed private snapshot catalog record.");
      records.push(record);
    } catch (error) {
      if (index === finalRecordIndex) break;
      throw error;
    }
  }
  return records;
}

async function appendCatalogRecord(
  dataDir: string,
  record: CatalogRecord,
): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const handle = await fs.open(path.join(dataDir, CATALOG_FILE), "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await fs.open(
    dataDir,
    fsSync.constants.O_RDONLY | fsSync.constants.O_DIRECTORY,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function compactCatalog(
  dataDir: string,
  records: readonly CatalogRecord[],
): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const destination = path.join(dataDir, CATALOG_FILE);
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, destination);
  const directory = await fs.open(
    dataDir,
    fsSync.constants.O_RDONLY | fsSync.constants.O_DIRECTORY,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function activeCatalog(records: readonly CatalogRecord[]): CatalogCheckpoint[] {
  const checkpoints = new Map<string, CatalogCheckpoint>();
  const checkpointByRef = new Map<string, string>();
  for (const record of records) {
    if (record.type === "create") {
      const key = `${record.rootSessionId}\0${record.turnId}\0${record.timestamp}`;
      checkpoints.set(key, record);
      for (const ref of record.refs) checkpointByRef.set(catalogRefKey(ref), key);
      continue;
    }
    for (const ref of record.refs) {
      const checkpointKey = checkpointByRef.get(catalogRefKey(ref));
      if (!checkpointKey) continue;
      const checkpoint = checkpoints.get(checkpointKey);
      if (checkpoint) {
        checkpoints.delete(checkpointKey);
        for (const checkpointRef of checkpoint.refs) {
          checkpointByRef.delete(catalogRefKey(checkpointRef));
        }
      }
    }
  }
  return [...checkpoints.values()];
}

async function privateDataBytes(dataDir: string): Promise<number> {
  let bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile()) bytes += (await fs.stat(candidate)).size;
    }
  };
  await visit(dataDir);
  return bytes;
}

async function protectedJournalRefs(dataDir: string): Promise<Set<string>> {
  const protectedRefs = new Set<string>();
  for (const { journal } of await listJournals(dataDir)) {
    for (const snapshot of [
      ...journal.rollback,
      ...journal.workspaces.flatMap((workspace) => [workspace.before, workspace.after]),
    ]) {
      protectedRefs.add(catalogRefKey({
        store: repositoryHash(snapshot.commonDir),
        refName: snapshot.refName,
      }));
    }
  }
  return protectedRefs;
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

interface CapturedFingerprint {
  snapshot: WorkspaceSnapshot;
  retainedBytes: number;
}

async function captureFingerprint(
  pi: ExtensionAPI,
  dataDir: string,
  repository: Repository,
  refName?: string,
): Promise<CapturedFingerprint> {
  const store = await ensureStore(pi, dataDir, repository);
  const sourceObjects = await fs.realpath(path.join(repository.commonDir, "objects"));
  const privateObjectsBefore = refName
    ? await reachableObjectIds(pi, store)
    : new Set<string>();
  const indexTree = (await text(pi, repository.repositoryRoot, ["write-tree"])).trim();
  const indexFile = path.join(store, `index-${crypto.randomUUID()}`);
  const env = {
    ...privateEnv(store, repository.repositoryRoot, indexFile),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: sourceObjects,
  };
  const snapshotRef =
    refName ?? `${PRIVATE_REF_PREFIX}unreferenced/${crypto.randomUUID()}`;
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
    if (refName) {
      validateRef(refName);
      await materializeSnapshotObjects(
        pi,
        store,
        sourceObjects,
        indexTree,
        worktreeTree,
      );
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
      snapshot: {
        repositoryRoot: repository.repositoryRoot,
        commonDir: repository.commonDir,
        head: repository.head,
        indexTree,
        worktreeTree,
        refName: snapshotRef,
        scopes: [...repository.scopes],
        excludedPaths,
      },
      retainedBytes: refName
        ? await objectBytes(
          pi,
          store,
          new Set(
            [...(await reachableObjectIds(pi, store))].filter(
              (object) => !privateObjectsBefore.has(object),
            ),
          ),
        )
        : 0,
    };
  } catch (error) {
    if (refName) await deleteSnapshotRefs(pi, store, refName).catch(() => {});
    throw error;
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
  env: Record<string, string> = {},
): Promise<string[]> {
  return parseNameStatus(
    await text(
      pi,
      root,
      [
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
      ],
      env,
    ),
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
  private readonly retainedBytesByTurn = new Map<string, number>();
  private readonly retention: SnapshotRetention;

  constructor(
    readonly pi: ExtensionAPI,
    readonly dataDir: string,
    retentionForTesting?: SnapshotRetentionTestOverrides,
  ) {
    this.retention = retentionPolicy(retentionForTesting);
  }

  async recordDurableCheckpoint(
    rootSessionId: string,
    turnId: string,
    sessionFile: string,
    snapshots: readonly WorkspaceSnapshot[],
  ): Promise<void> {
    if (
      !rootSessionId ||
      !turnId ||
      !sessionFile ||
      rootSessionId.includes("\0") ||
      turnId.includes("\0") ||
      sessionFile.includes("\0")
    ) {
      throw new Error("Refusing to catalog a malformed durable undo checkpoint.");
    }
    for (const snapshot of snapshots) validateRef(snapshot.refName);
    await withFileLock(path.join(this.dataDir, "checkpoints.catalog.lock"), () =>
      appendCatalogRecord(this.dataDir, {
        type: "create",
        rootSessionId,
        turnId,
        timestamp: this.retention.now(),
        sessionFile,
        refs: catalogRefs(snapshots),
      })
    );
  }

  async collectGarbage(force = false): Promise<void> {
    await withFileLock(path.join(this.dataDir, "checkpoints.catalog.lock"), async () => {
      const statePath = path.join(this.dataDir, GC_STATE_FILE);
      let lastGc: number | undefined;
      try {
        const state = JSON.parse(await fs.readFile(statePath, "utf8")) as { lastGc?: unknown };
        if (typeof state.lastGc === "number" && Number.isFinite(state.lastGc)) {
          lastGc = state.lastGc;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const now = this.retention.now();
      if (
        !force &&
        lastGc !== undefined &&
        now - lastGc < this.retention.gcIntervalMs
      ) return;

      const records = await readCatalog(this.dataDir);
      const protectedRefs = await protectedJournalRefs(this.dataDir);
      const checkpoints = activeCatalog(records);
      const remove = new Set<string>();
      const byRoot = new Map<string, CatalogCheckpoint[]>();
      for (const checkpoint of checkpoints) {
        const root = byRoot.get(checkpoint.rootSessionId);
        if (root) root.push(checkpoint);
        else byRoot.set(checkpoint.rootSessionId, [checkpoint]);
      }
      for (const root of byRoot.values()) {
        root.sort((left, right) => right.timestamp - left.timestamp);
        for (const [index, checkpoint] of root.entries()) {
          if (
            now - checkpoint.timestamp > this.retention.maxSnapshotAgeMs ||
            index >= this.retention.maxTurnsPerRootSession
          ) {
            for (const ref of checkpoint.refs) {
              const key = catalogRefKey(ref);
              if (!protectedRefs.has(key)) remove.add(key);
            }
          }
        }
      }

      const stores = new Set<string>(
        checkpoints.flatMap((checkpoint) => checkpoint.refs.map((ref) => ref.store)),
      );
      let dataEntries: fsSync.Dirent[] = [];
      try {
        dataEntries = await fs.readdir(this.dataDir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      for (const entry of dataEntries) {
        if (
          entry.isDirectory() &&
          /^[A-Za-z0-9_-]+$/.test(entry.name) &&
          await Bun.file(path.join(this.dataDir, entry.name, "HEAD")).exists()
        ) stores.add(entry.name);
      }

      const activeRefs = new Set(
        checkpoints.flatMap((checkpoint) =>
          checkpoint.refs.map((ref) => catalogRefKey(ref))
        ),
      );
      for (const storeName of stores) {
        const store = path.join(this.dataDir, storeName);
        await withStoreLock(store, async () => {
          if (!(await Bun.file(path.join(store, "HEAD")).exists())) return;
          for (const checkpoint of checkpoints) {
            for (const ref of checkpoint.refs) {
              const key = catalogRefKey(ref);
              if (ref.store === storeName && remove.has(key)) {
                await deleteSnapshotRefs(this.pi, store, ref.refName);
              }
            }
          }
          const refs = (await text(this.pi, store, [
            "--git-dir",
            store,
            "for-each-ref",
            "--format=%(refname)",
            PRIVATE_REF_PREFIX,
          ])).split("\n").filter(Boolean);
          for (const refName of refs) {
            const baseRef = refName.endsWith("-index")
              ? refName.slice(0, -"-index".length)
              : refName;
            const key = catalogRefKey({ store: storeName, refName: baseRef });
            if (activeRefs.has(key) || protectedRefs.has(key)) continue;
            let modified: number | undefined;
            for (const candidate of [
              path.join(store, "logs", baseRef),
              path.join(store, baseRef),
            ]) {
              try {
                modified = (await fs.stat(candidate)).mtimeMs;
                break;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              }
            }
            if (
              modified !== undefined &&
              now - modified > UNCATEGORIZED_REF_GRACE_MS
            ) await deleteSnapshotRefs(this.pi, store, baseRef);
          }
          await run(this.pi, store, [
            "--git-dir",
            store,
            "reflog",
            "expire",
            "--expire=now",
            "--expire-unreachable=now",
            "--all",
          ]);
          await run(this.pi, store, ["--git-dir", store, "gc", "--prune=now"]);
        });
      }

      const removedRecords = checkpoints.filter((checkpoint) =>
        checkpoint.refs.some((ref) => remove.has(catalogRefKey(ref)))
      );
      const keptRecords = checkpoints.filter((checkpoint) =>
        !removedRecords.includes(checkpoint)
      );
      await compactCatalog(this.dataDir, [
        ...keptRecords,
        ...removedRecords.map((checkpoint): CatalogDeletion => ({
          type: "delete",
          rootSessionId: checkpoint.rootSessionId,
          turnId: checkpoint.turnId,
          timestamp: now,
          sessionFile: checkpoint.sessionFile,
          refs: checkpoint.refs,
        })),
      ]);
      const state = await fs.open(statePath, "w", 0o600);
      try {
        await state.writeFile(JSON.stringify({ lastGc: now }));
        await state.sync();
      } finally {
        await state.close();
      }
    });
  }

  async capture(
    roots: readonly string[],
    rootSessionId: string,
    turnId: string,
    stage: "before" | "after" | "rollback" = "before",
  ): Promise<WorkspaceSnapshot[]> {
    await this.collectGarbage();
    if ((await privateDataBytes(this.dataDir)) >= this.retention.maxDataBytes) {
      await this.collectGarbage(true);
      if ((await privateDataBytes(this.dataDir)) >= this.retention.maxDataBytes) {
        throw new Error(
          `Undo snapshots exceed the ${this.retention.maxDataBytes / (1024 * 1024 * 1024)} GiB private storage limit.`,
        );
      }
    }
    const resolved = await resolveWorkspace(this.pi, roots);
    if (!resolved.ok) throw new Error(resolved.message);
    const captureKey = `${rootSessionId}\0${turnId}`;
    const snapshots: WorkspaceSnapshot[] = [];
    let retainedBytes = stage === "after"
      ? this.retainedBytesByTurn.get(captureKey) ?? 0
      : 0;
    try {
      for (const repository of resolved.repositories) {
        const refName = [
          PRIVATE_REF_PREFIX.slice(0, -1),
          safeRefPart(rootSessionId),
          safeRefPart(turnId),
          stage,
          Bun.hash.wyhash(repository.repositoryRoot).toString(16),
        ].join("/");
        const captured = await withStoreLock(
          storePath(this.dataDir, repository.commonDir),
          () => captureFingerprint(this.pi, this.dataDir, repository, refName),
        );
        snapshots.push(captured.snapshot);
        retainedBytes += captured.retainedBytes;
        if (retainedBytes > MAX_TURN_PRIVATE_BYTES) {
          throw new Error(
            `Undo snapshot exceeds the ${MAX_TURN_PRIVATE_BYTES / (1024 * 1024)} MiB private storage limit.`,
          );
        }
      }
      if ((await privateDataBytes(this.dataDir)) >= this.retention.maxDataBytes) {
        await this.collectGarbage(true);
        if ((await privateDataBytes(this.dataDir)) >= this.retention.maxDataBytes) {
          throw new Error(
            `Undo snapshots exceed the ${this.retention.maxDataBytes / (1024 * 1024 * 1024)} GiB private storage limit.`,
          );
        }
      }
      if (stage === "before") this.retainedBytesByTurn.set(captureKey, retainedBytes);
      else if (stage === "after") this.retainedBytesByTurn.delete(captureKey);
      return snapshots;
    } catch (error) {
      this.retainedBytesByTurn.delete(captureKey);
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
    validateRef(snapshot.refName);
    for (const scope of snapshot.scopes) {
      if (scope !== ".") validatePath(scope);
    }
    if (
      !repository ||
      repository.commonDir !== snapshot.commonDir ||
      repository.head !== expectedHead
    ) {
      return { matches: false, paths: [snapshot.repositoryRoot] };
    }
    for (const changedPath of changedPaths) validatePath(changedPath);
    return withStoreLock(storePath(this.dataDir, repository.commonDir), async () => {
      const store = storePath(this.dataDir, repository.commonDir);
      if (!(await snapshotRefsAvailable(this.pi, store, snapshot))) {
        return { matches: false, paths: [snapshot.refName] };
      }
      if (changedPaths.length === 0) return { matches: true };
      const current = (
        await captureFingerprint(this.pi, this.dataDir, {
          ...repository,
          scopes: snapshot.scopes,
        })
      ).snapshot;
      const currentObjectEnv = {
        GIT_ALTERNATE_OBJECT_DIRECTORIES: await fs.realpath(
          path.join(repository.commonDir, "objects"),
        ),
      };
      const paths = new Set<string>([
        ...(await treeDifference(
          this.pi,
          store,
          repository.repositoryRoot,
          snapshot.indexTree,
          current.indexTree,
          changedPaths,
          currentObjectEnv,
        )),
        ...(await treeDifference(
          this.pi,
          store,
          repository.repositoryRoot,
          snapshot.worktreeTree,
          current.worktreeTree,
          changedPaths,
          currentObjectEnv,
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
        expectedHeads.get(workspaceIdentity(workspace)),
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
    preflightOnly = false,
  ): Promise<void> {
    const repository = await resolveRepository(this.pi, snapshot.repositoryRoot);
    if (!repository || repository.commonDir !== snapshot.commonDir) {
      throw new Error(`Repository changed: ${snapshot.repositoryRoot}`);
    }
    validateRef(snapshot.refName);
    for (const changedPath of changedPaths) validatePath(changedPath);
    await withStoreLock(storePath(this.dataDir, repository.commonDir), async () => {
      const store = storePath(this.dataDir, repository.commonDir);
      if (!(await snapshotRefsAvailable(this.pi, store, snapshot))) {
        throw new Error(`Undo snapshot ref is missing or corrupt: ${snapshot.refName}`);
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
              ["ls-tree", "-r", "-z", tree, "--", changedPath],
              privateEnv(store, repository.repositoryRoot),
            );
            for (const item of parseNul(listing)) {
              const entry = parseTreeEntry(item);
              if (entry) entries.set(entry.path, entry);
            }
          }
        }
        const selected = new Set(changedPaths);
        const lstat = async (absolute: string): Promise<Stats | undefined> => {
          try {
            return await fs.lstat(absolute);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT" || code === "ENOTDIR") return undefined;
            throw error;
          }
        };
        const removalRoots = new Set<string>();
        const scheduleRemoval = async (relative: string): Promise<void> => {
          const absolute = path.join(repository.repositoryRoot, relative);
          const stat = await lstat(absolute);
          if (!stat) return;
          if (stat.isDirectory()) {
            const descendants = await fs.readdir(absolute, { recursive: true });
            for (const descendant of descendants) {
              const child = path.join(relative, descendant.toString()).split(path.sep).join("/");
              if (!selected.has(child)) {
                throw new Error(`Unselected path blocks restore: ${relative}`);
              }
            }
          }
          removalRoots.add(relative);
        };
        const hasTargetAtOrBelow = (relative: string): boolean =>
          [...worktreeEntries.keys()].some(
            (entryPath) => entryPath === relative || entryPath.startsWith(`${relative}/`),
          );

        for (const changedPath of changedPaths) {
          if (!hasTargetAtOrBelow(changedPath)) await scheduleRemoval(changedPath);
        }
        for (const entry of worktreeEntries.values()) {
          const components = entry.path.split("/");
          for (let index = 1; index < components.length; index++) {
            const ancestor = components.slice(0, index).join("/");
            const stat = await lstat(path.join(repository.repositoryRoot, ancestor));
            if (stat && !stat.isDirectory()) {
              if (!hasTargetAtOrBelow(ancestor)) {
                throw new Error(`Unselected path blocks restore: ${ancestor}`);
              }
              await scheduleRemoval(ancestor);
            }
          }
          const stat = await lstat(path.join(repository.repositoryRoot, entry.path));
          if (stat?.isDirectory()) {
            if (!selected.has(entry.path)) {
              throw new Error(`Unselected path blocks restore: ${entry.path}`);
            }
            await scheduleRemoval(entry.path);
          }
        }
        if (preflightOnly) return;

        const removalPaths = [...removalRoots]
          .filter(
            (relative) =>
              ![...removalRoots].some(
                (other) => other !== relative && relative.startsWith(`${other}/`),
              ),
          )
          .sort(
            (left, right) => right.split("/").length - left.split("/").length,
          );
        for (const relative of removalPaths) {
          await fs.rm(path.join(repository.repositoryRoot, relative), {
            recursive: true,
            force: true,
          });
        }
        for (const entry of [...worktreeEntries.values()].sort(
          (left, right) => left.path.split("/").length - right.path.split("/").length,
        )) {
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
          const mode = worktreeEntries.get(entry.path)?.mode ?? entry.mode;
          await run(
            this.pi,
            repository.repositoryRoot,
            [
              "update-index",
              "--add",
              "--cacheinfo",
              `${mode},${entry.object},${entry.path}`,
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
      await this.restorePaths(workspace[side], workspace.changedPaths, true);
    }
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
      await withStoreLock(store, async () => {
        if (!(await Bun.file(path.join(store, "HEAD")).exists())) return;
        await deleteSnapshotRefs(this.pi, store, snapshot.refName);
      });
    }
    const refs = catalogRefs(snapshots);
    if (refs.length === 0) return;
    await withFileLock(
      path.join(this.dataDir, "checkpoints.catalog.lock"),
      async () => {
        const deleted = new Set(refs.map(catalogRefKey));
        for (const checkpoint of activeCatalog(await readCatalog(this.dataDir))) {
          if (!checkpoint.refs.some((ref) => deleted.has(catalogRefKey(ref)))) continue;
          await appendCatalogRecord(this.dataDir, {
            type: "delete",
            rootSessionId: checkpoint.rootSessionId,
            turnId: checkpoint.turnId,
            timestamp: this.retention.now(),
            sessionFile: checkpoint.sessionFile,
            refs: checkpoint.refs,
          });
        }
      },
    );
  }
}
