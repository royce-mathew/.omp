import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import {
  SandboxManager,
  type SandboxAskCallback,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";

import type { SandboxConfig } from "./config.ts";
import { canonicalizePath, domainIsAllowed } from "./policy.ts";

export interface SessionAllowances {
  domains: string[];
  readPaths: string[];
  writePaths: string[];
}

export interface EffectiveAllowances {
  domains: string[];
  readPaths: string[];
  writePaths: string[];
}

const unique = (values: string[]): string[] => [...new Set(values)];
const RUNTIME_SUPPORT_PATHS = [process.execPath];

export function resolveAllowances(
  config: SandboxConfig,
  allowances?: SessionAllowances,
): EffectiveAllowances {
  const writePaths = unique([
    ...(config.filesystem?.allowWrite ?? []),
    ...(allowances?.writePaths ?? []),
  ]);
  return {
    domains: unique([...(config.network?.allowedDomains ?? []), ...(allowances?.domains ?? [])]),
    readPaths: unique([
      ...(config.filesystem?.allowRead ?? []),
      ...(allowances?.readPaths ?? []),
      ...writePaths,
    ]),
    writePaths,
  };
}

export function createNetworkAskCallback(allowedDomains: string[]): SandboxAskCallback {
  return async ({ host, port }) => domainIsAllowed(host, allowedDomains, port);
}

const FILESYSTEM_GLOB = /[*?\[\]]/;

function canonicalizePattern(path: string, cwd: string): string {
  return FILESYSTEM_GLOB.test(path) ? path : canonicalizePath(path, cwd);
}

function assertSupportedFilesystemPatterns(
  config: SandboxConfig,
  platform: NodeJS.Platform,
): void {
  if (platform !== "linux") return;
  const filesystem = config.filesystem;
  const fields = [
    ["denyRead", filesystem?.denyRead],
    ["allowRead", filesystem?.allowRead],
    ["allowWrite", filesystem?.allowWrite],
    ["denyWrite", filesystem?.denyWrite],
  ] as const;
  for (const [field, paths] of fields) {
    const unsupported = paths?.find((path) => FILESYSTEM_GLOB.test(path));
    if (unsupported !== undefined) {
      throw new Error(
        `Linux sandboxing does not support filesystem globs; replace filesystem.${field} rule "${unsupported}" with a literal path.`,
      );
    }
  }
}

export function buildRuntimeConfig(
  config: SandboxConfig,
  cwd: string,
  allowances?: SessionAllowances,
  protectedWritePaths: string[] = [],
  platform: NodeJS.Platform = process.platform,
): SandboxRuntimeConfig {
  assertSupportedFilesystemPatterns(config, platform);
  const effective = resolveAllowances(config, allowances);
  const canonicalize = (paths: string[]) =>
    unique(paths.map((path) => canonicalizePattern(path, cwd)));
  const { enabled: _enabled, permissionPromptTimeoutSeconds: _timeout, network, ...runtimeConfig } = config;
  return {
    ...runtimeConfig,
    network: {
      ...network,
      allowedDomains: effective.domains,
      deniedDomains: config.network?.deniedDomains ?? [],
    },
    filesystem: {
      ...config.filesystem,
      denyRead: canonicalize(config.filesystem?.denyRead ?? []),
      allowRead: canonicalize([...effective.readPaths, ...RUNTIME_SUPPORT_PATHS]),
      allowWrite: canonicalize(effective.writePaths),
      denyWrite: canonicalize([
        ...(config.filesystem?.denyWrite ?? []),
        ...protectedWritePaths,
      ]),
    },
    // The proxy is still the only route out; this enables tools that query
    // host network configuration before honoring proxy environment variables.
    enableWeakerNetworkIsolation: true,
  };
}

export async function initializeSandbox(
  config: SandboxConfig,
  cwd: string,
  allowances?: SessionAllowances,
  protectedWritePaths: string[] = [],
): Promise<void> {
  const runtimeConfig = buildRuntimeConfig(config, cwd, allowances, protectedWritePaths);
  await SandboxManager.initialize(
    runtimeConfig,
    createNetworkAskCallback(runtimeConfig.network?.allowedDomains ?? []),
  );
}

export async function resetSandbox(): Promise<void> {
  await SandboxManager.reset();
}

/** Keep global runtime transitions from racing concurrently executing commands. */
export class SandboxRuntimeGate {
  private activeExecutions = 0;
  private executionGate: Promise<void> = Promise.resolve();
  private transitionQueue: Promise<void> = Promise.resolve();
  private idleWaiter: Promise<void> | undefined;
  private signalIdle: (() => void) | undefined;

  async run<T>(operation: () => Promise<T>): Promise<T> {
    while (true) {
      const gate = this.executionGate;
      await gate;
      // A transition may have closed the gate while this continuation was
      // queued behind the previously resolved promise.
      if (gate !== this.executionGate) continue;
      this.activeExecutions++;
      try {
        return await operation();
      } finally {
        this.activeExecutions--;
        if (this.activeExecutions === 0) {
          this.signalIdle?.();
          this.signalIdle = undefined;
          this.idleWaiter = undefined;
        }
      }
    }
  }

  async transition<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.transitionQueue;
    const { promise: current, resolve: finishTransition } = Promise.withResolvers<void>();
    // Close the execution gate synchronously, before the first await. Later
    // transitions replace it with their own promise, keeping callers blocked
    // until the complete queued transition sequence has settled.
    this.transitionQueue = current;
    this.executionGate = current;
    await previous.catch(() => undefined);

    try {
      if (this.activeExecutions > 0) {
        if (!this.idleWaiter) {
          const { promise, resolve } = Promise.withResolvers<void>();
          this.idleWaiter = promise;
          this.signalIdle = resolve;
        }
        await this.idleWaiter;
      }
      return await operation();
    } finally {
      finishTransition();
    }
  }
}

