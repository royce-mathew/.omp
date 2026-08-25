import { randomUUID } from "node:crypto";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

import { decideWritePolicy, canonicalizePath } from "./policy.ts";
import { PermissionCoordinator } from "./permissions.ts";
import {
  blockedWritePathForCommand,
  createSandboxedBashOperations,
  type SandboxedBashOperations,
} from "./runtime.ts";
import { SandboxSession } from "./session.ts";

const MAX_INLINE_OUTPUT_BYTES = 64 * 1024;

interface BashInput {
  command: string;
  env?: Record<string, string>;
  timeout?: number;
  cwd?: string;
  pty?: boolean;
  async?: boolean;
}

class TailOutput {
  readonly #chunks: Buffer[] = [];
  #retainedBytes = 0;
  #totalBytes = 0;
  #newlines = 0;
  #endsWithNewline = false;

  append(data: Buffer): void {
    if (data.length === 0) return;
    this.#totalBytes += data.length;
    this.#newlines += data.reduce((count, byte) => count + Number(byte === 10), 0);
    this.#endsWithNewline = data[data.length - 1] === 10;
    this.#chunks.push(data);
    this.#retainedBytes += data.length;
    while (this.#retainedBytes > MAX_INLINE_OUTPUT_BYTES && this.#chunks.length > 0) {
      const first = this.#chunks[0]!;
      const excess = this.#retainedBytes - MAX_INLINE_OUTPUT_BYTES;
      if (first.length <= excess) {
        this.#chunks.shift();
        this.#retainedBytes -= first.length;
      } else {
        this.#chunks[0] = first.subarray(excess);
        this.#retainedBytes -= excess;
      }
    }
  }

  get totalBytes(): number {
    return this.#totalBytes;
  }

