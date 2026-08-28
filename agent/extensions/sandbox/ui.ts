import { dirname } from "node:path";

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent"

import {
  DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS,
  getConfigPaths,
  type SandboxConfig,
} from "./config.ts";
import type { SandboxCoordinatorStatus, SandboxDisabledReason } from "./coordinator.ts";
import type { PermissionScope } from "./policy.ts";
import type { SessionAllowances } from "./runtime.ts";

export interface PermissionPromptResult {
  action: PermissionScope;
  value: string;
}

export function permissionPromptTimeoutMs(timeoutSeconds: unknown): number | undefined {
  const seconds = timeoutSeconds === undefined
    ? DEFAULT_PERMISSION_PROMPT_TIMEOUT_SECONDS
    : timeoutSeconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return Math.min(seconds * 1000, 2_147_483_647);
}

export async function promptPermission(
  ctx: ExtensionContext,
  title: string,
  value: string,
  timeoutSeconds: unknown,
  allowParent = false,
  configPaths?: { globalPath: string; projectPath: string },
  projectTrusted = ctx.isProjectTrusted(),
): Promise<PermissionPromptResult> {
  if (!ctx.hasUI) return { action: "abort", value };
  const parentValue = allowParent ? dirname(value) : value;
  const hasDistinctParent = allowParent && parentValue !== value;
  const sessionOption = "Allow this path for this session";
  const parentOption = "Allow parent directory…";
  const projectOption = "Allow this path for this project";
  const globalOption = "Allow this path for all projects";
  const abortOption = "Abort (keep blocked)";
  const options = [
    sessionOption,
    ...(hasDistinctParent ? [parentOption] : []),
    ...(projectTrusted ? [projectOption] : []),
    globalOption,
    abortOption,
  ];
  const selected = await ctx.ui.select(title, options, {
    timeout: permissionPromptTimeoutMs(timeoutSeconds),
  });

  if (!selected || selected === abortOption) return { action: "abort", value };

  let selectedValue = value;
  let scope: Exclude<PermissionScope, "abort">;
  if (selected === parentOption) {
    selectedValue = parentValue;
    const sessionScope = "For this session";
    const projectScope = "For this project";
    const globalScope = "For all projects";
    const cancelScope = "Cancel";
    const parentScope = await ctx.ui.select(
      `Allow parent directory "${parentValue}"`,
      [
        sessionScope,
        ...(projectTrusted ? [projectScope] : []),
        globalScope,
        cancelScope,
      ],
      { timeout: permissionPromptTimeoutMs(timeoutSeconds) },
    );
    switch (parentScope) {
      case sessionScope:
        scope = "session";
        break;
      case projectScope:
        if (!projectTrusted) return { action: "abort", value };
        scope = "project";
        break;
      case globalScope:
        scope = "global";
        break;
      default:
        return { action: "abort", value };
    }
  } else {
    switch (selected) {
      case sessionOption:
        scope = "session";
        break;
      case projectOption:
        if (!projectTrusted) return { action: "abort", value };
        scope = "project";
        break;
      case globalOption:
        scope = "global";
        break;
      default:
        return { action: "abort", value };
    }
  }

  if (scope === "session") return { action: scope, value: selectedValue };
  const { globalPath, projectPath } = configPaths ?? getConfigPaths(ctx.cwd);
  const target = scope === "project" ? projectPath : globalPath;
  const confirmed = await ctx.ui.confirm(
    "Persist sandbox permission?",
    `Add "${selectedValue}" to ${target}?`,
    { timeout: permissionPromptTimeoutMs(timeoutSeconds) },
  );
  return { action: confirmed ? scope : "abort", value: selectedValue };
}

export function formatSandboxStatus(config: SandboxConfig): string {
  const domains = `${config.network?.allowedDomains?.length ?? 0} domains`;
  return `${domains} · ${config.filesystem?.allowWrite?.length ?? 0} write paths`;
}

function disabledReason(reason: SandboxDisabledReason): string {
  if (reason === "startup-configuration") return "startup configuration";
  if (reason === "startup-flag") return "--no-sandbox startup default";
  return "interactive command";
}

export function formatSandboxConfiguration(
  status: SandboxCoordinatorStatus,
  allowances: SessionAllowances,
): string {
  const { config, paths, state } = status;
  const stateLabel = state.kind === "enabled"
    ? "Enabled"
    : state.kind === "disabled"
      ? `Disabled (${disabledReason(state.reason)})`
      : state.kind === "failed"
        ? `Failed closed (${state.reason})`
        : "Initializing";
  const lines = [
    `Sandbox: ${stateLabel}`,
    "",
    "Root Configuration",
    `  Global:  ${paths.globalPath}`,
    `  Project: ${paths.projectPath}${status.projectConfigLoaded ? "" : " (ignored: project not trusted)"}`,
    `  Startup enabled: ${status.startupConfiguredEnabled ?? "(unavailable)"}`,
    `  Startup --no-sandbox: ${status.startupNoSandbox}`,
    `  Interactive override: ${status.interactiveOverride}`,
    `  Permission prompt timeout: ${config?.permissionPromptTimeoutSeconds ?? "(unavailable)"} seconds`,
  ];

  if (status.configurationError) {
    lines.push(
      "",
      `Configuration error: ${status.configurationError}`,
      "Fix sandbox.yaml, then reload plugins or restart OMP.",
    );
  }
  if (!config) return lines.join("\n");

  lines.push(
    "",
    "Network (bash and ! commands)",
    `  Allow: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
    `  Deny:  ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
    ...(allowances.domains.length ? [`  Session: ${allowances.domains.join(", ")}`] : []),
    "",
    "Filesystem (bash, read, write, and edit; unsafe host tools are hidden)",
    `  Deny read:   ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
    `  Allow read:  ${config.filesystem?.allowRead?.join(", ") || "(none)"}`,
    `  Allow write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
    `  Deny write:  ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
    ...(allowances.readPaths.length ? [`  Session read: ${allowances.readPaths.join(", ")}`] : []),
    ...(allowances.writePaths.length ? [`  Session write: ${allowances.writePaths.join(", ")}`] : []),
    "",
    "Read allow rules override read denies. Write denies override write allows.",
    "The root sandbox configuration files are protected from shell writes.",
  );
  return lines.join("\n");
}
