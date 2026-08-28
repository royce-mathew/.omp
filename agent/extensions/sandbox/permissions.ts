import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent"
import {
  addDomainToConfig,
  addReadPathToConfig,
  addWritePathToConfig,
  type SandboxConfig,
} from "./config.ts";
import type { PermissionScope } from "./policy.ts";
import { SandboxSession } from "./session.ts";
import { promptPermission } from "./ui.ts";

export type PermissionKind = "domain" | "read" | "write";

export class PermissionCoordinator {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly session: SandboxSession,
  ) {}

  reset(): void {
    this.queue = Promise.resolve();
  }

  async request(
    ctx: ExtensionContext,
    kind: PermissionKind,
    value: string,
    config: SandboxConfig,
  ): Promise<boolean> {
    const labels: Record<PermissionKind, string> = {
      domain: `Network blocked: "${value}" is not in allowedDomains`,
      read: `Read blocked: "${value}" is not in allowRead`,
      write: `Write blocked: "${value}" is not in allowWrite`,
    };
    this.pi.events.emit("request-attention", { message: "Sandbox permission required" });
    const choice = await promptPermission(
      ctx,
      labels[kind],
      value,
      config.permissionPromptTimeoutSeconds,
      kind !== "domain",
      this.session.processCoordinator.paths,
      this.session.processCoordinator.status().projectConfigLoaded,
    );
    if (choice.action === "abort") return false;
    await this.apply(ctx, choice.action, kind, choice.value);
    return true;
  }

  apply(
    ctx: ExtensionContext,
    scope: Exclude<PermissionScope, "abort">,
    kind: PermissionKind,
    value: string,
  ): Promise<void> {
    const task = async (): Promise<void> => {
      const next = {
        domains: [...this.session.allowances.domains],
        readPaths: [...this.session.allowances.readPaths],
        writePaths: [...this.session.allowances.writePaths],
      };
      if (scope === "session") {
        const values = kind === "domain"
          ? next.domains
          : kind === "read"
            ? next.readPaths
            : next.writePaths;
        if (!values.includes(value)) values.push(value);
      }

      const persist = scope === "session" ? undefined : async (): Promise<void> => {
        const paths = this.session.processCoordinator.paths;
        const target = scope === "project" ? paths.projectPath : paths.globalPath;
        if (kind === "domain") await addDomainToConfig(target, value);
        else if (kind === "read") await addReadPathToConfig(target, value);
        else await addWritePathToConfig(target, value);
      };
      await this.session.refresh(ctx, next, persist);
    };
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
