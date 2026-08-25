import { dirname } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent"
import { getConfigPaths, loadConfig, type SandboxConfig } from "./config.ts";
import {
  initializeSandbox,
  resetSandbox,
  resolveAllowances,
  SandboxRuntimeGate,
  supportsNodeEnvProxy,
  type EffectiveAllowances,
  type SessionAllowances,
} from "./runtime.ts";
import { formatSandboxStatus } from "./ui.ts";

type SandboxState =
  | { kind: "disabled" }
  | { kind: "initializing" }
  | { kind: "enabled" }
  | { kind: "failed"; reason: string };

const emptyAllowances = (): SessionAllowances => ({ domains: [], readPaths: [], writePaths: [] });

export class SandboxSession {
  private state: SandboxState = { kind: "disabled" };
  private configSnapshot: { cwd: string; promise: Promise<SandboxConfig> } | undefined;
  private readonly gate = new SandboxRuntimeGate();
  allowances: SessionAllowances = emptyAllowances();

  get active(): boolean {
    return this.state.kind !== "disabled";
  }

  get ready(): boolean {
    return this.state.kind === "enabled";
  }

  get failure(): string | undefined {
    return this.state.kind === "failed" ? this.state.reason : undefined;
  }

  private clear(): void {
    this.state = { kind: "disabled" };
    this.allowances = emptyAllowances();
    this.configSnapshot = undefined;
  }

  begin(): void {
    this.clear();
  }

  config(ctx: ExtensionContext): Promise<SandboxConfig> {
    if (this.configSnapshot?.cwd === ctx.cwd) return this.configSnapshot.promise;
    const promise = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    this.configSnapshot = { cwd: ctx.cwd, promise };
    promise.catch(() => {
      if (this.configSnapshot?.promise === promise) this.configSnapshot = undefined;
    });
    return promise;
  }

  reloadConfig(ctx: ExtensionContext): Promise<SandboxConfig> {
    this.configSnapshot = undefined;
    return this.config(ctx);
  }

  async effective(ctx: ExtensionContext): Promise<EffectiveAllowances> {
    return resolveAllowances(await this.config(ctx), this.allowances);
  }

  protectedWritePaths(ctx: ExtensionContext): string[] {
    const { globalPath, projectPath } = getConfigPaths(ctx.cwd);
    return [globalPath, dirname(projectPath)];
  }

  blockedMessage(): string {
    return `Sandbox unavailable; command blocked${this.failure ? `: ${this.failure}` : ""}`;
  }

  fail(ctx: ExtensionContext, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    this.state = { kind: "failed", reason };
    this.configSnapshot = undefined;
    ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("error", "sandbox unavailable · commands blocked"));
  }

  async refresh(
    ctx: ExtensionContext,
    next: SessionAllowances = this.allowances,
    persist?: () => Promise<void>,
  ): Promise<void> {
    if (!this.ready) {
      await persist?.();
      this.allowances = next;
      return;
    }
    const previous = this.allowances;
    await this.gate.transition(async () => {
      const config = await this.config(ctx);
      try {
        await resetSandbox();
        await initializeSandbox(config, ctx.cwd, next, this.protectedWritePaths(ctx));
        await persist?.();
        this.allowances = next;
      } catch (error) {
        try {
          await resetSandbox().catch(() => undefined);
          await initializeSandbox(config, ctx.cwd, previous, this.protectedWritePaths(ctx));
        } catch (rollbackError) {
          this.fail(ctx, rollbackError);
        }
        throw error;
      }
    });
  }

  async enable(ctx: ExtensionContext, quiet = false): Promise<boolean> {
    if (this.ready) {
      if (!quiet) ctx.ui.notify("Sandbox is already enabled", "info");
      return false;
    }
    if (process.platform !== "darwin" && process.platform !== "linux") {
      this.fail(ctx, `Sandbox is not supported on ${process.platform}`);
      ctx.ui.notify(`${this.blockedMessage()}. Explicitly disable sandboxing to run shell commands.`, "error");
      return false;
    }

    this.state = { kind: "initializing" };
    try {
      const config = await this.config(ctx);
      await this.gate.transition(async () => {
        await resetSandbox().catch(() => undefined);
        await initializeSandbox(config, ctx.cwd, this.allowances, this.protectedWritePaths(ctx));
      });
      this.state = { kind: "enabled" };
      if (supportsNodeEnvProxy(process.versions.node)) process.env.NODE_USE_ENV_PROXY ??= "1";
      ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", formatSandboxStatus(config)));
      return true;
    } catch (error) {
      await this.gate.transition(() => resetSandbox().catch(() => undefined));
      this.fail(ctx, error);
      ctx.ui.notify(`${this.blockedMessage()}. Explicitly disable sandboxing to run shell commands.`, "error");
      return false;
    }
  }

  async reset(ctx: ExtensionContext): Promise<void> {
    await this.gate.transition(() => resetSandbox().catch(() => undefined));
    this.clear();
    ctx.ui.setStatus("sandbox", undefined);
  }

  async disable(ctx: ExtensionContext, quiet = false): Promise<boolean> {
    if (!this.active) {
      if (!quiet) ctx.ui.notify("Sandbox is already disabled", "info");
      return false;
    }
    await this.gate.transition(() => resetSandbox().catch(() => undefined));
    this.state = { kind: "disabled" };
    this.configSnapshot = undefined;
    ctx.ui.setStatus("sandbox", undefined);
    return true;
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.gate.run(() => {
      if (!this.ready) throw new Error(this.blockedMessage());
      return operation();
    });
  }

  async shutdown(): Promise<void> {
    await this.gate.transition(() => resetSandbox().catch(() => undefined));
    this.clear();
  }
}
