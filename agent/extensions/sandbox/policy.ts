import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { Patch } from "@oh-my-pi/hashline";

export type PermissionScope = "abort" | "session" | "project" | "global";

const FILESYSTEM_READ_TOOLS: Record<string, true> = {
  glob: true,
  grep: true,
  read: true,
};
const HOST_FILESYSTEM_TOOLS: Record<string, true> = {
  glob: true,
  grep: true,
  inspect_image: true,
  lsp: true,
  notebook: true,
  python: true,
};

export const isHostFilesystemTool = (toolName: string): boolean =>
  Object.hasOwn(HOST_FILESYSTEM_TOOLS, toolName);

function filesystemReadTarget(path: string, cwd: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return undefined;
  let candidate = path;
  while (!existsSync(expandPath(candidate, cwd))) {
    const colon = candidate.lastIndexOf(":");
    if (colon <= 0) break;
    candidate = candidate.slice(0, colon);
  }
  return candidate;
}

/** Resolve the host path read by an OMP filesystem tool. */
export function readPathForToolCall(
  toolName: string,
  input: unknown,
  cwd: string,
): string | undefined {
  if (!Object.hasOwn(FILESYSTEM_READ_TOOLS, toolName) || !input || typeof input !== "object") {
    return undefined;
  }
  const path = "path" in input ? input.path : undefined;
  if (path !== undefined && typeof path !== "string") return undefined;
  if (toolName === "read" && path === undefined) return undefined;
  const target = filesystemReadTarget(path ?? ".", cwd);
  return target === undefined ? undefined : canonicalizePath(target, cwd);
}

/** Resolve every destination from OMP's canonical edit model. */
export function writePathsForToolCall(
  toolName: string,
  input: unknown,
  cwd: string,
): string[] | undefined {
  if ((toolName !== "write" && toolName !== "edit") || !input || typeof input !== "object") {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  let rawPaths: string[];
  if (toolName === "write") {
    if (typeof record.path !== "string") return undefined;
    rawPaths = [record.path];
  } else {
    const rawInput = typeof record.input === "string"
      ? record.input
      : typeof record._input === "string"
        ? record._input
        : undefined;
    if (rawInput === undefined) {
      if (typeof record.path !== "string") return undefined;
      rawPaths = [record.path];
    } else {
      const sections = Patch.parse(rawInput, { cwd }).sections;
      if (sections.length === 0) return undefined;
      rawPaths = sections.flatMap((section) => [
        section.path,
        ...(section.fileOp?.kind === "move" ? [section.fileOp.dest] : []),
      ]);
    }
  }
  return [...new Set(rawPaths
    .filter((path) => path.length > 0 && !/^[a-z][a-z0-9+.-]*:\/\//i.test(path))
    .map((path) => canonicalizePath(path, cwd)))];
}

function splitDomainPort(pattern: string): { host: string; port?: number } {
  if (pattern.startsWith("[")) {
    const close = pattern.indexOf("]");
    if (close < 0) return { host: pattern };
    const port = pattern.slice(close + 1).match(/^:(\d+)$/)?.[1];
    return { host: pattern.slice(1, close), ...(port ? { port: Number(port) } : {}) };
  }
  const match = pattern.match(/^(.*):(\d+)$/);
  return match?.[1] && match[2]
    ? { host: match[1], port: Number(match[2]) }
    : { host: pattern };
}

export function domainMatchesPattern(
  domain: string,
  pattern: string,
  port?: number,
): boolean {
  const normalizedDomain = domain.toLowerCase();
  const parsed = splitDomainPort(pattern.toLowerCase());
  if (parsed.port !== undefined && parsed.port !== port) return false;
  if (parsed.host.startsWith("*.")) {
    return normalizedDomain.endsWith(`.${parsed.host.slice(2)}`);
  }
  return normalizedDomain === parsed.host;
}

export function domainIsAllowed(domain: string, patterns: string[], port?: number): boolean {
  return patterns.some((pattern) => domainMatchesPattern(domain, pattern, port));
}

export interface NetworkTarget {
  host: string;
  port: number;
}

export function formatNetworkTarget(target: NetworkTarget): string {
  const host = target.host.includes(":") ? `[${target.host}]` : target.host;
  return `${host}:${target.port}`;
}

/** Extract literal HTTP(S) targets so permission can be requested before execution. */
export function extractNetworkTargetsFromCommand(command: string): NetworkTarget[] {
  const targets = new Map<string, NetworkTarget>();
  const expression = /(https?):\/\/(\[[^\]]+\]|[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)(?::(\d{1,5}))?/g;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(command)) !== null) {
    if (!match[1] || !match[2]) continue;
    const host = match[2].replace(/^\[|\]$/g, "").toLowerCase();
    const port = match[3] ? Number(match[3]) : match[1] === "https" ? 443 : 80;
    const target = { host, port };
    targets.set(`${host}:${port}`, target);
  }
  return [...targets.values()];
}

function expandPath(path: string, cwd: string): string {
  const expanded = path.replace(/^~(?=$|\/)/, homedir());
  return resolve(cwd, expanded);
}

/** Resolve symlinks in both existing paths and the existing prefix of new paths. */
export function canonicalizePath(path: string, cwd = process.cwd()): string {
  const absolutePath = expandPath(path, cwd);
  try {
    return realpathSync.native(absolutePath);
  } catch {
    const tail: string[] = [];
    let probe = absolutePath;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) return absolutePath;
      tail.unshift(basename(probe));
      probe = parent;
    }
    try {
      return resolve(realpathSync.native(probe), ...tail);
    } catch {
      return absolutePath;
    }
  }
}

function globExpression(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Match literal directory prefixes and git-style *, **, and ? path patterns. */
export function matchesPath(path: string, patterns: string[], cwd = process.cwd()): boolean {
  const absolutePath = canonicalizePath(path, cwd);
  return patterns.some((pattern) => {
    if (/[*?]/.test(pattern)) {
      return globExpression(expandPath(pattern, cwd)).test(absolutePath);
    }
    return containsPath(canonicalizePath(pattern, cwd), absolutePath);
  });
}

function matchingSpecificity(path: string, patterns: string[], cwd: string): number {
  return patterns.reduce((highest, pattern) => {
    if (!matchesPath(path, [pattern], cwd)) return highest;
    const normalized = expandPath(pattern, cwd).replace(/[*?].*$/, "");
    return Math.max(highest, normalized.length);
  }, -1);
}

/** More-specific read denies survive broad allows; an equally specific allow wins. */
export function decideReadPolicy(
  path: string,
  allowRead: string[],
  denyRead: string[],
  cwd = process.cwd(),
): "allow" | "prompt" {
  const allowSpecificity = matchingSpecificity(path, allowRead, cwd);
  const denySpecificity = matchingSpecificity(path, denyRead, cwd);
  return allowSpecificity >= 0 && allowSpecificity >= denySpecificity ? "allow" : "prompt";
}

export function decideWritePolicy(
  path: string,
  allowWrite: string[],
  denyWrite: string[],
  cwd = process.cwd(),
): "allow" | "deny" | "prompt" {
  if (matchesPath(path, denyWrite, cwd)) return "deny";
  if (allowWrite.length > 0 && matchesPath(path, allowWrite, cwd)) return "allow";
  return "prompt";
}