  get totalLines(): number {
    if (this.#totalBytes === 0) return 0;
    return this.#newlines + Number(!this.#endsWithNewline);
  }

  snapshot(): { text: string; truncated: boolean } {
    const text = Buffer.concat(this.#chunks, this.#retainedBytes).toString("utf8");
    const truncated = this.#retainedBytes < this.#totalBytes;
    return {
      text: truncated ? `[Output truncated to last ${MAX_INLINE_OUTPUT_BYTES} bytes]\n${text}` : text,
      truncated,
    };
  }
}

function createGrantAwareBashOperations(
  session: SandboxSession,
  permissions: PermissionCoordinator,
  ctx: ExtensionContext,
  commandId: string = randomUUID(),
): SandboxedBashOperations {
  const operations = createSandboxedBashOperations(undefined, commandId);
  return {
    async exec(command, cwd, options) {
      let diagnostics = "";
      const result = await session.run(() => operations.exec(command, cwd, {
        ...options,
        onData: (data) => {
          diagnostics = `${diagnostics}${data.toString()}`.slice(-MAX_INLINE_OUTPUT_BYTES);
          options.onData(data);
        },
      }));
      if (!session.ready || !ctx.hasUI) return result;

      const blocked = blockedWritePathForCommand(commandId, diagnostics);
      if (!blocked) return result;
      const path = canonicalizePath(blocked, cwd);
      const config = await session.config(ctx);
      const effective = await session.effective(ctx);
      const decision = decideWritePolicy(
        path,
        effective.writePaths,
        [...(config.filesystem?.denyWrite ?? []), ...session.protectedWritePaths(ctx)],
        cwd,
      );
      if (decision === "deny") return result;
      if (decision === "allow") await session.refresh(ctx);
      else if (!await permissions.request(ctx, "write", path, config)) return result;

      // The command may have completed irreversible work before the blocked
      // write, so grant access without replaying it.
      options.onData(Buffer.from(`\nWrite access granted for "${path}"; rerun the command to retry.\n`));
      return result;
    },
  };
}

async function executeSandboxedCommand(
  session: SandboxSession,
  permissions: PermissionCoordinator,
  ctx: ExtensionContext,
  input: BashInput,
  signal?: AbortSignal,
  onUpdate?: (result: { content: Array<{ type: "text"; text: string }> }) => void,
  commandId?: string,
) {
  if (input.async) throw new Error("Background bash is unavailable while sandboxing is enabled.");
  if (input.pty) throw new Error("PTY bash is unavailable while sandboxing is enabled.");
  const output = new TailOutput();
  const cwd = input.cwd ?? ctx.cwd;
  const startedAt = Date.now();
  const operations = createGrantAwareBashOperations(session, permissions, ctx, commandId);
  try {
    const result = await operations.exec(input.command, cwd, {
      signal,
      timeout: input.timeout ?? 300,
      env: { ...process.env, ...input.env },
      onData: (data) => {
        output.append(data);
        if (onUpdate) {
          const snapshot = output.snapshot();
          onUpdate({ content: [{ type: "text", text: snapshot.text || "(no output)" }] });
        }
      },
    });
    const snapshot = output.snapshot();
    const failed = result.exitCode !== 0 && result.exitCode !== null;
    const text = [
      snapshot.text || "(no output)",
      ...(failed ? ["", `[Command exited with code ${result.exitCode}]`] : []),
    ].join("\n");
    return {
      content: [{ type: "text" as const, text }],
      details: {
        exitCode: result.exitCode,
        wallTimeMs: Date.now() - startedAt,
        truncated: snapshot.truncated,
        totalBytes: output.totalBytes,
        totalLines: output.totalLines,
      },
      isError: failed,
    };
  } catch (error) {
    const snapshot = output.snapshot();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(snapshot.text ? `${snapshot.text}\n\n[${message}]` : message, { cause: error });
  }
}

export function registerSandboxBashTool(
  pi: ExtensionAPI,
  session: SandboxSession,
  permissions: PermissionCoordinator,
): void {
  const Type = pi.typebox.Type;
  const parameters = Type.Object({
    command: Type.String({ description: "command to execute" }),
    env: Type.Optional(Type.Record(Type.String(), Type.String(), {
      description: "extra environment variables",
    })),
    timeout: Type.Optional(Type.Number({
      description: "timeout in seconds; 0 disables the deadline",
    })),
    cwd: Type.Optional(Type.String({ description: "working directory" })),
    pty: Type.Optional(Type.Boolean({
      description: "unsupported while sandboxing is enabled",
    })),
    async: Type.Optional(Type.Boolean({
      description: "unsupported while sandboxing is enabled",
    })),
  });

  pi.registerTool({
    name: "bash",
    label: "Bash",
    description: "Execute a foreground shell command. When sandboxing is enabled, filesystem and network access follow sandbox.json.",
    parameters,
    approval: "exec",
    loadMode: "essential",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!session.active) {
        if (!ctx.invokeTool) throw new Error("OMP's native bash delegation is unavailable.");
        return ctx.invokeTool(params as Record<string, unknown>, { signal, onUpdate });
      }
      if (!session.ready) throw new Error(session.blockedMessage());
      return executeSandboxedCommand(
        session,
        permissions,
        ctx,
        params as BashInput,
        signal,
        onUpdate,
        toolCallId,
      );
    },
  });
}

export async function executeSandboxedUserBash(
  session: SandboxSession,
  permissions: PermissionCoordinator,
  ctx: ExtensionContext,
  command: string,
  cwd: string,
) {
  const executed = await executeSandboxedCommand(
    session,
    permissions,
    ctx,
    { command, cwd, timeout: 300 },
  );
  const output = executed.content[0]?.text ?? "";
  const details = executed.details;
  return {
    output,
    exitCode: details.exitCode ?? undefined,
    cancelled: false,
    truncated: details.truncated,
    totalLines: details.totalLines,
    totalBytes: details.totalBytes,
    outputLines: output.length === 0 ? 0 : output.split("\n").length,
    outputBytes: Buffer.byteLength(output),
    workingDir: cwd,
  };
}