export function supportsNodeEnvProxy(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return (major === 22 && minor >= 21) || major >= 24;
}

/** Parse common shell diagnostics emitted for a blocked write redirection. */
export function extractBlockedWritePath(output: string): string | undefined {
  const shellMatch = output.match(
    /(?:\/bin\/)?(?:bash|sh|zsh): (?:line \d+: )?([^\s:]+): Operation not permitted/,
  );
  const applicationMatch = output.match(
    /(?:EACCES|EPERM): (?:permission denied|operation not permitted),? (?:open|mkdir|rename|unlink)?\s*['"]?([^'"\s]+)['"]?/i,
  );
  return shellMatch?.[1] ?? applicationMatch?.[1];
}

/** Prefer runtime-attributed violations, with bounded shell diagnostics as fallback. */
export function blockedWritePathForCommand(
  commandId: string,
  diagnostics: string,
): string | undefined {
  const violations = SandboxManager.getSandboxViolationStore()
    .getViolationsForCommand(commandId)
    .map((violation) => violation.line)
    .join("\n");
  return extractBlockedWritePath(violations) ?? extractBlockedWritePath(diagnostics);
}

interface SandboxedProcessOptions {
  signal?: AbortSignal;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  input?: Buffer | string;
  onData?: (data: Buffer) => void;
  commandId?: string;
}

export interface SandboxedBashOperations {
  exec(
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<{ exitCode: number | null }>;
}

function resolveShellConfig(shellPath: string | undefined): { shell: string; args: string[] } {
  if (shellPath !== undefined) {
    if (!existsSync(shellPath)) throw new Error(`Configured shell path does not exist: ${shellPath}`);
    return { shell: shellPath, args: ["-c"] };
  }
  if (existsSync("/bin/bash")) return { shell: "/bin/bash", args: ["-c"] };
  const shell = process.env.SHELL;
  if (shell && existsSync(shell)) return { shell, args: ["-c"] };
  return { shell: "/bin/sh", args: ["-c"] };
}

async function runSandboxedProcess(
  command: string,
  cwd: string,
  shellPath: string | undefined,
  options: SandboxedProcessOptions,
): Promise<{ exitCode: number | null }> {
  if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
  if (options.signal?.aborted) throw new Error("aborted");
  const { shell, args } = resolveShellConfig(shellPath);
  const wrappedCommand = await SandboxManager.wrapWithSandbox(
    command,
    shell,
    undefined,
    options.signal,
    options.commandId ? { commandId: options.commandId, commandText: command } : undefined,
  );
  // wrapWithSandbox() acquires per-command Linux runtime state. If cancellation
  // won the race with wrapping, release that state without ever spawning.
  if (options.signal?.aborted) {
    SandboxManager.cleanupAfterCommand();
    throw new Error("aborted");
  }

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(shell, [...args, wrappedCommand], {
      cwd,
      env: options.env,
      detached: true,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
  } catch (error) {
    SandboxManager.cleanupAfterCommand();
    throw error;
  }

  const { promise, resolve, reject } = Promise.withResolvers<{ exitCode: number | null }>();
  let settled = false;
  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;

  const killProcessGroup = (): void => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  const settle = (
    error?: unknown,
    result?: { exitCode: number | null },
  ): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutHandle);
    options.signal?.removeEventListener("abort", killProcessGroup);
    SandboxManager.cleanupAfterCommand();
    if (error !== undefined) reject(error);
    else resolve(result!);
  };

  if (options.timeout !== undefined && options.timeout > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      killProcessGroup();
    }, options.timeout * 1000);
  }
  child.stdout?.on("data", (data: Buffer) => options.onData?.(data));
  child.stderr?.on("data", (data: Buffer) => options.onData?.(data));
  child.once("error", (error) => settle(error));
  options.signal?.addEventListener("abort", killProcessGroup, { once: true });
  // AbortSignal does not replay an abort to a newly attached listener.
  if (options.signal?.aborted) killProcessGroup();
  child.once("close", (code) => {
    if (options.signal?.aborted) settle(new Error("aborted"));
    else if (timedOut) settle(new Error(`timeout:${options.timeout}`));
    else settle(undefined, { exitCode: code });
  });
  if (options.input !== undefined) child.stdin?.end(options.input);
  return promise;
}

export function createSandboxedBashOperations(
  shellPath: string | undefined,
  commandId?: string,
): SandboxedBashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      const result = await runSandboxedProcess(command, cwd, shellPath, {
        onData,
        signal,
        timeout,
        env,
        commandId,
      });
      return { exitCode: result.exitCode };
    },
  };
}
