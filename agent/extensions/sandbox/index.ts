import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Key } from "@oh-my-pi/pi-tui";

import { getConfigPaths, ensureGlobalConfigTemplate, type SandboxConfig } from "./config.ts";
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

export default function sandboxExtension(pi: ExtensionAPI): void {
  ensureGlobalConfigTemplate();

  pi.registerFlag("no-sandbox", {
    description: "Disable filesystem and network sandboxing for this session",
    type: "boolean",
    default: false,
  });

  const session = new SandboxSession();
  const permissions = new PermissionCoordinator(pi, session);
  registerSandboxBashTool(pi, session, permissions);
  const hostTools = createHostToolVisibility(pi);

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
    if (pi.getFlag("no-sandbox") as boolean) {
      await hostTools.restore();
      ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
      return;
    }
    let config: SandboxConfig;
    try {
      config = await session.reloadConfig(ctx);
    } catch (error) {
      session.fail(ctx, error);
      await hostTools.hide();
      ctx.ui.notify(`${session.blockedMessage()}. Fix the configuration or explicitly disable sandboxing.`, "error");
      return;
    }
    if (config.enabled === false) {
      await hostTools.restore();
      ctx.ui.notify("Sandbox disabled by configuration", "info");
      return;
    }
    await session.enable(ctx, true);
    await hostTools.hide();
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
    if (config.enabled === false) return;
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
      const denyWrite = [...(config.filesystem?.denyWrite ?? []), ...session.protectedWritePaths(ctx)];
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
    session.begin();
    await activateForContext(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    await session.reset(ctx);
    await activateForContext(ctx);
  });

  pi.on("session_shutdown", async () => {
    await session.shutdown();
    await hostTools.restore();
  });

  pi.registerShortcut(Key.alt("s"), {
    description: "Toggle sandboxing for this session",
    handler: async (ctx) => {
      if (session.active) {
        if (await session.disable(ctx)) {
          await hostTools.restore();
          ctx.ui.notify("Sandbox disabled", "info");
        }
      } else {
        const enabled = await session.enable(ctx);
        await hostTools.hide();
        if (enabled) ctx.ui.notify("Sandbox enabled", "info");
      }
    },
  });

  pi.registerCommand("sandbox-enable", {
    description: "Enable sandboxing for this session",
    handler: async (_args, ctx) => {
      const enabled = await session.enable(ctx);
      await hostTools.hide();
      if (enabled) ctx.ui.notify("Sandbox enabled", "info");
    },
  });

  pi.registerCommand("sandbox-disable", {
    description: "Disable sandboxing for this session",
    handler: async (_args, ctx) => {
      if (await session.disable(ctx)) {
        await hostTools.restore();
        ctx.ui.notify("Sandbox disabled", "info");
      }
    },
  });

  pi.registerCommand("sandbox-allow", {
    description: "Allow a domain or read/write path",
    handler: async (args, ctx) => {
      const [kind, ...parts] = args.trim().split(/\s+/);
      const rawValue = parts.join(" ");
      if ((kind !== "domain" && kind !== "read" && kind !== "write") || !rawValue) {
        ctx.ui.notify("Usage: /sandbox-allow <domain|read|write> <value>", "error");
        return;
      }
      const value = kind === "domain" ? rawValue.toLowerCase() : canonicalizePath(rawValue, ctx.cwd);
      const config = await session.config(ctx);
      const timeout = permissionPromptTimeoutMs(config.permissionPromptTimeoutSeconds);
      const confirmed = await ctx.ui.confirm(
        "Sandbox permission",
        `Allow ${kind} access to "${value}" for this session?`,
        { timeout },
      );
      if (!confirmed) return;
      await permissions.apply(ctx, "session", kind, value);
      ctx.ui.notify(`Allowed ${kind}: ${value}`, "info");
    },
  });

  pi.registerCommand("sandbox", {
    description: "Show sandbox configuration and session permissions",
    handler: async (_args, ctx) => {
      const config = await session.config(ctx);
      ctx.ui.notify(
        `${session.active && session.ready ? "Enabled" : session.active ? `Failed closed (${session.failure ?? "initialization failed"})` : "Disabled"}\n\n${formatSandboxConfiguration(
          config,
          getConfigPaths(ctx.cwd),
          session.allowances,
          ctx.isProjectTrusted(),
        )}`,
        "info",
      );
    },
  });
}
