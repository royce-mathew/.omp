import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Key } from "@oh-my-pi/pi-tui";

import { ensureGlobalConfigTemplate, type SandboxConfig } from "./config.ts";
import { getSandboxCoordinator, type SandboxCoordinator } from "./coordinator.ts";
import {
  canonicalizePath,
  decideReadPolicy,
  decideWritePolicy,
  domainIsAllowed,
  extractNetworkTargetsFromCommand,
  formatNetworkTarget,
  isHostFilesystemTool,
  readPathForToolCall,
  writePathsForToolCall,
} from "./policy.ts";
import {
  formatSandboxConfiguration,
  permissionPromptTimeoutMs,
} from "./ui.ts";
import { PermissionCoordinator } from "./permissions.ts";
import { SandboxSession } from "./session.ts";
import { executeSandboxedUserBash, registerSandboxBashTool } from "./tools.ts";

export function createHostToolVisibility(
  pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
) {
  let hidden: string[] | undefined;
  return {
    async hide(): Promise<void> {
      const active = pi.getActiveTools();
      hidden ??= active.filter(isHostFilesystemTool);
      const visible = active.filter((name) => !isHostFilesystemTool(name));
      if (visible.length !== active.length) await pi.setActiveTools(visible);
    },
    async restore(): Promise<void> {
      if (!hidden?.length) {
        hidden = undefined;
        return;
      }
      const active = pi.getActiveTools();
      await pi.setActiveTools([...active, ...hidden.filter((name) => !active.includes(name))]);
      hidden = undefined;
    },
  };
}

export function sandboxToolBlockReason(
  toolName: string,
  ready: boolean,
  unavailable: string,
): string | undefined {
  if (!ready && toolName === "bash") return unavailable;
  if (!isHostFilesystemTool(toolName)) return undefined;
  return ready
    ? `The ${toolName} tool bypasses the OS sandbox and is unavailable while sandboxing is enabled. Use sandboxed bash instead.`
    : unavailable;
}

export function registerSandboxExtension(
  pi: ExtensionAPI,
  coordinator: SandboxCoordinator = getSandboxCoordinator(process.cwd()),
): SandboxSession {
  pi.registerFlag("no-sandbox", {
    description: "Start with filesystem and network sandboxing disabled",
    type: "boolean",
    default: false,
  });
  const hostTools = createHostToolVisibility(pi);
  const session = new SandboxSession({ coordinator, hostTools });
  const permissions = new PermissionCoordinator(pi, session);
  registerSandboxBashTool(pi, session, permissions);

  const checkCommandDomains = async (
    command: string,
    ctx: ExtensionContext,
  ): Promise<string | undefined> => {
    const config = await session.config(ctx);
    const allowances = await session.effective(ctx);
    for (const target of extractNetworkTargetsFromCommand(command)) {
      if (domainIsAllowed(target.host, allowances.domains, target.port)) continue;
      const rule = formatNetworkTarget(target);
      if (!await permissions.request(ctx, "domain", rule, config)) return rule;
    }
    return undefined;
  };

  const activateForContext = async (ctx: ExtensionContext): Promise<void> => {
    permissions.reset();
    await session.begin(ctx, pi.getFlag("no-sandbox") as boolean);
    const status = coordinator.status();
    if (status.state.kind === "enabled") return;
    if (status.state.kind === "disabled") {
      const reason = status.state.reason === "startup-flag"
        ? "--no-sandbox startup default"
        : "startup configuration";
      ctx.ui.notify(`Sandbox disabled by ${reason}`, "info");
      return;
    }
    const reason = status.state.kind === "failed"
      ? status.state.reason
      : "sandbox initialization is still in progress";
    const recovery = status.configurationError
      ? " Fix sandbox.yaml, then reload plugins or restart OMP."
      : "";
    ctx.ui.notify(`Sandbox unavailable; commands blocked: ${reason}.${recovery}`, "error");
  };

  pi.on("user_bash", async (event, ctx) => {
    if (!session.active) return;
    if (!session.ready) {
      const output = session.blockedMessage();
      return {
        result: {
          output,
          exitCode: 1,
          cancelled: false,
          truncated: false,
          totalLines: 1,
          totalBytes: Buffer.byteLength(output),
          outputLines: 1,
          outputBytes: Buffer.byteLength(output),
          workingDir: event.cwd,
        },
      };
    }
    const blockedDomain = await checkCommandDomains(event.command, ctx);
    if (blockedDomain) {
      const output = `Sandbox blocked network access to "${blockedDomain}".`;
      return {
        result: {
          output,
          exitCode: 1,
          cancelled: false,
          truncated: false,
          totalLines: 1,
          totalBytes: Buffer.byteLength(output),
          outputLines: 1,
          outputBytes: Buffer.byteLength(output),
          workingDir: event.cwd,
        },
      };
    }
    return {
      result: await executeSandboxedUserBash(session, permissions, ctx, event.command, event.cwd),
    };
  });

  pi.on("user_python", (_event) => {
    if (!session.active) return;
    const output = "Python execution is unavailable while sandboxing is enabled. Use sandboxed bash.";
    return {
      result: {
        output,
        exitCode: 1,
        cancelled: false,
        truncated: false,
        totalLines: 1,
        totalBytes: Buffer.byteLength(output),
        outputLines: 1,
        outputBytes: Buffer.byteLength(output),
        displayOutputs: [],
        stdinRequested: false,
      },
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!session.active) return;
    const backstopReason = sandboxToolBlockReason(event.toolName, session.ready, session.blockedMessage());
    if (backstopReason) {
      return {
        block: true,
        reason: backstopReason,
      };
    }
    const config = await session.config(ctx);
    const effectivePermissions = await session.effective(ctx);

    if (session.ready && event.toolName === "bash") {
      const command = event.input.command;
      if (typeof command !== "string") {
        return { block: true, reason: "Sandbox could not determine the bash command." };
      }
      const blockedDomain = await checkCommandDomains(command, ctx);
      if (blockedDomain) {
        return { block: true, reason: `Sandbox blocked network access to "${blockedDomain}".` };
      }
      return;
    }

    const readPath = readPathForToolCall(event.toolName, event.input, ctx.cwd);
    if (readPath !== undefined) {
      const denyRead = config.filesystem?.denyRead ?? [];
      if (decideReadPolicy(readPath, effectivePermissions.readPaths, denyRead, ctx.cwd) === "prompt"
        && !await permissions.request(ctx, "read", readPath, config)) {
        return { block: true, reason: `Sandbox denied read access to "${readPath}".` };
      }
      return;
    }

    if (event.toolName === "write" || event.toolName === "edit") {
      const paths = writePathsForToolCall(event.toolName, event.input, ctx.cwd);
      if (paths === undefined) {
        return {
          block: true,
          reason: `Sandbox could not determine the ${event.toolName} destination.`,
        };
      }
      const denyWrite = [...(config.filesystem?.denyWrite ?? []), ...session.protectedWritePaths()];
      for (const path of paths) {
        const decision = decideWritePolicy(path, effectivePermissions.writePaths, denyWrite, ctx.cwd);
        if (decision === "deny") {
          return {
            block: true,
            reason: `Sandbox hard-blocked write access to "${path}" (denyWrite).`,
          };
        }
        if (decision === "prompt" && !await permissions.request(ctx, "write", path, config)) {
          return { block: true, reason: `Sandbox denied write access to "${path}".` };
        }
      }
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    await activateForContext(ctx);
  });
  pi.on("session_switch", async (_event, ctx) => {
    permissions.reset();
    await session.switchContext(ctx);
  });
  pi.on("session_shutdown", async () => {
    await session.shutdown();
  });

  const notifyCommandFailure = (ctx: ExtensionContext, error: unknown): void => {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  };
  const enable = async (ctx: ExtensionContext): Promise<void> => {
    try {
      if (await session.enable(ctx)) ctx.ui.notify("Sandbox enabled for all agents", "info");
    } catch (error) {
      notifyCommandFailure(ctx, error);
    }
  };
  const disable = async (ctx: ExtensionContext): Promise<void> => {
    try {
      if (await session.disable(ctx)) ctx.ui.notify("Sandbox disabled for all agents", "info");
    } catch (error) {
      notifyCommandFailure(ctx, error);
    }
  };
  pi.registerShortcut(Key.alt("s"), {
    description: "Toggle sandboxing for all agents",
    handler: async (ctx) => {
      if (session.active) await disable(ctx);
      else await enable(ctx);
    },
  });
  pi.registerCommand("sandbox-enable", {
    description: "Enable sandboxing for all agents",
    handler: async (_args, ctx) => enable(ctx),
  });
  pi.registerCommand("sandbox-disable", {
    description: "Disable sandboxing for all agents",
    handler: async (_args, ctx) => disable(ctx),
  });

  pi.registerCommand("sandbox-allow", {
    description: "Persist and apply a domain or read/write path",
    handler: async (args, ctx) => {
      try {
        coordinator.assertTransitionAvailable();
        const [kind, ...parts] = args.trim().split(/\s+/);
        const rawValue = parts.join(" ");
        if ((kind !== "domain" && kind !== "read" && kind !== "write") || !rawValue) {
          ctx.ui.notify("Usage: /sandbox-allow <domain|read|write> <value>", "error");
          return;
        }
        const value = kind === "domain" ? rawValue.toLowerCase() : canonicalizePath(rawValue, ctx.cwd);
        const config = await session.config();
        const timeout = permissionPromptTimeoutMs(config.permissionPromptTimeoutSeconds);
        const status = coordinator.status();
        const scope = status.projectConfigLoaded ? "project" : "global";
        const target = scope === "project" ? status.paths.projectPath : status.paths.globalPath;
        const confirmed = await ctx.ui.confirm(
          "Persist sandbox permission?",
          `Add ${kind} access to "${value}" in ${target}?`,
          { timeout },
        );
        if (!confirmed) return;
        await permissions.apply(ctx, scope, kind, value);
        ctx.ui.notify(`Allowed ${kind}: ${value}`, "info");
      } catch (error) {
        notifyCommandFailure(ctx, error);
      }
    },
  });

  pi.registerCommand("sandbox", {
    description: "Show sandbox runtime and root configuration",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        formatSandboxConfiguration(coordinator.status(), session.allowances),
        "info",
      );
    },
  });
  return session;
}

export default function sandboxExtension(pi: ExtensionAPI): void {
  ensureGlobalConfigTemplate();
  registerSandboxExtension(pi);
}
